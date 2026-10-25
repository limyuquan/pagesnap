/**
 * Main-thread export service (owner: B): runs exports in the export worker, caches results per
 * `planKey(doc.rev, plan)` (+ snap) and de-duplicates concurrent requests, so a prewarmed copy is
 * usually a resolved promise by the time the user presses Cmd+C (03 §4.2).
 *
 * Failure handling:
 * - The worker posts `{ t: 'ready' }` once loaded. If it can't be created, or errors before that
 *   (CSP, module load), the same queue runs on the main thread instead.
 * - If it errors after `ready` (a crash, e.g. out of memory), every pending job rejects with
 *   `ExportWorkerCrashed` and a fresh worker takes later jobs.
 * - `render(..., { timeoutMs })`: a job that hasn't settled in time rejects with a `TimeoutError`
 *   `DOMException`; the worker is assumed wedged, so it's replaced and the other pending jobs are
 *   re-sent to the new one.
 * - Settled results are cached by count and by bytes; a very large result isn't cached at all.
 */
import type { AnnotationDoc } from '@/shared/annotations';
import type { Size } from '@/shared/types';
import type { ExportResult, ExportSnap } from './exportCore';
import {
  createExportRunner,
  type ExportPriority,
  type ExportRequest,
  type ExportResponse,
} from './exportRunner';
import { type ExportPlan, planKey } from './scope';

export type { ExportResult, ExportSnap } from './exportCore';
export { EXPORT_MEMORY_ERROR } from './exportCore';
export type { ExportPriority } from './exportRunner';

export interface ExportHandle {
  promise: Promise<ExportResult>;
  /** Give up on this request. The job is only cancelled once no other caller still wants it. */
  cancel(): void;
}

export interface ExporterOptions {
  /** Run exports in a worker. Default: true when `Worker` exists (or `createWorker` is given). */
  useWorker?: boolean;
  /** Worker factory (tests). Default `createExportWorker`. Called again after a crash/timeout. */
  createWorker?: () => Worker;
  /** Settled results kept (LRU). Default 4. */
  cacheMaxEntries?: number;
  /** Total blob bytes of the settled results kept. Default 48 MB. */
  cacheMaxBytes?: number;
  /** A settled result bigger than this isn't cached (the caller already has it). Default 24 MB. */
  cacheMaxEntryBytes?: number;
}

export interface ExportRenderOptions {
  priority?: ExportPriority;
  /**
   * Reject with a `TimeoutError` `DOMException` when the job hasn't settled this many ms after
   * this call (see `exportTimeoutMs`). Applies to the shared job: every holder gets the error.
   */
  timeoutMs?: number;
}

export type ExportPlanLike = Pick<ExportPlan, 'region' | 'scale'> & {
  /** Edge snapping, source image px per edge (see `ExportJob.snap`). Part of the cache key. */
  snap?: ExportSnap | undefined;
};

/** `Error.name` of jobs that were pending when the worker crashed. */
export const EXPORT_WORKER_CRASHED = 'ExportWorkerCrashed';

const DEFAULT_KEEP_SETTLED = 4;
const MB = 2 ** 20;
const DEFAULT_CACHE_BYTES = 48 * MB;
const DEFAULT_CACHE_ENTRY_BYTES = 24 * MB;

/** Time budget for one export: 20 s + 100 ms per output megapixel, at most 120 s. */
export function exportTimeoutMs(size: Size): number {
  return Math.min(120_000, Math.ceil(20_000 + (100 * size.w * size.h) / 1e6));
}

/** The real export worker. */
export function createExportWorker(): Worker {
  return new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
}

interface Entry {
  key: string;
  id: number;
  rev: number;
  priority: ExportPriority;
  promise: Promise<ExportResult>;
  settled: boolean;
  refs: number;
  /** Blob bytes once settled. */
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** `performance.now()` deadline of `timer`. */
  deadline: number;
  /** Longest timeout any caller asked for (ms), or undefined: no watchdog. */
  limit: number | undefined;
  /** The runner reported it running. */
  started: boolean;
}

interface Pending {
  msg: Extract<ExportRequest, { t: 'job' }>;
  entry: Entry;
  resolve: (r: ExportResult) => void;
  reject: (e: unknown) => void;
}

function abortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError');
}

function timeoutError(): DOMException {
  return new DOMException('The export took too long', 'TimeoutError');
}

function crashedError(): Error {
  const err = new Error('The export worker stopped unexpectedly');
  err.name = EXPORT_WORKER_CRASHED;
  return err;
}

/** `null` when nothing would snap (so such plans share the unsnapped key). */
function normSnap(snap: ExportSnap | undefined): ExportSnap | null {
  if (!snap) return null;
  const top = Math.max(0, snap.top || 0);
  const bottom = Math.max(0, snap.bottom || 0);
  return top > 0 || bottom > 0 ? { top, bottom } : null;
}

export class Exporter {
  private worker: Worker | null = null;
  /** The current worker has posted `ready`. */
  private workerReady = false;
  private readonly createWorker: () => Worker;
  private local: ((msg: ExportRequest) => void) | null = null;
  /** Responses from older main-thread runners (replaced after a timeout) are ignored. */
  private localGen = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Map order is LRU order (oldest first). */
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;

