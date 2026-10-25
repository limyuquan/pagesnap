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
import { EDITOR_PATH, sessionStatusKey } from './protocol';
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
 * Editor side: call `cb` with the current status and on every change. The IDB record is used as
 * the initial value when the mirror is missing (e.g. after a browser restart cleared session
 * storage). Returns an unsubscribe function.
 */
export function watchSessionStatus(
  id: SessionId,
  cb: (snapshot: SessionStatusSnapshot | null) => void,
): () => void {
  const key = sessionStatusKey(id);
  let active = true;
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (!active || area !== 'session' || !(key in changes)) return;
    cb((changes[key]?.newValue as SessionStatusSnapshot | undefined) ?? null);
  };
  browser.storage.onChanged.addListener(onChanged);
  void (async () => {
    const stored = (await browser.storage.session.get(key))[key] as
      | SessionStatusSnapshot
      | undefined;
    if (!active) return;
    if (stored) return cb(stored);
    const session = await getSession(id);
    if (active) cb(session ? snapshotOf(session) : null);
  })();
  return () => {
    active = false;
    browser.storage.onChanged.removeListener(onChanged);
  };
}

/**
 * Editor side: resolve with the IDB session once its status is final. Rejects with
 * `Error('NO_SESSION')` if the session doesn't exist, or with an `AbortError` on `signal`.
 */
export function waitForFinalSession(
  id: SessionId,
  opts: { signal?: AbortSignal; onProgress?: (s: SessionStatusSnapshot) => void } = {},
): Promise<CaptureSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      fn();
    };
    const abort = () =>
      finish(() => reject(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError')));
    if (opts.signal?.aborted) return abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = watchSessionStatus(id, (snap) => {
      if (!snap) return finish(() => reject(new Error('NO_SESSION')));
      opts.onProgress?.(snap);
      if (snap.status === 'capturing') return;
      void getSession(id).then(
        (session) => finish(() => (session ? resolve(session) : reject(new Error('NO_SESSION')))),
        (err: unknown) => finish(() => reject(err)),
      );
    });
  });
}
