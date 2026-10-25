import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { startCapture } from '@/capture/orchestrator';
import { seedSyntheticSession } from '@/shared/testing/synthetic';

const MENU_CAPTURE = 'capture-full-page';

export default defineBackground(() => {
  // Toolbar click and the `_execute_action` shortcut (Alt+Shift+P) both land here (no popup).
  browser.action.onClicked.addListener((tab) => {
    startCapture(tab).catch((err: unknown) => console.error('[pagesnap] capture failed', err));
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_CAPTURE,
      title: 'Capture full page',
      contexts: ['page', 'action'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_CAPTURE || !tab) return;
    startCapture(tab).catch((err: unknown) => console.error('[pagesnap] capture failed', err));
  });

  // Inline the MODE check (not IS_E2E) so production builds drop this branch and its imports.
  if (import.meta.env.MODE === 'e2e') {
    globalThis.__pagesnap = {
      startCapture: async (tabId) => startCapture(await browser.tabs.get(tabId)),
      seedSyntheticSession,
    };
  }
});
