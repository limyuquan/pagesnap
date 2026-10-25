/**
 * Per-capture timing report (owner: A). Kept in `chrome.storage.session` under an A-private key
 * (not part of the session record, so no contract change) and logged to the SW console.
 */
import { browser } from 'wxt/browser';
import type { SessionId, SessionStatus } from '@/shared/types';

export interface CaptureTimings {
  id: SessionId;
  url: string;
  startedAt: number;
  status: SessionStatus;
  slices: number;
  /** Inject + prepare (stylesheet, scan, pre-scroll, planning), ms. */
  prepareMs: number;
  /** First step to last slice, ms. */
  captureMs: number;
  /** Layout + final session write, ms. */
  finalizeMs: number;
  /** startCapture → editor tab created, ms. */
  totalMs: number;
  /** Gaps between consecutive captureVisibleTab calls, ms. */
  frameGapsMs: number[];
  /** Slices taken again because the page moved while they were shot. */
  retakes?: number;
}

const key = (id: SessionId) => `capture-timings:${id}`;

export async function saveTimings(t: CaptureTimings): Promise<void> {
  try {
    await browser.storage.session.set({ [key(t.id)]: t });
  } catch {
    // Timing reports are best effort.
  }
}

export async function getTimings(id: SessionId): Promise<CaptureTimings | null> {
  const got = await browser.storage.session.get(key(id));
  return (got[key(id)] as CaptureTimings | undefined) ?? null;
}
