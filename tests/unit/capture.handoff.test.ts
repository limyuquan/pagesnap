/**
 * The SW → editor hand-off never leaves the editor waiting forever (review correctness #6):
 * storage errors reject, a dead capture's stale mirror asks the SW to recover it, a failed final
 * write still produces an error session, and a removed mirror falls back to IndexedDB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSession, putSession } from '@/shared/db';
import {
  isStaleSnapshot,
  publishSessionStatus,
  snapshotOf,
  waitForFinalSession,
  watchSessionStatus,
} from '@/shared/handoff';
import { STALE_CAPTURE_MS, sessionStatusKey } from '@/shared/protocol';
import type { CaptureSession } from '@/shared/types';

const session = (extra: Partial<CaptureSession> = {}): CaptureSession => ({
  v: 1,
  id: 's1',
  url: 'http://localhost/x.html',
  title: 'x',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  mode: 'full',
  status: 'capturing',
  error: null,
  warnings: [],
  progress: { done: 1, total: 3 },
  viewport: { w: 100, h: 100 },
  dpr: 1,
  css: { w: 100, h: 300 },
  image: { w: 100, h: 300 },
  slices: [],
  layout: { size: { w: 100, h: 300 }, background: '#fff', fills: [], parts: [] },
  ...extra,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hand-off robustness', () => {
  it('rejects instead of hanging when session storage fails', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValue(new Error('storage broke'));
    await expect(waitForFinalSession('s1')).rejects.toThrow('storage broke');
  });

  it('reports storage errors to onError, not as a missing session', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValue(new Error('nope'));
    const cb = vi.fn();
    const err = await new Promise((resolve) => watchSessionStatus('s1', cb, resolve));
    expect(String(err)).toContain('nope');
    expect(cb).not.toHaveBeenCalled();
  });

  it('flags snapshots whose heartbeat stopped', () => {
    const now = Date.now();
    const snap = snapshotOf(session({ updatedAt: now - STALE_CAPTURE_MS - 1 }));
    expect(isStaleSnapshot(snap, now)).toBe(true);
    expect(isStaleSnapshot({ ...snap, updatedAt: now }, now)).toBe(false);
    expect(isStaleSnapshot({ ...snap, status: 'ready' }, now)).toBe(false);
  });

  it('asks the SW to recover a stale capture, then resolves with the recovered session', async () => {
    const stale = session({ updatedAt: Date.now() - STALE_CAPTURE_MS - 5000 });
    await putSession(stale);
    await publishSessionStatus(stale);
    const send = vi
      .spyOn(fakeBrowser.runtime, 'sendMessage')
      .mockImplementation(async (msg: unknown) => {
        // What the SW's recovery does: mark it and publish.
        const recovered = session({
          status: 'error',
          error: {
            code: 'INTERRUPTED',
            message: 'The capture was interrupted before it finished.',
          },
        });
        await putSession(recovered);
        await publishSessionStatus(recovered);
        return msg;
      });
    const s = await waitForFinalSession('s1');
    expect(send).toHaveBeenCalledWith({ t: 'pagesnap/recover', id: 's1' });
    expect(s.error?.code).toBe('INTERRUPTED');
  });

  it('resolves with an error session when the final IDB write failed', async () => {
    await putSession(session()); // IDB still says `capturing`
    const failed = session({
      status: 'error',
      error: { code: 'STORAGE_FAILED', message: 'The capture couldn’t be saved.' },
    });
    await publishSessionStatus(failed); // only the mirror got the verdict
    const s = await waitForFinalSession('s1');
    expect(s.status).toBe('error');
    expect(s.error?.code).toBe('STORAGE_FAILED');
  });

  it('resolves even when the very first IDB write failed (no record at all)', async () => {
    await publishSessionStatus(
      session({ status: 'error', error: { code: 'STORAGE_FAILED', message: 'disk full' } }),
    );
    const s = await waitForFinalSession('s1');
    expect(s.status).toBe('error');
    expect(s.error?.message).toBe('disk full');
    expect(await getSession('s1')).toBeUndefined();
  });

  it('falls back to IDB when the mirror is removed (retention), instead of "no session"', async () => {
    await putSession(session({ status: 'ready' }));
    await publishSessionStatus(session({ status: 'ready' }));
    const seen: (string | null)[] = [];
    const stop = watchSessionStatus('s1', (snap) => seen.push(snap?.status ?? null));
    await vi.waitFor(() => expect(seen).toEqual(['ready']));
    await fakeBrowser.storage.session.remove(sessionStatusKey('s1'));
    await vi.waitFor(() => expect(seen).toEqual(['ready', 'ready']));
    stop();
  });
});
