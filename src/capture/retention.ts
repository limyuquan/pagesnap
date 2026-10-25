/**
 * Service-worker retention pass (owner: A). Applies `RETENTION` from `db.ts` after every capture and
 * on SW start, and removes stale `chrome.storage.session` mirrors (`session-status:*`,
 * `capture-timings:*`).
 *
 * Protected, never deleted:
 * - `opts.activeId` and the id in `ACTIVE_CAPTURE_KEY` (the running capture);
 * - every session whose editor tab is open, found with `runtime.getContexts({ contextTypes: ['TAB'] })`
 *   (no `tabs` permission needed). Each context's `documentUrl` is the editor's full URL including
 *   the `#s=<id>` hash (verified in tests/e2e/capture.retention.spec.ts), parsed with
 *   `parseEditorHash`.
 */
import { type Browser, browser } from 'wxt/browser';
import { estimateStorage, getSession, pruneSessions, retentionBudget } from '@/shared/db';
import { parseEditorHash, type SessionStatusSnapshot } from '@/shared/handoff';
import {
  ACTIVE_CAPTURE_KEY,
  EDITOR_PATH,
  STALE_CAPTURE_MS,
  sessionStatusKey,
  timingsKey,
} from '@/shared/protocol';
import type { SessionId } from '@/shared/types';

/** `chrome.storage.session` key: epoch ms of the last retention run (start-up throttle). */
export const RETENTION_AT_KEY = 'retention-at';
/** A `reason: 'startup'` run is skipped if the last run was more recent than this. */
export const STARTUP_THROTTLE_MS = 10 * 60_000;
/** Mirrors of finished sessions are removed once the session is this old (since its last write). */
export const MIRROR_TTL_MS = 60_000;

export interface RetentionOptions {
  /** The capture that is running or has just finished: never deleted. */
  activeId?: SessionId | null;
  /** Run even if a start-up run would be throttled. */
  force?: boolean;
  /** `'startup'` runs are throttled to one per `STARTUP_THROTTLE_MS`; anything else always runs. */
  reason?: string;
}

export interface RetentionResult {
  deleted: SessionId[];
  /** Set when a throttled start-up run was skipped. */
  skipped?: boolean;
}

interface Pending {
  promise: Promise<RetentionResult>;
  active: Set<SessionId>;
  /** True while every merged caller is a throttleable start-up call. */
  throttle: boolean;
}

let current: Promise<RetentionResult> | null = null;
let next: Pending | null = null;

/**
 * Run the retention pass. Never throws. One pass runs at a time: a call made during a pass waits
 * for it and is then served by one follow-up pass shared by every caller that arrived meanwhile.
 */
export function runRetention(opts: RetentionOptions = {}): Promise<RetentionResult> {
  const throttle = opts.reason === 'startup' && !opts.force;
  if (!current && !next) {
    current = start(activeSet(opts), throttle);
    return current;
  }
  if (!next) {
    const pending: Pending = {
      active: new Set(),
      throttle: true,
      promise: Promise.resolve({ deleted: [] }),
    };
    pending.promise = (current ?? Promise.resolve()).then(() => {
      if (next === pending) next = null;
      current = start(pending.active, pending.throttle);
      return current;
    });
    next = pending;
  }
  for (const id of activeSet(opts)) next.active.add(id);
  next.throttle &&= throttle;
  return next.promise;
}

function activeSet(opts: RetentionOptions): Set<SessionId> {
  return new Set(opts.activeId ? [opts.activeId] : []);
}

function start(active: Set<SessionId>, throttle: boolean): Promise<RetentionResult> {
  const p: Promise<RetentionResult> = runOnce(active, throttle)
    .catch((err: unknown): RetentionResult => {
      console.warn('[pagesnap] retention failed', err);
      return { deleted: [] };
    })
    .finally(() => {
      if (current === p) current = null;
    });
  return p;
}

async function runOnce(active: Set<SessionId>, throttle: boolean): Promise<RetentionResult> {
  const now = Date.now();
  const area = browser.storage.session;
  if (throttle) {
    const at = (await area.get(RETENTION_AT_KEY))[RETENTION_AT_KEY];
    if (typeof at === 'number' && now - at >= 0 && now - at < STARTUP_THROTTLE_MS) {
      return { deleted: [], skipped: true };
    }
  }
  await area.set({ [RETENTION_AT_KEY]: now });

  const stored: Record<string, unknown> = await area.get(null);
  const protect = new Set(active);
  const running = stored[ACTIVE_CAPTURE_KEY];
  if (typeof running === 'string' && running) protect.add(running);
  for (const id of await openEditorSessionIds()) protect.add(id);

  const { quota } = await estimateStorage();
  const deleted = await pruneSessions({ maxBytes: retentionBudget(quota), protect, now });
  await removeStaleMirrors(stored, protect, new Set(deleted), now);
  return { deleted };
}

/** Session ids of the editor tabs open in this profile. */
async function openEditorSessionIds(): Promise<SessionId[]> {
  const runtime = browser.runtime as Partial<typeof browser.runtime>;
  if (typeof runtime.getContexts !== 'function') return [];
  let contexts: Browser.runtime.ExtensionContext[];
  try {
    contexts = await browser.runtime.getContexts({ contextTypes: ['TAB'] });
  } catch (err) {
    // Only expected where the API isn't implemented (unit tests' fake browser).
    console.warn('[pagesnap] retention: runtime.getContexts failed', err);
    return [];
  }
  const base = browser.runtime.getURL(EDITOR_PATH);
  const ids: SessionId[] = [];
  for (const c of contexts) {
    const url = c.documentUrl;
    if (!url?.startsWith(base)) continue;
    const id = parseEditorHash(new URL(url).hash);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Remove `session-status:<id>` and `capture-timings:<id>` keys of deleted sessions, of sessions
 * that no longer exist, and of finished sessions last written more than `MIRROR_TTL_MS` ago.
 * Keys of protected and running captures, and every other key, are left alone.
 */
async function removeStaleMirrors(
  stored: Record<string, unknown>,
  protect: ReadonlySet<SessionId>,
  deleted: ReadonlySet<SessionId>,
  now: number,
): Promise<void> {
  const prefixes = [sessionStatusKey(''), timingsKey('')];
  const byId = new Map<SessionId, string[]>();
  for (const key of Object.keys(stored)) {
    const prefix = prefixes.find((p) => key.startsWith(p));
    if (!prefix) continue;
    const id = key.slice(prefix.length);
    if (!id || protect.has(id)) continue;
    byId.set(id, [...(byId.get(id) ?? []), key]);
  }

  const doomed: string[] = [];
  for (const [id, keys] of byId) {
    if (deleted.has(id) || (await isStale(id, stored[sessionStatusKey(id)], now))) {
      doomed.push(...keys);
    }
  }
  if (doomed.length > 0) await browser.storage.session.remove(doomed);
}

async function isStale(id: SessionId, mirror: unknown, now: number): Promise<boolean> {
  const session = await getSession(id);
  if (session) return session.status !== 'capturing' && now - session.updatedAt > MIRROR_TTL_MS;
  // No record: the session was deleted, or its first write failed. Keep a mirror that still
  // looks like a live capture.
  const snap = mirror as Partial<SessionStatusSnapshot> | undefined;
  const live =
    snap?.status === 'capturing' &&
    typeof snap.updatedAt === 'number' &&
    now - snap.updatedAt < STALE_CAPTURE_MS;
  return !live;
}
