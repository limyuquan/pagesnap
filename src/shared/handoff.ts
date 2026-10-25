/**
 * SW → editor hand-off.
 *
 * 1. The SW (A) creates the session in IDB (status `capturing`) and mirrors its status to
 *    `chrome.storage.session` with `publishSessionStatus` after every slice and on completion.
 * 2. When the session reaches a final status the SW opens `editorUrl(id)` in a new tab next to the
 *    captured one (after the capture, since a new foreground tab would change what
 *    `captureVisibleTab` sees).
 * 3. The editor (B) reads the id with `parseEditorHash(location.hash)` and calls
 *    `waitForFinalSession(id)`, which resolves immediately for finished sessions and otherwise
 *    follows the status mirror (and `onProgress`) until the capture ends.
 *
 * Uses `browser` from `wxt/browser`, so import it from the SW and extension pages only (not workers).
 */
import { browser } from 'wxt/browser';
import { getSession } from './db';
import { EDITOR_PATH, type RecoverRequest, STALE_CAPTURE_MS, sessionStatusKey } from './protocol';
import type { CaptureError, CaptureSession, SessionId, SessionStatus } from './types';

/** Live status mirror stored in `chrome.storage.session` under `sessionStatusKey(id)`. */
export interface SessionStatusSnapshot {
  id: SessionId;
  status: SessionStatus;
  progress: { done: number; total: number };
  error: CaptureError | null;
  updatedAt: number;
}

export function snapshotOf(session: CaptureSession): SessionStatusSnapshot {
  return {
    id: session.id,
    status: session.status,
    progress: session.progress,
    error: session.error,
    updatedAt: session.updatedAt,
  };
}

/** Absolute editor URL for a session: `chrome-extension://<id>/editor.html#s=<sessionId>`. */
export function editorUrl(sessionId: SessionId): string {
  return `${browser.runtime.getURL(EDITOR_PATH)}#s=${encodeURIComponent(sessionId)}`;
}

/** Session id from an editor `location.hash` (`#s=<id>`), or `null`. */
export function parseEditorHash(hash: string): SessionId | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const id = params.get('s');
  return id ? id : null;
}

/** SW side: mirror the session status for watchers. Call after every session write. */
export async function publishSessionStatus(session: CaptureSession): Promise<void> {
  await browser.storage.session.set({ [sessionStatusKey(session.id)]: snapshotOf(session) });
}

/** SW side: drop the mirror (e.g. when a session is deleted). */
export async function clearSessionStatus(id: SessionId): Promise<void> {
  await browser.storage.session.remove(sessionStatusKey(id));
}

/**
 * A `capturing` snapshot that hasn't been refreshed for `STALE_CAPTURE_MS`: the SW that ran the
 * capture is gone (it refreshes `updatedAt` every few seconds while it runs).
 */
export function isStaleSnapshot(snap: SessionStatusSnapshot, now = Date.now()): boolean {
  return snap.status === 'capturing' && now - snap.updatedAt > STALE_CAPTURE_MS;
}

/**
 * Editor side: call `cb` with the current status and on every change. The IDB record is used as
 * the initial value when the mirror is missing (e.g. after a browser restart cleared session
 * storage) and when the mirror is removed later (retention drops mirrors of finished sessions).
 * Storage errors go to `onError` (or the console); `cb` is not called for them. Returns an
 * unsubscribe function.
 */
export function watchSessionStatus(
  id: SessionId,
  cb: (snapshot: SessionStatusSnapshot | null) => void,
  onError?: (err: unknown) => void,
): () => void {
  const key = sessionStatusKey(id);
  let active = true;
  const fail = (err: unknown) => {
    if (!active) return;
    if (onError) onError(err);
    else console.warn('[pagesnap] session status unavailable', err);
  };
  const fromDb = async () => {
    const session = await getSession(id);
    if (active) cb(session ? snapshotOf(session) : null);
  };
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (!active || area !== 'session' || !(key in changes)) return;
    const next = changes[key]?.newValue as SessionStatusSnapshot | undefined;
    if (next) cb(next);
    else fromDb().catch(fail);
  };
  browser.storage.onChanged.addListener(onChanged);
  (async () => {
    const stored = (await browser.storage.session.get(key))[key] as
      | SessionStatusSnapshot
      | undefined;
    if (!active) return;
    if (stored) return cb(stored);
    await fromDb();
  })().catch(fail);
  return () => {
    active = false;
    browser.storage.onChanged.removeListener(onChanged);
  };
}