  constructor(opts: ExporterOptions = {}) {
    this.createWorker = opts.createWorker ?? createExportWorker;
    this.maxEntries = opts.cacheMaxEntries ?? DEFAULT_KEEP_SETTLED;
    this.maxBytes = opts.cacheMaxBytes ?? DEFAULT_CACHE_BYTES;
    this.maxEntryBytes = opts.cacheMaxEntryBytes ?? DEFAULT_CACHE_ENTRY_BYTES;
    const useWorker = opts.useWorker ?? (!!opts.createWorker || typeof Worker !== 'undefined');
    if (useWorker) this.spawn();
  }

  /** Where jobs run now. */
  get mode(): 'worker' | 'main' {
    return this.worker ? 'worker' : 'main';
  }

  /** Start (or reuse a cached/in-flight) render. key = `planKey(doc.rev, plan)` (+ snap). */
  render(doc: AnnotationDoc, plan: ExportPlanLike, opts: ExportRenderOptions = {}): ExportHandle {
    if (this.disposed) throw new Error('Exporter disposed');
    const priority = opts.priority ?? 'low';
    const key = this.keyOf(doc, plan);
    let entry = this.entries.get(key);
    if (entry) {
      entry.refs++;
      this.touch(entry);
      if (priority === 'high' && entry.priority === 'low' && !entry.settled) {
        entry.priority = 'high';
        const p = this.pending.get(entry.id);
        if (p) p.msg.priority = 'high';
        this.send({ t: 'priority', id: entry.id, priority: 'high' });
      }
    } else {
      entry = this.start(key, doc, plan, priority);
    }
    if (opts.timeoutMs !== undefined && !entry.settled) {
      // The clock runs while the job runs (or while nothing else is running ahead of it), so a
      // copy queued behind a long download can't time out and restart the worker under it.
      entry.limit = Math.max(entry.limit ?? 0, opts.timeoutMs);
      if (entry.started || !this.busy(entry)) this.arm(entry, opts.timeoutMs);
    }
    const e = entry;
    let released = false;
    return {
      promise: e.promise,
      cancel: () => {
        if (released) return;
        released = true;
        e.refs--;
        if (e.refs <= 0 && !e.settled) this.abort(e);
      },
    };
  }

  /** Cached or in-flight result for this key, or null. */
  peek(doc: AnnotationDoc, plan: ExportPlanLike): Promise<ExportResult> | null {
    const entry = this.entries.get(this.keyOf(doc, plan));
    if (!entry) return null;
    this.touch(entry);
    return entry.promise;
  }

  /** Cancel every in-flight low-priority job whose doc rev is < `rev` (stale prewarms). */
  cancelStale(rev: number): void {
    for (const e of [...this.entries.values()]) {
      if (!e.settled && e.priority === 'low' && e.rev < rev) this.abort(e);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of [...this.entries.values()]) if (!e.settled) this.abort(e);
    for (const p of [...this.pending.values()]) this.fail(p.msg.id, abortError());
    this.entries.clear();
    this.killWorker();
    this.localGen++;
    this.local = null;
  }

  // ----------------------------------------------------------------------------- internals

  private keyOf(doc: AnnotationDoc, plan: ExportPlanLike): string {
    // `planKey` appends `|s<top>,<bottom>` when there's a snap; a zero snap keys as none.
    const snap = normSnap(plan.snap);
    const keyed = { region: plan.region, scale: plan.scale, ...(snap && { snap }) };
    return `${doc.sessionId}|${planKey(doc.rev, keyed)}`;
  }

  private touch(entry: Entry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private start(
    key: string,
    doc: AnnotationDoc,
    plan: ExportPlanLike,
    priority: ExportPriority,
  ): Entry {
    const id = this.nextId++;
    const snap = normSnap(plan.snap);
    const msg: Pending['msg'] = {
      t: 'job',
      id,
      job: {
        sessionId: doc.sessionId,
        doc,
        region: { ...plan.region },
        scale: plan.scale,
        ...(snap && { snap }),
      },
      priority,
    };
    let resolve!: Pending['resolve'];
    let reject!: Pending['reject'];
    const promise = new Promise<ExportResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry = {
      key,
      id,
      rev: doc.rev,
      priority,
      promise,
      settled: false,
      refs: 1,
      bytes: 0,
      timer: null,
      deadline: Number.POSITIVE_INFINITY,
      limit: undefined,
      started: false,
    };
    this.pending.set(id, { msg, entry, resolve, reject });
    this.entries.set(key, entry);
    promise.then(
      (result) => {
        this.disarm(entry);
        entry.settled = true;
        entry.bytes = result.blob.size;
        if (entry.bytes > this.maxEntryBytes) this.forget(entry);
        else this.evict();
      },
      () => {
        // Cancelled, timed out or failed: never serve it from the cache.
        this.disarm(entry);
        this.forget(entry);
      },
    );
    this.send(msg);
    return entry;
  }

  private forget(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  /** Reject pending job `id` (and drop its cache entry right away). */
  private fail(id: number, err: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.forget(p.entry);
    p.reject(err);
  }

  private abort(entry: Entry): void {
    this.forget(entry);
    if (!this.pending.has(entry.id)) return;
    this.send({ t: 'cancel', id: entry.id });
    this.fail(entry.id, abortError());
  }

  private arm(entry: Entry, ms: number): void {
    if (entry.settled || !this.pending.has(entry.id) || !(ms >= 0)) return;
    const at = performance.now() + ms;
    if (entry.timer !== null && entry.deadline <= at) return;
    this.disarm(entry);
    entry.deadline = at;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.timeOut(entry);
    }, ms);
  }

