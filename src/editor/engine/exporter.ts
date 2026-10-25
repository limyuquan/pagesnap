/**
 * Main-thread export service (owner: B): runs exports in the export worker, caches results per
 * `planKey(doc.rev, plan)` and de-duplicates concurrent requests, so a prewarmed copy is usually a
 * resolved promise by the time the user presses Cmd+C (03 §4.2).
 *
 * If the worker can't be created or fails to start, the same queue runs on the main thread.
 */
import type { AnnotationDoc } from '@/shared/annotations';
import type { ExportResult } from './exportCore';
import {
  createExportRunner,
  type ExportPriority,
  type ExportRequest,
  type ExportResponse,
} from './exportRunner';
import { type ExportPlan, planKey } from './scope';

export type { ExportResult } from './exportCore';
export type { ExportPriority } from './exportRunner';

export interface ExportHandle {
  promise: Promise<ExportResult>;
  /** Give up on this request. The job is only cancelled once no other caller still wants it. */
  cancel(): void;
}

export interface ExporterOptions {
  /** Run exports in a worker. Default: true when `Worker` exists. */
  useWorker?: boolean;
}

export type ExportPlanLike = Pick<ExportPlan, 'region' | 'scale'>;

/** Settled results kept (LRU). In-flight entries are never evicted. */
const KEEP_SETTLED = 4;

interface Entry {
  key: string;
  id: number;
  rev: number;
  priority: ExportPriority;
  promise: Promise<ExportResult>;
  settled: boolean;
  refs: number;
}

interface Pending {
  msg: Extract<ExportRequest, { t: 'job' }>;
  resolve: (r: ExportResult) => void;
  reject: (e: unknown) => void;
}

function abortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError');
}

export class Exporter {
  private worker: Worker | null = null;
  private local: ((msg: ExportRequest) => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Map order is LRU order (oldest first). */
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(opts: ExporterOptions = {}) {
    const useWorker = opts.useWorker ?? typeof Worker !== 'undefined';
    if (!useWorker) return;
    try {
      const worker = new Worker(new URL('./export.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (ev: MessageEvent<ExportResponse>) => this.onResponse(ev.data);
      worker.onerror = (ev) => {
        // Startup failure (or an uncaught error): finish everything on the main thread.
        ev.preventDefault();
        this.fallBack();
      };
      worker.onmessageerror = () => this.fallBack();
      this.worker = worker;
    } catch {
      this.worker = null;
    }
  }

  /** Where jobs run now. */
  get mode(): 'worker' | 'main' {
    return this.worker ? 'worker' : 'main';
  }

  /** Start (or reuse a cached/in-flight) render. key = `planKey(doc.rev, plan)`. */
  render(
    doc: AnnotationDoc,
    plan: ExportPlanLike,
    opts: { priority?: ExportPriority } = {},
  ): ExportHandle {
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
    this.entries.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  // ----------------------------------------------------------------------------- internals

  private keyOf(doc: AnnotationDoc, plan: ExportPlanLike): string {
    return `${doc.sessionId}|${planKey(doc.rev, plan)}`;
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
    const msg: Pending['msg'] = {
      t: 'job',
      id,
      job: {
        sessionId: doc.sessionId,
        doc,
        region: { ...plan.region },
        scale: plan.scale,
      },
      priority,
    };
    const promise = new Promise<ExportResult>((resolve, reject) => {
      this.pending.set(id, { msg, resolve, reject });
    });
    const entry: Entry = { key, id, rev: doc.rev, priority, promise, settled: false, refs: 1 };
    this.entries.set(key, entry);
    promise.then(
      () => {
        entry.settled = true;
        this.evict();
      },
      () => {
        // Cancelled or failed: never serve it from the cache.
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.send(msg);
    return entry;
  }

  private abort(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const p = this.pending.get(entry.id);
    if (!p) return;
    this.pending.delete(entry.id);
    this.send({ t: 'cancel', id: entry.id });
    p.reject(abortError());
  }

  private evict(): void {
    let settled = 0;
    for (const e of this.entries.values()) if (e.settled) settled++;
    for (const e of [...this.entries.values()]) {
      if (settled <= KEEP_SETTLED) break;
      if (!e.settled) continue;
      this.entries.delete(e.key);
      settled--;
    }
  }

  private send(msg: ExportRequest): void {
    if (this.worker) {
      this.worker.postMessage(msg);
      return;
    }
    this.local ??= createExportRunner((r) => this.onResponse(r));
    this.local(msg);
  }

  private onResponse(msg: ExportResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return; // cancelled locally already
    this.pending.delete(msg.id);
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

  private fallBack(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    // Re-run whatever the worker still owed us, in submission order.
    const owed = [...this.pending.values()].sort((a, b) => a.msg.id - b.msg.id);
    for (const p of owed) this.send(p.msg);
  }
}
