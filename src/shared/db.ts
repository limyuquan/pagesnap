/**
 * IndexedDB schema and typed helpers (via `idb`). Works in the service worker, extension pages and
 * workers: it doesn't import `browser` or touch the DOM.
 *
 * Database `pagesnap`, version `DB_VERSION`:
 * - `sessions`: `CaptureSession`, key `id`, index `by-createdAt`. Written only by the SW (A).
 * - `slices`:   `SliceRecord` (PNG Blob), key `[sessionId, index]`, index `by-session`. Written only by the SW (A).
 * - `docs`:     `AnnotationDoc`, key `sessionId`. Written only by the editor (B).
 *
 * Schema changes: bump `DB_VERSION`, add an `if (oldVersion < N)` step in `upgrade`, and record it
 * in docs/CONTRACTS.md. Never edit an existing step.
 */
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { AnnotationDoc } from './annotations';
import { STALE_CAPTURE_MS } from './protocol';
import type { CaptureSession, SessionId } from './types';

export const DB_NAME = 'pagesnap';
export const DB_VERSION = 1;

/** One stored screenshot. Metadata is in `CaptureSession.slices[index]`. */
export interface SliceRecord {
  sessionId: SessionId;
  index: number;
  /** `image/png` as returned by `captureVisibleTab`. */
  blob: Blob;
}

export interface PagesnapDB extends DBSchema {
  sessions: {
    key: SessionId;
    value: CaptureSession;
    indexes: { 'by-createdAt': number };
  };
  slices: {
    key: [SessionId, number];
    value: SliceRecord;
    indexes: { 'by-session': SessionId };
  };
  docs: {
    key: SessionId;
    value: AnnotationDoc;
  };
}

export type Db = IDBPDatabase<PagesnapDB>;

let dbPromise: Promise<Db> | null = null;

/**
 * Shared connection (one per JS context). A failed open isn't cached, so the next call retries. If
 * the browser closes the connection abnormally (`terminated`, e.g. the database was deleted from
 * settings) or a newer version needs it closed (`blocking`), it is forgotten and reopened lazily.
 */
export function openDb(): Promise<Db> {
  if (dbPromise) return dbPromise;
  const forget = () => {
    if (dbPromise === p) dbPromise = null;
  };
  const p = openDB<PagesnapDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-createdAt', 'createdAt');
        const slices = db.createObjectStore('slices', { keyPath: ['sessionId', 'index'] });
        slices.createIndex('by-session', 'sessionId');
        db.createObjectStore('docs', { keyPath: 'sessionId' });
      }
    },
    blocked() {
      // An older connection (another context) hasn't closed yet; the open resumes once it does.
      console.warn('[pagesnap] IndexedDB open is blocked by another connection');
    },
    blocking() {
      // A newer version wants to upgrade: let it.
      forget();
      void p.then((db) => db.close());
    },
    terminated() {
      forget();
    },
  });
  dbPromise = p;
  p.catch(forget);
  return p;
}