  private disarm(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.deadline = Number.POSITIVE_INFINITY;
  }

  private timeOut(entry: Entry): void {
    if (this.disposed || !this.pending.has(entry.id)) return;
    this.send({ t: 'cancel', id: entry.id });
    this.fail(entry.id, timeoutError());
    // A job that never finishes usually means a wedged worker (OOM, hung IDB): replace it.
    this.restart();
  }

  private evict(): void {
    let count = 0;
    let bytes = 0;
    for (const e of this.entries.values()) {
      if (!e.settled) continue;
      count++;
      bytes += e.bytes;
    }
    for (const e of [...this.entries.values()]) {
      if (count <= this.maxEntries && bytes <= this.maxBytes) break;
      if (!e.settled) continue;
      this.entries.delete(e.key);
      count--;
      bytes -= e.bytes;
    }
  }

  private send(msg: ExportRequest): void {
    if (this.worker) {
      this.worker.postMessage(msg);
      return;
    }
    if (!this.local) {
      const gen = ++this.localGen;
      this.local = createExportRunner((r) => {
        if (gen === this.localGen) this.onResponse(r);
      });
    }
    this.local(msg);
  }

  /** Is another pending job ahead of `entry` (started, or submitted earlier)? */
  private busy(entry: Entry): boolean {
    for (const p of this.pending.values()) {
      if (p.entry !== entry && (p.entry.started || p.msg.id < entry.id)) return true;
    }
    return false;
  }

  /**
   * Watchdog bookkeeping: the job that just started gets its full timeout from now; queued jobs
   * wait on a worker that is demonstrably alive, so their clocks stop until they start. When a
   * job finishes, the next ones are timed again (in case the runner never picks them up).
   */
  private onProgress(started: number | null): void {
    for (const p of this.pending.values()) {
      const e = p.entry;
      if (e.limit === undefined) continue;
      if (p.msg.id === started) {
        e.started = true;
        this.disarm(e);
        this.arm(e, e.limit);
      } else if (!e.started) {
        this.disarm(e);
        if (started === null) this.arm(e, e.limit);
      }
    }
  }

  private onResponse(msg: ExportResponse): void {
    if (msg.t === 'ready') return;
    if (msg.t === 'start') {
      this.onProgress(msg.id);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // cancelled locally already
    this.pending.delete(msg.id);
    this.onProgress(null);
    if (msg.t === 'done') {
      p.resolve(msg.result);
    } else if (msg.name === 'AbortError') {
      p.reject(new DOMException(msg.message || 'Export cancelled', 'AbortError'));
    } else {
      const err = new Error(msg.message);
      err.name = msg.name;
      p.reject(err);
    }
  }

  /** Pending jobs in submission order. */
  private owed(): Pending[] {
    return [...this.pending.values()].sort((a, b) => a.msg.id - b.msg.id);
  }

  private spawn(): void {
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch {
      this.worker = null;
      return;
    }
    this.worker = worker;
    this.workerReady = false;
    worker.onmessage = (ev: MessageEvent<ExportResponse>) => {
      if (this.worker !== worker) return;
      if (ev.data.t === 'ready') this.workerReady = true;
      else this.onResponse(ev.data);
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      if (this.worker === worker) this.onWorkerFailure();
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.onWorkerFailure();
    };
  }

  private killWorker(): void {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    this.workerReady = false;
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }

  private onWorkerFailure(): void {
    if (!this.workerReady) {
      // Startup failure (CSP, module load): finish everything on the main thread.
      this.fallBack();
      return;
    }
    // A crash after startup (e.g. out of memory): re-running the same jobs on the main thread
    // would likely take the page down too, so report them and start over for later jobs.
    this.killWorker();
    for (const p of this.owed()) this.fail(p.msg.id, crashedError());
    if (!this.disposed) this.spawn();
  }

  private fallBack(): void {
    if (!this.worker) return;
    this.killWorker();
    // Re-run whatever the worker still owed us, in submission order.
    for (const p of this.owed()) {
      p.entry.started = false;
      this.send(p.msg);
    }
  }

  /** Replace the worker (or main-thread runner) and re-send the jobs still pending. */
  private restart(): void {
    if (this.worker) {
      this.killWorker();
      this.spawn();
    } else if (this.local) {
      const old = this.local;
      this.localGen++; // silence the old runner
      this.local = null;
      for (const p of this.owed()) old({ t: 'cancel', id: p.msg.id });
    }
    for (const p of this.owed()) {
      p.entry.started = false;
      this.send(p.msg);
    }
  }
}
