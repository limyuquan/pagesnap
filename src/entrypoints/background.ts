import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { installAgentListener } from '@/capture/agentLink';
import {
  activeCaptureId,
  activeCaptureTabId,
  cancelCapture,
  captureJustStarted,
  queueCapture,
  recoverAllInterrupted,
  recoverInterrupted,
  recoverSession,
  startCapture,
} from '@/capture/orchestrator';
import { runRetention } from '@/capture/retention';
import { captureTestHook } from '@/capture/testHook';
import type { RecoverRequest } from '@/shared/protocol';
import { seedSyntheticSession } from '@/shared/testing/synthetic';
import type { SessionId } from '@/shared/types';

const MENU_CAPTURE = 'capture-full-page';

/**
 * User trigger, per tab:
 * - no capture running: start one;
 * - a capture of this tab is running: a second click within its first moments is a double-click
 *   (ignored), later it cancels;
 * - a capture of another tab (or window) is running: queue this one to start when it ends (a tab
 *   switch in the same window stops the running one anyway).
 */
function trigger(tab: Parameters<typeof startCapture>[0]): Promise<SessionId | null> {
  const runningTab = activeCaptureTabId();
  const failed = (err: unknown) => {
    console.error('[pagesnap] capture failed', err);
    return null;
  };
  if (runningTab != null && runningTab === tab.id) {
    if (captureJustStarted(800, tab.id)) return Promise.resolve(null);
    cancelCapture();
    return Promise.resolve(null);
  }
  if (runningTab != null) return queueCapture(tab).catch(failed);
  return startCapture(tab).catch(failed);
}

/**
 * The toolbar button's listener. The `_execute_action` command (Alt+Shift+P) is dispatched by
 * Chrome as this same `action.onClicked` event, so both land here. The e2e hook calls it too.
 */
function onActionClicked(tab: Parameters<typeof startCapture>[0]): Promise<SessionId | null> {
  return trigger(tab);
}

export default defineBackground(() => {
  installAgentListener();
  void (async () => {
    await recoverInterrupted();
    await runRetention({ activeId: activeCaptureId(), reason: 'startup' });
  })().catch((err: unknown) => console.warn('[pagesnap] start-up recovery failed', err));

  // An editor waiting on a capture whose heartbeat stopped. The message itself wakes a
  // terminated SW (which then recovers above); a live SW recovers that session now.
  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    const req = msg as Partial<RecoverRequest> | null;
    if (req?.t !== 'pagesnap/recover' || typeof req.id !== 'string') return;
    if (sender.id !== browser.runtime.id) return;
    return recoverSession(req.id).then(
      () => true,
      () => false,
    );
  });

  // Toolbar click and the `_execute_action` shortcut (Alt+Shift+P) both land here (no popup).
  browser.action.onClicked.addListener((tab) => void onActionClicked(tab));

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_CAPTURE,
      title: 'Capture full page',
      contexts: ['page', 'action'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_CAPTURE || !tab) return;
    void trigger(tab);
  });

  browser.runtime.onStartup.addListener(() => {
    void (async () => {
      await recoverAllInterrupted();
      await runRetention({ activeId: activeCaptureId(), reason: 'browser-start', force: true });
    })().catch((err: unknown) => console.warn('[pagesnap] startup cleanup failed', err));
  });

  // Inline the MODE check (not IS_E2E) so production builds drop this branch and its imports.
  if (import.meta.env.MODE === 'e2e') {
    globalThis.__pagesnap = {
      startCapture: async (tabId) => startCapture(await browser.tabs.get(tabId)),
      clickAction: async (tabId) => onActionClicked(await browser.tabs.get(tabId)),
      seedSyntheticSession,
    };
    globalThis.__pagesnapCapture = captureTestHook;
  }
});