/** Close and forget the shared connection (tests). */
export async function closeDb(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (p) await p.then((db) => db.close()).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// sessions

export async function putSession(session: CaptureSession): Promise<void> {
  const db = await openDb();
  await db.put('sessions', session);
}

export async function getSession(id: SessionId): Promise<CaptureSession | undefined> {
  const db = await openDb();
  return db.get('sessions', id);
}

/**
 * Read-modify-write in one transaction. `update` gets the current record and returns the next one
 * (`updatedAt` is set for you). Throws if the session doesn't exist.
 */
export async function updateSession(
  id: SessionId,
  update: (current: CaptureSession) => CaptureSession,
): Promise<CaptureSession> {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readwrite');
  const current = await tx.store.get(id);
  if (!current) {
    tx.done.catch(() => {}); // the abort below rejects `done`; nothing else is waiting on it
    tx.abort();
    throw new Error(`Session ${id} not found`);
  }
  const next = { ...update(current), updatedAt: Date.now() };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** Newest first. */
export async function listSessions(limit = 50): Promise<CaptureSession[]> {
  const db = await openDb();
  const out: CaptureSession[] = [];
  let cursor = await db
    .transaction('sessions')
    .store.index('by-createdAt')
    .openCursor(null, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

/** Delete a session with all its slices and its doc. */
export async function deleteSession(id: SessionId): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'slices', 'docs'], 'readwrite');
  const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  await Promise.all([
    tx.objectStore('sessions').delete(id),
    tx.objectStore('slices').delete(range),
    tx.objectStore('docs').delete(id),
    tx.done,
  ]);
}

// ---------------------------------------------------------------------------------------------
// slices

export async function putSlice(record: SliceRecord): Promise<void> {
  const db = await openDb();
  await db.put('slices', record);
}

export async function getSliceBlob(sessionId: SessionId, index: number): Promise<Blob> {
  const db = await openDb();
  const rec = await db.get('slices', [sessionId, index]);
  if (!rec) throw new Error(`Slice ${sessionId}#${index} not found`);
  return rec.blob;
}

export async function countSlices(sessionId: SessionId): Promise<number> {
  const db = await openDb();
  return db.countFromIndex('slices', 'by-session', sessionId);
}

// ---------------------------------------------------------------------------------------------
// annotation docs

export async function getDoc(sessionId: SessionId): Promise<AnnotationDoc | undefined> {
  const db = await openDb();
  return db.get('docs', sessionId);
}

export async function putDoc(doc: AnnotationDoc): Promise<void> {
  const db = await openDb();
  await db.put('docs', doc);
}

// ---------------------------------------------------------------------------------------------
// retention

/**
 * Retention policy (applied by the SW after every capture and on start-up, `capture/retention.ts`):
 * - the newest `keep` sessions are never deleted for their age;
 * - any other session older than `maxAgeMs` is deleted;
 * - then, while the slice PNGs take more than the byte budget (`retentionBudget(quota)`), the
 *   oldest sessions are evicted, never the newest one;
 * - protected sessions (open in an editor) and captures still running are never deleted.
 */
export const RETENTION = {
  keep: 10,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 1024 ** 3,
  quotaFraction: 0.1,
  /**
   * Grace period: a session (or orphan slices/doc) younger than this is never deleted
   * automatically, whatever the count or byte budget says. Someone who captures a dozen pages in
   * a row and opens the editors later keeps all of them; writers that store slices before their
   * session record (seeding, a capture in flight) never lose them.
   */
  minAgeMs: 60 * 60 * 1000,
} as const;

/** Creation time encoded in a time-sortable session id (`newSessionId`), or `null`. */
export function sessionIdTime(id: SessionId): number | null {
  const head = id.split('-')[0] ?? '';
  if (!/^[0-9a-z]{6,10}$/.test(head)) return null;
  const t = Number.parseInt(head, 36);
  return Number.isFinite(t) ? t : null;
}

/** Byte budget for stored captures: `min(RETENTION.maxBytes, quotaFraction × quota)`. */
export function retentionBudget(quota: number | null | undefined): number {
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) return RETENTION.maxBytes;
  return Math.min(RETENTION.maxBytes, Math.floor(quota * RETENTION.quotaFraction));
}

export interface PruneOptions {
  /** Newest sessions kept regardless of age. Clamped to ≥ 1. Default `RETENTION.keep`. */
  keep?: number;
  /** Default `RETENTION.maxAgeMs`. */
  maxAgeMs?: number;
  /** Total slice bytes allowed. Default `RETENTION.maxBytes`. */
  maxBytes?: number;
  /** Never deleted (sessions open in an editor, the running capture). */
  protect?: ReadonlySet<SessionId> | readonly SessionId[];
  /** Epoch ms, default `Date.now()`. */
  now?: number;
}

/** `v` if it is a number ≥ `min` (Infinity allowed), else `fallback`. Guards against bad settings. */
function numberAtLeast(v: unknown, min: number, fallback: number): number {
  return typeof v === 'number' && !Number.isNaN(v) && v >= min ? v : fallback;
}

/** A capture that is running right now (its record was written within `STALE_CAPTURE_MS`). */
function isLiveCapture(s: CaptureSession, now: number): boolean {
  return s.status === 'capturing' && now - s.updatedAt < STALE_CAPTURE_MS;
}

/** Never deleted automatically: not final yet, or younger than the grace period. */
function isYoung(s: CaptureSession, now: number): boolean {
  return s.status === 'capturing' || now - Math.max(s.createdAt, s.updatedAt) < RETENTION.minAgeMs;
}

/** Every session, newest first. */
async function allSessions(): Promise<CaptureSession[]> {
  return listSessions(Number.MAX_SAFE_INTEGER);
}

/** Bytes of each session's slices: `session.bytes`, else the sum of its slice blob sizes. */
async function sessionBytes(sessions: readonly CaptureSession[]): Promise<Map<SessionId, number>> {
  const out = new Map<SessionId, number>();
  const missing: SessionId[] = [];
  for (const s of sessions) {
    if (typeof s.bytes === 'number' && Number.isFinite(s.bytes) && s.bytes >= 0) {
      out.set(s.id, s.bytes);
    } else {
      missing.push(s.id);
    }
  }
  if (missing.length === 0) return out;
  const db = await openDb();
  const index = db.transaction('slices').store.index('by-session');
  for (const id of missing) {
    let total = 0;
    // The cursor value holds a Blob handle; reading `size` doesn't load the PNG bytes.
    for (let c = await index.openCursor(id); c; c = await c.continue()) total += c.value.blob.size;
    out.set(id, total);
  }
  return out;
}

