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

/** Shared connection (one per JS context). */
export function openDb(): Promise<Db> {
  dbPromise ??= openDB<PagesnapDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-createdAt', 'createdAt');
        const slices = db.createObjectStore('slices', { keyPath: ['sessionId', 'index'] });
        slices.createIndex('by-session', 'sessionId');
        db.createObjectStore('docs', { keyPath: 'sessionId' });
      }
    },
    blocking() {
      // A newer version wants to upgrade: let it.
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

/** Close and forget the shared connection (tests). */
export async function closeDb(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (p) (await p).close();
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

/** Retention: delete sessions older than `maxAgeMs`, but always keep the newest `keep`. */
export async function pruneSessions(opts: { keep: number; maxAgeMs: number }): Promise<number> {
  const sessions = await listSessions(Number.MAX_SAFE_INTEGER);
  const cutoff = Date.now() - opts.maxAgeMs;
  const doomed = sessions.slice(opts.keep).filter((s) => s.createdAt < cutoff);
  for (const s of doomed) await deleteSession(s.id);
  return doomed.length;
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