/** Ask the SW to recover a stale capture. Sending a message also wakes a terminated SW. */
async function requestRecovery(id: SessionId): Promise<void> {
  try {
    await browser.runtime.sendMessage({ t: 'pagesnap/recover', id } satisfies RecoverRequest);
  } catch {
    // No listener yet (SW starting): its start-up recovery runs anyway.
  }
}

/**
 * Editor side: resolve with the IDB session once its status is final. Rejects with
 * `Error('NO_SESSION')` if the session doesn't exist, with the storage error if session storage or
 * IDB can't be read, or with an `AbortError` on `signal`.
 *
 * Never hangs:
 * - a `capturing` session whose heartbeat stopped (`isStaleSnapshot`) wakes the SW, which marks it
 *   `INTERRUPTED` (partial with what was stored, or error);
 * - if the mirror says the capture ended but the final IDB write failed (disk full), it resolves
 *   with an `error` session carrying the mirror's error.
 */
export function waitForFinalSession(
  id: SessionId,
  opts: { signal?: AbortSignal; onProgress?: (s: SessionStatusSnapshot) => void } = {},
): Promise<CaptureSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveries = 0;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(staleTimer);
      unsubscribe();
      fn();
    };
    const abort = () =>
      finish(() => reject(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError')));
    if (opts.signal?.aborted) return abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const watchStale = (snap: SessionStatusSnapshot) => {
      clearTimeout(staleTimer);
      // Check again just after the snapshot would turn stale; every new snapshot re-arms this.
      const due = Math.max(0, snap.updatedAt + STALE_CAPTURE_MS + 250 - Date.now());
      staleTimer = setTimeout(() => {
        if (settled) return;
        if (recoveries >= 3) {
          // The SW never answered: give the editor a readable error instead of waiting forever.
          return finish(() => reject(new Error('The capture was interrupted before it finished.')));
        }
        recoveries++;
        void requestRecovery(id);
        // If nothing changes, ask again a little later (the SW may have been mid-start).
        watchStale({ ...snap, updatedAt: Date.now() - STALE_CAPTURE_MS + 3000 });
      }, due);
    };
    unsubscribe = watchSessionStatus(
      id,
      (snap) => {
        if (!snap) return finish(() => reject(new Error('NO_SESSION')));
        opts.onProgress?.(snap);
        if (snap.status === 'capturing') return watchStale(snap);
        clearTimeout(staleTimer);
        void getSession(id).then(
          (session) =>
            finish(() => {
              if (session && session.status !== 'capturing') return resolve(session);
              // The final IDB write didn't land (disk full?): trust the mirror's verdict.
              if (session || snap.status === 'error')
                return resolve(failedSession(id, snap, session));
              reject(new Error('NO_SESSION'));
            }),
          (err: unknown) => finish(() => reject(err)),
        );
      },
      (err) => finish(() => reject(err)),
    );
  });
}

/** An `error` session for a capture whose final write failed, from the mirror (and IDB if any). */
function failedSession(
  id: SessionId,
  snap: SessionStatusSnapshot,
  stored: CaptureSession | undefined,
): CaptureSession {
  const error = (snap.status === 'error' && snap.error) || {
    code: 'STORAGE_FAILED' as const,
    message: 'The capture couldn’t be saved. Your disk may be full.',
  };
  const empty = { w: 0, h: 0 };
  const base: CaptureSession = stored ?? {
    v: 1,
    id,
    url: '',
    title: '',
    createdAt: snap.updatedAt,
    updatedAt: snap.updatedAt,
    mode: 'full',
    status: 'error',
    error,
    warnings: [],
    progress: snap.progress,
    viewport: empty,
    dpr: 1,
    css: empty,
    image: empty,
    slices: [],
    layout: { size: empty, background: '#ffffff', fills: [], parts: [] },
  };
  return { ...base, status: 'error', error, updatedAt: snap.updatedAt };
}
