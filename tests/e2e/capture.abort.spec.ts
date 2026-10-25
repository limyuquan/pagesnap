import type {} from '@/capture/testHook';
import {
  captureFull,
  getSession,
  pageState,
  startCaptureAsync,
  waitForFinal,
  waitForSlices,
} from './capture.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';

test.use({ dpr: 1 });

test('a second capture request while one runs returns the running id', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await startCaptureAsync(serviceWorker, tabId);
  const running = await waitForSlices(serviceWorker, 1);
  const second = await serviceWorker.evaluate(
    (id) => globalThis.__pagesnap?.startCapture(id),
    tabId,
  );
  expect(second).toBe(running);
  // Progress is shown on the toolbar badge, and cleared at the end.
  const badge = () =>
    serviceWorker.evaluate((t) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      return chrome.action.getBadgeText({ tabId: t });
    }, tabId);
  expect(await badge()).toMatch(/^\d{1,2}%$/);
  const s = await waitForFinal(serviceWorker, running);
  expect(s.status).toBe('ready');
  await expect.poll(badge).toBe('');
});

test('switching tabs mid-capture stops early with a partial session and restores the page', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('sticky-header');
  await page.evaluate(() => scrollTo(0, 321));
  const before = await pageState(page);
  const tabId = await pagesnap.tabIdOf(page);
  await startCaptureAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  const other = await context.newPage();
  await other.bringToFront();
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('partial');
  expect(s.error?.code).toBe('TAB_CHANGED');
  expect(s.error?.message).toMatch(/switched tabs|hidden/);
  expect(s.slices.length).toBeGreaterThanOrEqual(2);
  expect(s.layout.parts.length).toBe(s.slices.length);
  expect(s.image.h).toBe(Math.round(s.css.h * s.dpr));
  await page.bringToFront();
  await expect.poll(() => pageState(page)).toEqual(before);
});

test('navigating mid-capture stops early', async ({ pagesnap, serviceWorker }) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await startCaptureAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  await page.goto(pagesnap.fixtureUrl('short'));
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('partial');
  expect(s.error?.code).toBe('TAB_CHANGED');
});

test('Esc in the page cancels; the editor still opens with what was captured', async ({
  context,
  extensionId,
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('fixed-footer-and-chat-bubble');
  const before = await pageState(page);
  const tabId = await pagesnap.tabIdOf(page);
  const editor = context.waitForEvent('page', {
    predicate: (p) => p.url().startsWith(`chrome-extension://${extensionId}/editor.html`),
  });
  await startCaptureAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  await page.keyboard.press('Escape');
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('partial');
  expect(s.error?.code).toBe('ABORTED_BY_USER');
  expect((await editor).url()).toContain(`#s=${id}`);
  expect(await pageState(page)).toEqual(before);
});

test('a toolbar click during a capture cancels it', async ({ pagesnap, serviceWorker }) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await startCaptureAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  expect(await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.cancel())).toBe(true);
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('partial');
  expect(s.error?.code).toBe('ABORTED_BY_USER');
});

test('a page the agent cannot script falls back to the visible area', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('bands');
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.forceRestricted(true));
  try {
    const { session } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    expect(session.mode).toBe('visible');
    expect(session.slices).toHaveLength(1);
    expect(session.warnings.map((w) => w.code)).toEqual(['VISIBLE_ONLY']);
    expect(session.warnings[0]?.message).toMatch(/only the visible area/);
    expect(session.css).toEqual(view);
    expect(session.dpr).toBe(1);
  } finally {
    await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.forceRestricted(false));
  }
});

test('a page Chrome won’t let us capture at all ends in a readable error', async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto('chrome://version');
  await page.bringToFront();
  // chrome:// URLs aren't visible to us, so take the active tab.
  const tabId = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? -1;
  });
  const id = await serviceWorker.evaluate((t) => globalThis.__pagesnap?.startCapture(t), tabId);
  if (!id) throw new Error('no id');
  const s = await getSession(serviceWorker, id);
  console.log(
    `[restricted] ${JSON.stringify({ status: s.status, error: s.error, warnings: s.warnings })}`,
  );
  if (s.status === 'error') {
    expect(s.error?.code).toBe('RESTRICTED');
    expect(s.error?.message).toMatch(/Chrome doesn’t let extensions/);
  } else {
    // With an activeTab grant Chrome allows a visible capture of chrome:// pages.
    expect(s.mode).toBe('visible');
    expect(s.warnings[0]?.code).toBe('VISIBLE_ONLY');
  }
});
