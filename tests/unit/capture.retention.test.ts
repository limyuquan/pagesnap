import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MIRROR_TTL_MS,
  RETENTION_AT_KEY,
  runRetention,
  STARTUP_THROTTLE_MS,
} from '@/capture/retention';
import { emptyDoc } from '@/shared/annotations';
import {
  closeDb,
  countSlices,
  deleteAllSessions,
  getDoc,
  getSession,
  getStorageUsage,
  listSessions,
  openDb,
  pruneSessions,
  putDoc,
  putSession,
  putSlice,
  RETENTION,
  retentionBudget,
} from '@/shared/db';
import { ACTIVE_CAPTURE_KEY, sessionStatusKey, timingsKey } from '@/shared/protocol';
import type { CaptureSession, SessionStatus } from '@/shared/types';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function session(
  id: string,
  createdAt: number,
  extra: Partial<Pick<CaptureSession, 'status' | 'updatedAt' | 'bytes'>> = {},
): CaptureSession {
  const size = { w: 10, h: 10 };
  const status: SessionStatus = extra.status ?? 'ready';
  return {
    v: 1,
    id,
    url: 'http://localhost/x.html',
    title: id,
    createdAt,
    updatedAt: extra.updatedAt ?? createdAt,
    mode: 'full',
    status,
    error: null,
    warnings: [],
    progress: { done: 1, total: 1 },
    viewport: { w: 10, h: 10 },
    dpr: 1,
    css: size,
    image: size,
    slices: [],
    layout: { size, background: '#fff', fills: [], parts: [] },
    ...(extra.bytes === undefined ? {} : { bytes: extra.bytes }),
  };
}

/** `n` sessions `s0` (newest) … `s<n-1>`, one minute apart, the newest created at `newest`. */
async function seed(n: number, newest: number, extra: { bytes?: number } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    await putSession(session(id, newest - i * 60_000, extra));
    ids.push(id);
  }
  return ids;
}