/**
 * Delete docs and slices whose session no longer exists (an editor saved after its session was
 * deleted, or a capture's slice landed after a delete), except for `keep` ids. One transaction,
 * so a session created meanwhile can't be mistaken for an orphan.
 */
async function deleteOrphans(keep: ReadonlySet<SessionId>, now = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'slices', 'docs'], 'readwrite');
  const sessions = new Set(await tx.objectStore('sessions').getAllKeys());
  // Slices may be written before their session record: only ids older than the grace period
  // (by the time in the id; unparseable ids are never treated as orphans) count.
  const old = (id: SessionId) => {
    const t = sessionIdTime(id);
    return t != null && now - t >= RETENTION.minAgeMs;
  };
  const orphan = (id: SessionId) => !sessions.has(id) && !keep.has(id) && old(id);
  const docs = tx.objectStore('docs');
  for (const id of await docs.getAllKeys()) {
    if (orphan(id)) await docs.delete(id);
  }
  const slices = tx.objectStore('slices');
  const sliceOwners: SessionId[] = [];
  for (
    let c = await slices.index('by-session').openKeyCursor(null, 'nextunique');
    c;
    c = await c.continue()
  ) {
    sliceOwners.push(c.key);
  }
  for (const id of sliceOwners) {
    if (orphan(id)) await slices.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  }
  await tx.done;
}

/**
 * Apply the retention policy (see `RETENTION`) and return the ids of the deleted sessions. Bad
 * option values fall back to the defaults, and `keep` is at least 1, so a broken setting can't
 * delete everything.
 */
export async function pruneSessions(opts: PruneOptions = {}): Promise<SessionId[]> {
  const keep = Math.max(1, Math.floor(numberAtLeast(opts.keep, -Infinity, RETENTION.keep)));
  const maxAgeMs = numberAtLeast(opts.maxAgeMs, 0, RETENTION.maxAgeMs);
  const maxBytes = numberAtLeast(opts.maxBytes, 1, RETENTION.maxBytes);
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const protect = new Set<SessionId>(opts.protect ?? []);
  const deletable = (s: CaptureSession) =>
    !protect.has(s.id) && !isLiveCapture(s, now) && !isYoung(s, now);

  const sessions = await allSessions();
  const deleted: SessionId[] = [];

  // 1. Age, beyond the newest `keep`.
  const cutoff = now - maxAgeMs;
  const left: CaptureSession[] = [];
  for (const [i, s] of sessions.entries()) {
    if (i >= keep && s.createdAt < cutoff && deletable(s)) {
      await deleteSession(s.id);
      deleted.push(s.id);
    } else {
      left.push(s);
    }
  }

  // 2. Byte budget: evict oldest first, never the newest session.
  const bytes = await sessionBytes(left);
  let total = 0;
  for (const b of bytes.values()) total += b;
  for (let i = left.length - 1; i >= 1 && total > maxBytes; i--) {
    const s = left[i];
    if (!s || !deletable(s)) continue;
    await deleteSession(s.id);
    deleted.push(s.id);
    total -= bytes.get(s.id) ?? 0;
  }

  // 3. Orphans (docs/slices of sessions that are gone), never those of protected ids.
  await deleteOrphans(protect, now);
  return deleted;
}

/**
 * Delete every session with its slices and doc, except a capture that is running right now.
 * Returns how many sessions were deleted. For the options page's "Delete all captures".
 */
export async function deleteAllSessions(): Promise<number> {
  const now = Date.now();
  const keep = new Set<SessionId>();
  let count = 0;
  for (const s of await allSessions()) {
    if (isLiveCapture(s, now)) {
      keep.add(s.id);
      continue;
    }
    await deleteSession(s.id);
    count++;
  }
  await deleteOrphans(keep);
  return count;
}

export interface StorageUsage {
  /** Stored sessions. */
  sessions: number;
  /** Total bytes of the stored slice PNGs. */
  bytes: number;
  /** Retention byte cap, `retentionBudget(quota)`. */
  budget: number;
  /** `navigator.storage.estimate()` for the whole extension origin, `null` if unavailable. */
  usage: number | null;
  quota: number | null;
}

/** `navigator.storage.estimate()`, or nulls where it isn't available. */
export async function estimateStorage(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const est = await globalThis.navigator?.storage?.estimate?.();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { usage: num(est?.usage), quota: num(est?.quota) };
  } catch {
    return { usage: null, quota: null };
  }
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const [sessions, { usage, quota }] = await Promise.all([allSessions(), estimateStorage()]);
  let bytes = 0;
  for (const b of (await sessionBytes(sessions)).values()) bytes += b;
  return { sessions: sessions.length, bytes, budget: retentionBudget(quota), usage, quota };
}
