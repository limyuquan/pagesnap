/** Capture progress on the toolbar badge: always on, with or without the popup open. */
import { browser } from 'wxt/browser';

/** The icon's graphite tile, so the progress badge reads as part of the icon. */
export const BADGE_PROGRESS = '#232327';
/** Same red as the default ink: something went wrong. */
export const BADGE_FAILED = '#FF3B30';
export const BADGE_TEXT = '#FFFFFF';

export async function setBadge(tabId: number, text: string, color = BADGE_PROGRESS): Promise<void> {
  try {
    await Promise.all([
      browser.action.setBadgeBackgroundColor({ tabId, color }),
      browser.action.setBadgeTextColor?.({ tabId, color: BADGE_TEXT }),
      browser.action.setBadgeText({ tabId, text }),
    ]);
  } catch {
    // The tab may be gone.
  }
}

/** `done / total` as a short percentage, never 100% before the capture has finished. */
export function progressText(done: number, total: number): string {
  if (total <= 0) return '…';
  return `${Math.min(99, Math.floor((done / total) * 100))}%`;
}

export function clearBadge(tabId: number): Promise<void> {
  return setBadge(tabId, '');
}

/** A red `!` on the captured tab: the capture failed or stopped early. */
export function failedBadge(tabId: number): Promise<void> {
  return setBadge(tabId, '!', BADGE_FAILED);
}