const ids = async () => (await listSessions(1000)).map((s) => s.id);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pruneSessions', () => {
  it('keeps the newest 10 regardless of age and deletes older ones past maxAge', async () => {
    await seed(13, NOW - 8 * DAY);
    const deleted = await pruneSessions({ now: NOW });
    expect(deleted.sort()).toEqual(['s10', 's11', 's12']);
    expect(await ids()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  });

  it('keeps young sessions beyond the newest `keep`', async () => {
    await seed(5, NOW - 1000);
    await putSession(session('old', NOW - 8 * DAY));
    expect(await pruneSessions({ keep: 2, now: NOW })).toEqual(['old']);
    expect(await ids()).toHaveLength(5);
  });

  it('keeps the old call shape `{ keep, maxAgeMs }` working', async () => {
    await seed(3, Date.now() - 2 * DAY);
    expect(await pruneSessions({ keep: 1, maxAgeMs: DAY })).toEqual(['s1', 's2']);
  });

  it('evicts oldest first over the byte budget, never the newest', async () => {
    await seed(4, NOW - 2 * HOUR, { bytes: 100 });
    // 400 bytes, budget 250: s3 then s2 go.
    expect(await pruneSessions({ maxBytes: 250, now: NOW })).toEqual(['s3', 's2']);
    expect(await ids()).toEqual(['s0', 's1']);
    // The newest alone over budget still stays.
    expect(await pruneSessions({ maxBytes: 1, now: NOW })).toEqual(['s1']);
    expect(await ids()).toEqual(['s0']);
  });

  it('measures slice blobs when `session.bytes` is absent', async () => {
    await seed(3, NOW - 2 * HOUR);
    for (const id of ['s0', 's1', 's2']) {
      await putSlice({ sessionId: id, index: 0, blob: new Blob([new Uint8Array(60)]) });
      await putSlice({ sessionId: id, index: 1, blob: new Blob([new Uint8Array(40)]) });
    }
    expect(await pruneSessions({ maxBytes: 250, now: NOW })).toEqual(['s2']);
    expect(await countSlices('s2')).toBe(0);
    expect(await countSlices('s1')).toBe(2);
  });

  it('never deletes protected sessions (array or Set), by age or by bytes', async () => {
    await seed(4, NOW - 8 * DAY, { bytes: 100 });
    expect(await pruneSessions({ keep: 1, protect: ['s2'], now: NOW })).toEqual(['s1', 's3']);
    expect(await ids()).toEqual(['s0', 's2']);
    expect(await pruneSessions({ maxBytes: 1, protect: new Set(['s2']), now: NOW })).toEqual([]);
  });

  it('never deletes a capturing session, live or stale (recovery makes it final first)', async () => {
    await putSession(session('new', NOW - 1000));
    await putSession(
      session('live', NOW - 9 * DAY, { status: 'capturing', updatedAt: NOW - 5000, bytes: 999 }),
    );
    await putSession(
      session('dead', NOW - 8 * DAY, { status: 'capturing', updatedAt: NOW - 8 * DAY }),
    );
    await putSession(session('old', NOW - 8 * DAY + 1, { bytes: 5 }));
    expect(await pruneSessions({ keep: 1, maxBytes: 1, now: NOW })).toEqual(['old']);
    expect(await ids()).toEqual(['new', 'dead', 'live']);
  });

  it('never deletes anything younger than the grace period, whatever the count or bytes', async () => {
    // A user who captures 14 pages in a row and opens the editors later keeps every one.
    await seed(14, NOW - 30 * 60 * 1000, { bytes: 10 ** 9 });
    expect(await pruneSessions({ keep: 1, maxAgeMs: 0, maxBytes: 1, now: NOW })).toEqual([]);
    expect(await ids()).toHaveLength(14);
  });

  it('never treats slices written before their session record as orphans', async () => {
    const fresh = `${(NOW - 1000).toString(36)}-abcdefgh`;
    const stale = `${(NOW - 2 * HOUR).toString(36)}-abcdefgh`;
    await putSlice({ sessionId: fresh, index: 0, blob: new Blob(['x']) });
    await putSlice({ sessionId: stale, index: 0, blob: new Blob(['x']) });
    await putSlice({ sessionId: 'not-a-time-id', index: 0, blob: new Blob(['x']) });
    await pruneSessions({ now: NOW });
    expect(await countSlices(fresh)).toBe(1);
    expect(await countSlices('not-a-time-id')).toBe(1);
    expect(await countSlices(stale)).toBe(0);
  });

  it('falls back to safe defaults for garbage options', async () => {
    await seed(12, NOW - 1000, { bytes: 10 });
    const garbage = [
      { keep: 0 },
      { keep: -5 },
      { keep: Number.NaN },
      { keep: null },
      { maxAgeMs: Number.NaN },
      { maxAgeMs: -1 },
      { maxAgeMs: null },
      { maxAgeMs: '0' },
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: Number.NaN },
      { maxBytes: null },
      { now: Number.NaN },
    ];
    for (const g of garbage) {
      expect(await pruneSessions({ ...(g as object), now: NOW })).toEqual([]);
    }
    expect(await ids()).toHaveLength(12);
    // keep 0 is clamped to 1: everything old except the newest goes.
    await deleteAllSessions();
    await seed(3, NOW - 8 * DAY);
    expect(await pruneSessions({ keep: 0, maxAgeMs: 0, now: NOW })).toHaveLength(2);
    expect(await ids()).toEqual(['s0']);
  });

  it('deletes orphan docs and slices, but not those of protected ids', async () => {
    const old = (n: number) => `${(NOW - 2 * HOUR - n).toString(36)}-orphan0${n}`;
    const [gone, open] = [old(1), old(2)];
    await putSession(session('a', NOW - 1000));
    await putDoc(emptyDoc('a', { w: 10, h: 10, dpr: 1 }));
    await putDoc(emptyDoc(gone, { w: 10, h: 10, dpr: 1 }));
    await putDoc(emptyDoc(open, { w: 10, h: 10, dpr: 1 }));
    await putSlice({ sessionId: gone, index: 0, blob: new Blob(['x']) });
    await putSlice({ sessionId: open, index: 0, blob: new Blob(['x']) });
    expect(await pruneSessions({ protect: [open], now: NOW })).toEqual([]);
    expect(await getDoc('a')).toBeDefined();
    expect(await getDoc(gone)).toBeUndefined();
    expect(await getDoc(open)).toBeDefined();
    expect(await countSlices(gone)).toBe(0);
    expect(await countSlices(open)).toBe(1);
  });
});

