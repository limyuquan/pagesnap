/**
 * Session metadata for the chrome: title, URL, size, status, warnings. The engine store only sets
 * `session` once the capture is final, but the chrome wants the title while a capture is still
 * running, and needs to show capture errors even if the engine is still starting up. So the UI
 * reads the record itself (read-only, through the shared db/handoff helpers) and prefers the
 * store's copy whenever it has one.
 */
import { useEffect, useState } from 'react';
import { useEditorStore } from '@/editor/engine';
import { getSession } from '@/shared/db';
import { watchSessionStatus } from '@/shared/handoff';
import type { CaptureSession, SessionId } from '@/shared/types';

export type SessionMeta = Pick<
  CaptureSession,
  'id' | 'title' | 'url' | 'status' | 'error' | 'warnings' | 'css' | 'mode' | 'progress'
>;

/** `undefined` while unknown, `null` if there's no such session. */
export function useSessionMeta(sessionId: SessionId | null): SessionMeta | null | undefined {
  const fromStore = useEditorStore((s) => s.session);
  const [local, setLocal] = useState<SessionMeta | null | undefined>(undefined);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    let lastStatus: string | null = null;
    const refresh = () =>
      getSession(sessionId).then(
        (s) => alive && setLocal(s ?? null),
        () => alive && setLocal(null),
      );
    const stop = watchSessionStatus(sessionId, (snap) => {
      if (!alive) return;
      if (!snap) {
        setLocal(null);
        return;
      }
      if (snap.status !== lastStatus) {
        lastStatus = snap.status;
        void refresh();
      } else {
        setLocal((prev) => (prev ? { ...prev, progress: snap.progress } : prev));
      }
    });
    return () => {
      alive = false;
      stop();
    };
  }, [sessionId]);

  return fromStore ?? local;
}
