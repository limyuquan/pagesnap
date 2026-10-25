import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { installAgentListener } from '@/capture/agentLink';
import {
  activeCaptureId,
  activeCaptureTabId,
  cancelCapture,
  cancelQueued,
  queueCapture,
  recoverAllInterrupted,
  recoverInterrupted,
  recoverSession,
  startCapture,
} from '@/capture/orchestrator';
import { hasViewer, installPopupHub } from '@/capture/progress';
import { runRetention } from '@/capture/retention';
import { captureTestHook } from '@/capture/testHook';
import type { RecoverRequest } from '@/shared/protocol';
import { seedSyntheticSession } from '@/shared/testing/synthetic';
import type { SessionId } from '@/shared/types';

const MENU_CAPTURE = 'capture-full-page';

/** When each tab's capture was last requested (`Date.now()`), see `fromContextMenu`. */
const requestedAt = new Map<number, number>();

/**
 * Every trigger lands here: the popup (toolbar click and Alt+Shift+P open it, and it asks for
 * its tab), the context menu, and the e2e `clickAction` hook.
 * - no capture running: start one;
 * - a capture of this tab is running: join it (resolves with its id). Asking again never
 *   cancels: stopping is an explicit Esc or Stop in the popup;
 * - a capture of another tab (or window) is running: queue this one to start when it ends (a tab
 *   switch in the same window stops the running one anyway).
 */
function requestCapture(tab: Parameters<typeof startCapture>[0]): Promise<SessionId | null> {
  const failed = (err: unknown) => {
    console.error('[pagesnap] capture failed', err);
    return null;
  };
  const runningTab = activeCaptureTabId();
  if (runningTab != null && runningTab === tab.id) return Promise.resolve(activeCaptureId());
  if (tab.id != null) requestedAt.set(tab.id, Date.now());
  if (runningTab != null) return queueCapture(tab).catch(failed);
  return startCapture(tab).catch(failed);
}

/** Esc or Stop in the popup showing `tabId`. */
function cancelFor(tabId: number, how: 'esc' | 'button'): void {
  if (activeCaptureTabId() === tabId) cancelCapture(how);
  else cancelQueued(tabId);
}

/**
 * "Capture full page" in the context menu: show the popup where Chrome allows it
 * (`action.openPopup`, Chrome 127+); the popup then starts the capture like a toolbar click.
 * Without a popup (older Chrome, no focused window) start right away, with the badge only. If a
 * popup opened but never asked for its tab, start anyway.
 */
async function fromContextMenu(tab: Parameters<typeof startCapture>[0]): Promise<void> {
  const since = Date.now();
  const opened = await browser.action.openPopup?.({ windowId: tab.windowId }).then(
    () => true,
    () => false,
  );
  if (!opened || tab.id == null) {
    await requestCapture(tab);
    return;
  }
  const tabId = tab.id;
  setTimeout(() => {
    const asked = (requestedAt.get(tabId) ?? 0) >= since;
    if (!asked && !hasViewer(tabId) && activeCaptureTabId() !== tabId) void requestCapture(tab);
  }, 1500);
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

  // The toolbar button and the `_execute_action` shortcut (Alt+Shift+P) open the popup, which
  // asks for its tab's capture here. Closing the popup never cancels.
  installPopupHub({
    open: (tabId) => {
      void browser.tabs.get(tabId).then(requestCapture, (err: unknown) => {
        console.warn('[pagesnap] popup tab is gone', err);
      });
    },
    cancel: cancelFor,
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
    void fromContextMenu(tab);
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
      // What the popup does when it opens (a toolbar click or Alt+Shift+P), without the popup.
      clickAction: async (tabId) => requestCapture(await browser.tabs.get(tabId)),
      seedSyntheticSession,
    };
    globalThis.__pagesnapCapture = captureTestHook;
  }
});