describe('deleteAllSessions', () => {
  it('deletes everything except a running capture', async () => {
    const now = Date.now();
    await seed(3, now - DAY);
    await putSession(session('live', now, { status: 'capturing', updatedAt: now }));
    await putSession(session('dead', now - DAY, { status: 'capturing', updatedAt: now - DAY }));
    await putSlice({ sessionId: 's0', index: 0, blob: new Blob(['x']) });
    await putSlice({ sessionId: 'live', index: 0, blob: new Blob(['x']) });
    await putDoc(emptyDoc('s1', { w: 10, h: 10, dpr: 1 }));
    await putDoc(emptyDoc('orphan', { w: 10, h: 10, dpr: 1 }));
    expect(await deleteAllSessions()).toBe(4);
    expect(await ids()).toEqual(['live']);
    expect(await countSlices('s0')).toBe(0);
    expect(await countSlices('live')).toBe(1);
    expect(await getDoc('s1')).toBeUndefined();
    expect(await getDoc('orphan')).toBeUndefined();
  });
});

describe('storage usage', () => {
  it('caps the budget at 1 GiB or 10% of quota', () => {
    expect(retentionBudget(null)).toBe(RETENTION.maxBytes);
    expect(retentionBudget(undefined)).toBe(RETENTION.maxBytes);
    expect(retentionBudget(Number.NaN)).toBe(RETENTION.maxBytes);
    expect(retentionBudget(0)).toBe(RETENTION.maxBytes);
    expect(retentionBudget(2e9)).toBe(2e8);
    expect(retentionBudget(1e12)).toBe(RETENTION.maxBytes);
  });

  it('reports sessions, slice bytes, budget, usage and quota', async () => {
    await putSession(session('a', NOW, { bytes: 500 }));
    await putSession(session('b', NOW - 1));
    await putSlice({ sessionId: 'b', index: 0, blob: new Blob([new Uint8Array(70)]) });
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 1234, quota: 5e9 }) },
    });
    expect(await getStorageUsage()).toEqual({
      sessions: 2,
      bytes: 570,
      budget: 5e8,
      usage: 1234,
      quota: 5e9,
    });
    vi.stubGlobal('navigator', {});
    expect(await getStorageUsage()).toEqual({
      sessions: 2,
      bytes: 570,
      budget: RETENTION.maxBytes,
      usage: null,
      quota: null,
    });
  });
});

describe('openDb', () => {
  it('retries after a failed open instead of caching the rejection', async () => {
    await closeDb();
    // A newer version on disk makes our version-1 open fail with a VersionError.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('pagesnap', 5);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    await expect(openDb()).rejects.toThrow();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('pagesnap');
      req.onsuccess = () => resolve();
    });
    const db = await openDb();
    expect(db.version).toBe(1);
    await putSession(session('a', NOW));
    expect(await getSession('a')).toBeDefined();
  });
});

