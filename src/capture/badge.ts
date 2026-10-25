/** Capture progress on the toolbar badge: the only feedback, since nothing is drawn in the page. */
import { browser } from 'wxt/browser';

const BLUE = '#0A84FF';

export async function setBadge(tabId: number, text: string, color = BLUE): Promise<void> {
  try {
    await Promise.all([
      browser.action.setBadgeBackgroundColor({ tabId, color }),
      browser.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' }),
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
