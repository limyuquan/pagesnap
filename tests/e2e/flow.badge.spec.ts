/**
 * Toolbar badge: graphite progress with white text while capturing, cleared when the editor opens;
 * a red `!` on the captured tab when a capture fails or is cut short behind the user's back,
 * until its editor tab is brought to the front.
 */
import type { Worker } from '@playwright/test';
import type {} from '@/capture/testHook';
import { waitForFinal, waitForSlices } from './capture.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';

test.use({ dpr: 1 });

function badge(sw: Worker, tabId: number) {
  return sw.evaluate(async (t) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [text, bg, fg] = await Promise.all([
      chrome.action.getBadgeText({ tabId: t }),
      chrome.action.getBadgeBackgroundColor({ tabId: t }),
      chrome.action.getBadgeTextColor({ tabId: t }),
    ]);
    return { text, bg: [...bg], fg: [...fg] };
  }, tabId);
}

function clickAsync(sw: Worker, tabId: number) {
  return sw.evaluate((id) => {
    void globalThis.__pagesnap?.clickAction(id).catch(() => {});
  }, tabId);
}

test('progress badge is graphite with white text, and clears when the editor opens', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await clickAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 1);
  const during = await badge(serviceWorker, tabId);
  expect(during.text).toMatch(/^(…|\d{1,2}%)$/);
  expect(during.bg).toEqual([0x23, 0x23, 0x27, 255]);
  expect(during.fg).toEqual([255, 255, 255, 255]);
  expect((await waitForFinal(serviceWorker, id)).status).toBe('ready');
  await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('');
});

test('a capture cut short in the background leaves a red ! until its editor is in front', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  const editorOpened = context.waitForEvent('page', {
    predicate: (p) => p.url().startsWith(`chrome-extension://${extensionId}/editor.html`),
  });
  await clickAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  const other = await context.newPage();
  await other.bringToFront();
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('partial');
  expect(s.error?.code).toBe('TAB_CHANGED');
  const editor = await editorOpened;
  await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('!');
  const failed = await badge(serviceWorker, tabId);
  expect(failed.bg).toEqual([0xff, 0x3b, 0x30, 255]);
  expect(failed.fg).toEqual([255, 255, 255, 255]);
  // Going back to the page alone keeps it; opening the editor (where the reason is) clears it.
  await page.bringToFront();
  expect((await badge(serviceWorker, tabId)).text).toBe('!');
  await editor.bringToFront();
  await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('');
});