describe('runRetention (service worker)', () => {
  const store = fakeBrowser.storage.session;

  it('protects sessions open in an editor tab and the active capture', async () => {
    await seed(13, Date.now() - 8 * DAY);
    const base = fakeBrowser.runtime.getURL('/editor.html');
    vi.spyOn(fakeBrowser.runtime, 'getContexts').mockResolvedValue([
      { documentUrl: `${base}#s=s12`, contextType: 'TAB' },
      { documentUrl: 'https://example.com/#s=s11', contextType: 'TAB' },
    ] as never);
    await store.set({ [ACTIVE_CAPTURE_KEY]: 's10' });
    const { deleted } = await runRetention({ activeId: 's11', reason: 'capture' });
    expect(deleted).toEqual([]);
    vi.restoreAllMocks();
    vi.spyOn(fakeBrowser.runtime, 'getContexts').mockResolvedValue([
      { documentUrl: `${base}#s=s12`, contextType: 'TAB' },
    ] as never);
    await store.remove(ACTIVE_CAPTURE_KEY);
    expect((await runRetention({ reason: 'capture' })).deleted.sort()).toEqual(['s10', 's11']);
  });

  it('survives a browser without getContexts (treats it as no open editors)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed(11, Date.now() - 8 * DAY);
    expect((await runRetention({ reason: 'capture' })).deleted).toEqual(['s10']);
  });

  it('removes stale status mirrors and timings, and nothing else', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    const old = now - MIRROR_TTL_MS - 5000;
    await putSession(session('fin-old', old));
    await putSession(session('fin-new', now - 1000));
    await putSession(session('cap', old, { status: 'capturing', updatedAt: old }));
    const snap = (id: string, status: SessionStatus, updatedAt: number) => ({
      id,
      status,
      updatedAt,
      progress: { done: 1, total: 1 },
      error: null,
    });
    const keys = {
      [sessionStatusKey('fin-old')]: snap('fin-old', 'ready', old),
      [timingsKey('fin-old')]: { id: 'fin-old' },
      [sessionStatusKey('fin-new')]: snap('fin-new', 'ready', now),
      [timingsKey('fin-new')]: { id: 'fin-new' },
      [sessionStatusKey('cap')]: snap('cap', 'capturing', old),
      [sessionStatusKey('gone')]: snap('gone', 'ready', now),
      [timingsKey('gone')]: { id: 'gone' },
      [sessionStatusKey('starting')]: snap('starting', 'capturing', now),
      [sessionStatusKey('active')]: snap('active', 'ready', old),
      [ACTIVE_CAPTURE_KEY]: 'active',
      'something-else': 1,
    };
    await store.set(keys);
    await runRetention({ reason: 'capture' });
    const left = Object.keys(await store.get(null)).sort();
    expect(left).toEqual(
      [
        sessionStatusKey('fin-new'),
        timingsKey('fin-new'),
        sessionStatusKey('cap'),
        sessionStatusKey('starting'),
        sessionStatusKey('active'),
        ACTIVE_CAPTURE_KEY,
        'something-else',
        RETENTION_AT_KEY,
      ].sort(),
    );
  });

  it('throttles start-up runs to one per 10 minutes, unless forced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await runRetention({ reason: 'startup' })).skipped).toBeUndefined();
    expect((await runRetention({ reason: 'startup' })).skipped).toBe(true);
    expect((await runRetention({ reason: 'startup', force: true })).skipped).toBeUndefined();
    expect((await runRetention({ reason: 'capture' })).skipped).toBeUndefined();
    await store.set({ [RETENTION_AT_KEY]: Date.now() - STARTUP_THROTTLE_MS - 1 });
    expect((await runRetention({ reason: 'startup' })).skipped).toBeUndefined();
  });

  it('coalesces concurrent calls into one follow-up run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed(11, Date.now() - 8 * DAY);
    const set = vi.spyOn(store, 'set');
    const results = await Promise.all([
      runRetention({ reason: 'capture' }),
      runRetention({ reason: 'capture', activeId: 's10' }),
      runRetention({ reason: 'capture' }),
    ]);
    const runs = set.mock.calls.filter(([items]) => RETENTION_AT_KEY in items).length;
    expect(runs).toBe(2);
    expect(results[0]?.deleted).toEqual(['s10']);
    expect(results[1]).toBe(results[2]);
  });

  it('never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(store, 'get').mockRejectedValue(new Error('boom'));
    expect(await runRetention({ reason: 'startup' })).toEqual({ deleted: [] });
    expect(warn).toHaveBeenCalledWith('[pagesnap] retention failed', expect.any(Error));
  });
});
