/**
 * Debounced autosave of the annotation doc to the `docs` IDB store (03 §7.3). Keyed by `rev`, so
 * an unchanged doc is never rewritten. On page hide the pending doc is written synchronously
 * (the IDB transaction starts inside the event handler), so a reload right after an edit keeps it.
 */
import type { AnnotationDoc } from '@/shared/annotations';
import { type Db, openDb, putDoc } from '@/shared/db';

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
      // microtasks a chance to run); otherwise go through the shared helper.
      write = this.db ? this.db.put('docs', doc) : putDoc(doc);
    } catch {
      write = putDoc(doc);
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
