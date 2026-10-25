/**
 * Debounced autosave of the annotation doc to the `docs` IDB store (03 §7.3). Keyed by `rev`, so
 * an unchanged doc is never rewritten. On page hide the pending doc is written synchronously
 * (the IDB transaction starts inside the event handler), so a reload right after an edit keeps it.
 *
 * Writes are compare-and-set (inside one transaction: only if the stored doc isn't newer), so a
 * second editor tab on the same capture can't overwrite a newer doc with an older one. `DocSync`
 * keeps such tabs in step over a BroadcastChannel; the newest doc wins everywhere.
 */
import type { AnnotationDoc } from '@/shared/annotations';
import { type Db, openDb } from '@/shared/db';

export const AUTOSAVE_DELAY_MS = 500;

/**
 * Chrome aborts IndexedDB transactions still running when a page unloads, so on page hide the
 * pending doc is also written to `sessionStorage` (synchronous, survives a reload of the tab).
 * `init` takes whichever copy has the higher `rev`.
 */
const backupKey = (sessionId: string) => `pagesnap:doc:${sessionId}`;

export function readBackupDoc(sessionId: string): unknown {
  try {
    const raw = sessionStorage.getItem(backupKey(sessionId));
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeBackup(doc: AnnotationDoc): void {
  try {
    sessionStorage.setItem(backupKey(doc.sessionId), JSON.stringify(doc));
  } catch {
    // quota or no storage: IDB is still the main copy
  }
}

function clearBackup(doc: AnnotationDoc): void {
  try {
    const raw = sessionStorage.getItem(backupKey(doc.sessionId));
    if (raw && (JSON.parse(raw) as AnnotationDoc).rev <= doc.rev) {
      sessionStorage.removeItem(backupKey(doc.sessionId));
    }
  } catch {
    // ignore
  }
}

/** Newest-wins order for docs of one session: rev, then time, then the writer's tab id. */
export function isNewerDoc(a: AnnotationDoc, b: AnnotationDoc, aTab = '', bTab = ''): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return aTab > bTab;
}

/** Put `doc` unless the stored copy is newer, in one transaction. */
export async function putDocIfNewer(db: Db, doc: AnnotationDoc): Promise<boolean> {
  const tx = db.transaction('docs', 'readwrite');
  const cur = (await tx.store.get(doc.sessionId)) as AnnotationDoc | undefined;
  const write =
    !cur || cur.rev < doc.rev || (cur.rev === doc.rev && cur.updatedAt <= doc.updatedAt);
  if (write) await tx.store.put(doc);
  await tx.done;
  return write;
}

export class Autosaver {
  private pending: AnnotationDoc | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private savedRev = -1;
  private writing: Promise<void> = Promise.resolve();
  private db: Db | null = null;
  private readonly delay: number;
  private readonly onHide = () => {
    if (this.pending) writeBackup(this.pending);
    void this.flush();
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.onHide();
  };

  constructor(delay = AUTOSAVE_DELAY_MS) {
    this.delay = delay;
    openDb().then(
      (db) => {
        this.db = db;
      },
      () => {},
    );
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onHide);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  schedule(doc: AnnotationDoc): void {
    if (doc.rev === this.savedRev) return;
    this.pending = doc;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  /** Write the pending doc now (resolves once it's stored). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const doc = this.pending;
    this.pending = null;
    if (!doc || doc.rev === this.savedRev) return this.writing;
    const done = () => {
      this.savedRev = Math.max(this.savedRev, doc.rev);
      clearBackup(doc);
    };
    const fail = (err: unknown) => console.warn('[pagesnap] autosave failed', err);
    let write: Promise<unknown>;
    try {
      // Start the transaction synchronously when the connection is open (page hide may not give
      // microtasks a chance to run); otherwise open it first.
      write = this.db ? putDocIfNewer(this.db, doc) : openDb().then((db) => putDocIfNewer(db, doc));
    } catch {
      write = openDb().then((db) => putDocIfNewer(db, doc));
    }
    this.writing = Promise.all([this.writing, write]).then(done, fail);
    return this.writing;
  }

  dispose(): void {
    void this.flush();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onHide);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }
}

type SyncMessage =
  | { t: 'doc'; doc: AnnotationDoc; tab: string }
  /** A tab just opened this session: whoever has a doc answers with it. */
  | { t: 'hello'; tab: string };

/**
 * Keeps editor tabs on the same capture in step: every local change is broadcast, and a tab
 * adopts any doc that is newer than its own (`isNewerDoc`). Last writer wins; the adopting tab
 * resets its undo history (see the store).
 */
export class DocSync {
  readonly tab: string;
  private readonly channel: BroadcastChannel | null;
  private readonly getDoc: () => AnnotationDoc | null;

  constructor(
    sessionId: string,
    getDoc: () => AnnotationDoc | null,
    onRemote: (doc: AnnotationDoc) => void,
  ) {
    this.tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.getDoc = getDoc;
    let channel: BroadcastChannel | null = null;
    try {
      channel =
        typeof BroadcastChannel === 'undefined'
          ? null
          : new BroadcastChannel(`pagesnap:doc:${sessionId}`);
    } catch {
      channel = null;
    }
    this.channel = channel;
    if (!channel) return;
    channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
      const m = ev.data;
      if (!m || m.tab === this.tab) return;
      if (m.t === 'hello') {
        const mine = this.getDoc();
        if (mine) this.post({ t: 'doc', doc: mine, tab: this.tab });
        return;
      }
      if (m.t === 'doc' && m.doc?.sessionId === sessionId) {
        const mine = this.getDoc();
        if (!mine || isNewerDoc(m.doc, mine, m.tab, this.tab)) onRemote(m.doc);
      }
    };
    this.post({ t: 'hello', tab: this.tab });
  }

  /** Tell the other tabs about a local change. */
  publish(doc: AnnotationDoc): void {
    this.post({ t: 'doc', doc, tab: this.tab });
  }

  private post(m: SyncMessage): void {
    try {
      this.channel?.postMessage(m);
    } catch {
      // a closed channel or an uncloneable doc: the tabs just don't sync
    }
  }

  dispose(): void {
    this.channel?.close();
  }
}
