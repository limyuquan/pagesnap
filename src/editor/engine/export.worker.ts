/**
 * Export worker (owner: B). A module worker started by `Exporter`
 * (`new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })`).
 *
 * In:  `{ t: 'job', id, job, priority? }`, `{ t: 'cancel', id }`, `{ t: 'priority', id, priority }`.
 * Out: `{ t: 'done', id, result }` or `{ t: 'error', id, name, message }` (`AbortError` when
 * cancelled). Jobs run serially; see `exportRunner.ts`. Sessions and slices come from IndexedDB.
 */
import { createExportRunner, type ExportRequest, type ExportResponse } from './exportRunner';

/** The bits of `DedicatedWorkerGlobalScope` we use (the project's lib is DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<ExportRequest>) => void) | null;
  postMessage(msg: ExportResponse): void;
}

const scope = self as unknown as WorkerScope;
const handle = createExportRunner((msg) => scope.postMessage(msg));
scope.onmessage = (ev) => handle(ev.data);
