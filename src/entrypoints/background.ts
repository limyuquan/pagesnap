import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { installAgentListener } from '@/capture/agentLink';
import {
  cancelCapture,
  captureJustStarted,
  recoverAllInterrupted,
  recoverInterrupted,
  startCapture,
} from '@/capture/orchestrator';
import { captureTestHook } from '@/capture/testHook';
import { pruneSessions } from '@/shared/db';
import { getSettings } from '@/shared/settings';
import { seedSyntheticSession } from '@/shared/testing/synthetic';

const MENU_CAPTURE = 'capture-full-page';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * User trigger: start a capture, or cancel the running one. A second click within the first
 * moments is treated as a double-click and ignored.
 */
function trigger(tab: Parameters<typeof startCapture>[0]): void {
  if (captureJustStarted()) return;
  if (cancelCapture()) return;
  startCapture(tab).catch((err: unknown) => console.error('[pagesnap] capture failed', err));
}

export default defineBackground(() => {
  installAgentListener();
  void recoverInterrupted().catch(() => {});

  // Toolbar click and the `_execute_action` shortcut (Alt+Shift+P) both land here (no popup).
  browser.action.onClicked.addListener((tab) => trigger(tab));

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_CAPTURE,
      title: 'Capture full page',
      contexts: ['page', 'action'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_CAPTURE || !tab) return;
    trigger(tab);
  });

  browser.runtime.onStartup.addListener(() => {
    void (async () => {
      await recoverAllInterrupted();
      const { storage } = await getSettings();
      await pruneSessions({ keep: storage.keepSessions, maxAgeMs: storage.maxAgeDays * DAY_MS });
    })().catch((err: unknown) => console.warn('[pagesnap] startup cleanup failed', err));
  });

  // Inline the MODE check (not IS_E2E) so production builds drop this branch and its imports.
  if (import.meta.env.MODE === 'e2e') {
    globalThis.__pagesnap = {
      startCapture: async (tabId) => startCapture(await browser.tabs.get(tabId)),
      seedSyntheticSession,
    };
    globalThis.__pagesnapCapture = captureTestHook;
  }
});
