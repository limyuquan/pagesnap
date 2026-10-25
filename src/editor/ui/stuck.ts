/**
 * Watchdogs for the two states that could otherwise spin forever (correctness review #6):
 *
 * - **Capturing, no sign of life.** The running capture refreshes its status mirror every 5 s
 *   (a heartbeat, also while paused for a hidden tab; CONTRACTS §8, F1). No update for
 *   `STALL_MS` means the service worker died: say so, with a retry hint. The shared hand-off
 *   then wakes the SW at 20 s, which marks the capture interrupted and the editor moves on.
 * - **Opening, never ready.** If the editor is still opening after `OPEN_TIMEOUT_MS` of the tab
 *   being visible, show an error with a reload action instead of an endless spinner. Hidden time
 *   doesn't count: a background tab doesn't paint, so it can't become ready.
 *
 * e2e builds can shorten both through `window.__pagesnapUiTiming` (set by an init script).
 */
import { useEffect, useState } from 'react';
import { IS_E2E } from '@/shared/e2e';

export const STALL_MS = 15_000;
export const OPEN_TIMEOUT_MS = 20_000;

declare global {
  interface Window {
    __pagesnapUiTiming?: { stallMs?: number; openMs?: number };
  }
}

function timing(key: 'stallMs' | 'openMs', fallback: number): number {
  const v = IS_E2E ? window.__pagesnapUiTiming?.[key] : undefined;
  return typeof v === 'number' && v > 0 ? v : fallback;
}

/** True once `lastSign` (ms epoch of the last sign of life) is older than the stall limit. */
export function useCaptureStalled(active: boolean, lastSign: number | undefined): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!active) return;
    const limit = timing('stallMs', STALL_MS);
    // Missing or future timestamps count from now.
    const since = lastSign && lastSign <= Date.now() ? lastSign : Date.now();
    const wait = since + limit - Date.now();
    if (wait <= 0) {
      setStalled(true);
      return;
    }
    const t = window.setTimeout(() => setStalled(true), wait);
    return () => window.clearTimeout(t);
  }, [active, lastSign]);
  return stalled;
}

/** True once `active` has held for the open timeout while the tab was visible. */
export function useOpenTimedOut(active: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (!active) return;
    const limit = timing('openMs', OPEN_TIMEOUT_MS);
    let t = 0;
    const arm = () => {
      window.clearTimeout(t);
      if (!document.hidden) t = window.setTimeout(() => setTimedOut(true), limit);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [active]);
  return timedOut;
}
