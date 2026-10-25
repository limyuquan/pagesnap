/**
 * The options page's view of stored captures: how much they take, and "delete all". Uses the
 * capture side's `getStorageUsage` / `deleteAllSessions` (CONTRACTS §8, F1) and falls back to the
 * older public helpers if a build doesn't have them yet.
 */
import * as db from '@/shared/db';

export interface Usage {
  /** Stored captures. */
  sessions: number;
  /** Bytes they take on this device (best estimate), or `null` if unknown. */
  bytes: number | null;
}

type F1Db = {
  getStorageUsage?: () => Promise<{
    sessions: number;
    bytes: number;
    usage: number | null;
  }>;
  deleteAllSessions?: () => Promise<number>;
};
const f1 = db as unknown as F1Db;

export async function readUsage(): Promise<Usage> {
  if (f1.getStorageUsage) {
    const u = await f1.getStorageUsage();
    // `usage` covers the whole extension origin (IndexedDB and all); slices are nearly all of it.
    return { sessions: u.sessions, bytes: u.usage ?? u.bytes ?? null };
  }
  const list = await db.listSessions(10_000);
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  return { sessions: list.length, bytes: est?.usage ?? null };
}

/** Deletes every capture except one still running. Resolves with how many went. */
export async function deleteAll(): Promise<number> {
  if (f1.deleteAllSessions) return f1.deleteAllSessions();
  const list = await db.listSessions(10_000);
  let n = 0;
  for (const s of list) {
    if (s.status === 'capturing') continue;
    await db.deleteSession(s.id);
    n++;
  }
  return n;
}

const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `840 KB`, `3.2 MB`, `312 MB`, `1.4 GB`. */
export function formatBytes(n: number): string {
  if (n < 1e6) return `${nf0.format(Math.max(1, n / 1e3))} KB`;
  if (n < 1e9) return `${(n < 1e7 ? nf1 : nf0).format(n / 1e6)} MB`;
  return `${nf1.format(n / 1e9)} GB`;
}
