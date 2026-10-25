/**
 * The export job queue (owner: B), shared by the export worker and the exporter's main-thread
 * fallback so both behave the same. Worker-safe: no DOM, no `browser`.
 *
 * - Jobs run one at a time (an export can hold hundreds of MB).
 * - `high` jobs (a user copy) jump ahead of queued `low` ones (prewarms).
 * - Cancelling a queued job drops it without running; a running job aborts at its next
 *   checkpoint. Either way the job answers with an `AbortError`.
 */
import { getSession, getSliceBlob } from '@/shared/db';
import type { CaptureSession, SessionId } from '@/shared/types';
import { type ExportJob, type ExportResult, renderExport } from './exportCore';

export type ExportPriority = 'high' | 'low';

export type ExportRequest =
  | { t: 'job'; id: number; job: ExportJob; priority?: ExportPriority }
  | { t: 'cancel'; id: number }
  | { t: 'priority'; id: number; priority: ExportPriority };

export type ExportResponse =
  /** Posted once by the worker when its script has loaded (never by the main-thread runner). */
  | { t: 'ready' }
  /** A job left the queue and is running now (its timeout counts from here). */
  | { t: 'start'; id: number }
  | { t: 'done'; id: number; result: ExportResult }
  | { t: 'error'; id: number; name: string; message: string };

export interface ExportRunnerDeps {
  getSession: (id: SessionId) => Promise<CaptureSession | undefined>;
  getSliceBlob: (id: SessionId, index: number) => Promise<Blob>;
}

const dbDeps: ExportRunnerDeps = { getSession, getSliceBlob };

interface Queued {
  id: number;
  job: ExportJob;
  priority: ExportPriority;
}

/** Returns the message handler. Responses go to `post`, possibly synchronously. */
export function createExportRunner(
  post: (msg: ExportResponse) => void,
  deps: ExportRunnerDeps = dbDeps,
): (msg: ExportRequest) => void {
  const queue: Queued[] = [];
  let running: { id: number; ac: AbortController } | null = null;
  // Sessions are final (ready/partial) by the time anyone exports, so they can be cached.
  const sessions = new Map<SessionId, Promise<CaptureSession>>();

  const loadSession = (id: SessionId): Promise<CaptureSession> => {
    let p = sessions.get(id);
    if (!p) {
      p = deps.getSession(id).then((s) => {
        if (!s) throw new Error(`Session ${id} not found`);
        return s;
      });
      sessions.set(id, p);
      p.catch(() => sessions.delete(id));
    }
    return p;
  };

  const enqueue = (q: Queued) => {
    const at = q.priority === 'high' ? queue.findIndex((x) => x.priority === 'low') : -1;
    if (at < 0) queue.push(q);
    else queue.splice(at, 0, q);
  };

  const run = async (q: Queued, signal: AbortSignal) => {
    try {
      const sid = q.job.sessionId;
      const session = await loadSession(sid);
      signal.throwIfAborted();
      const result = await renderExport(q.job, {
        session,
        // Abort between slices too, so a cancelled prewarm frees the worker quickly.
        loadSlice: (i) => {
          signal.throwIfAborted();
          return deps.getSliceBlob(sid, i);
        },
        signal,
      });
      signal.throwIfAborted();
      post({ t: 'done', id: q.id, result });
    } catch (err) {
      post(errorResponse(q.id, err));
    }
  };

  const pump = () => {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    const ac = new AbortController();
    running = { id: next.id, ac };
    post({ t: 'start', id: next.id });
    void run(next, ac.signal).finally(() => {
      running = null;
      pump();
    });
  };

  return (msg) => {
    switch (msg.t) {
      case 'job':
        enqueue({ id: msg.id, job: msg.job, priority: msg.priority ?? 'low' });
        pump();
        break;
      case 'cancel': {
        if (running?.id === msg.id) {
          running.ac.abort(new DOMException('Export cancelled', 'AbortError'));
          break;
        }
        const at = queue.findIndex((x) => x.id === msg.id);
        if (at >= 0) {
          queue.splice(at, 1);
          post({ t: 'error', id: msg.id, name: 'AbortError', message: 'Export cancelled' });
        }
        break;
      }
      case 'priority': {
        const at = queue.findIndex((x) => x.id === msg.id);
        const q = at >= 0 ? queue[at] : undefined;
        if (q && q.priority !== msg.priority) {
          queue.splice(at, 1);
          enqueue({ ...q, priority: msg.priority });
        }
        break;
      }
    }
  };
}

function errorResponse(id: number, err: unknown): ExportResponse {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const e = err as { name: unknown; message?: unknown };
    return { t: 'error', id, name: String(e.name), message: String(e.message ?? '') };
  }
  return { t: 'error', id, name: 'Error', message: String(err) };
}
