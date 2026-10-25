/**
 * The capture popup (toolbar click / Alt+Shift+P / context menu). Two ways to drive it:
 * - Chrome's real action popup, `chrome.action.openPopup()` from the SW. Playwright can't see it
 *   as a page, so these tests watch it through `runtime.getContexts` and the SW hooks;
 * - `popup.html?tab=<id>` in its own small window (`popupFor`), which Playwright can drive (Esc,
 *   DOM). Its own window, so the captured tab stays the active tab of its window.
 */
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type {} from '@/capture/testHook';
import { getSession, pageState, waitForFinal, waitForSlices } from './capture.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';

test.use({ dpr: 1 });

async function popupFor(
  context: BrowserContext,
  sw: Worker,
  extensionId: string,
  tabId: number,
): Promise<Page> {
  const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('popup.html') });
  await sw.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    await chrome.windows.create({ url, type: 'popup', width: 360, height: 260, focused: false });
  }, `chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  const page = await opened;
  await page.waitForLoadState('domcontentloaded');
  return page;
}

const setFlags = (sw: Worker, flags: Record<string, unknown>) =>
  sw.evaluate((f) => globalThis.__pagesnapCapture?.setFlags(f), flags);

const phase = (p: Page) => p.evaluate(() => document.documentElement.dataset.phase ?? '');
const pct = (p: Page) => p.evaluate(() => Number(document.documentElement.dataset.pct ?? 0));
const popupCount = (sw: Worker) =>
  sw.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return (await chrome.runtime.getContexts({ contextTypes: ['POPUP' as never] })).length;
  });
const openRealPopup = (sw: Worker) =>
  sw.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    await chrome.action.openPopup();
  });
const isEditor = (id: string) => (p: Page) =>
  p.url().startsWith(`chrome-extension://${id}/editor.html`);

test.afterEach(async ({ serviceWorker }) => {
  await setFlags(serviceWorker, {
    stepDelayMs: 0,
    finalizeDelayMs: 0,
    forceRestricted: false,
    failVisibleShot: false,
  }).catch(() => {});
});

test('the popup shows the capture developing: bar, percentage, thumbnails, slice line', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { stepDelayMs: 250 });
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  // Opening the popup started the capture of its tab.
  await expect
    .poll(() => serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.activeId()))
    .toBeTruthy();
  await expect(pop.locator('#title')).toHaveText('Fixture: bands');
  await expect(pop.locator('#host')).toHaveText('127.0.0.1:4321');

  const samples: { pct: number; bar: number; thumbs: number; meta: string }[] = [];
  for (let i = 0; i < 40 && (await phase(pop)) !== 'stitching'; i++) {
    samples.push(
      await pop.evaluate(() => ({
        pct: Number(document.documentElement.dataset.pct ?? 0),
        bar: new DOMMatrix(
          getComputedStyle(document.getElementById('fill') as HTMLElement).transform,
        ).a,
        thumbs: Number(document.documentElement.dataset.thumbs ?? 0),
        meta: document.getElementById('meta')?.textContent ?? '',
      })),
    );
    if (samples.length > 3 && (samples.at(-1)?.pct ?? 0) >= 70) break;
    await pop.waitForTimeout(150);
  }
  const pcts = samples.map((s) => s.pct);
  // It advances, never jumps backwards, and the bar agrees with the number.
  expect(Math.max(...pcts)).toBeGreaterThanOrEqual(50);
  expect(new Set(pcts).size).toBeGreaterThan(4);
  for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1] ?? 0);
  for (const s of samples) expect(Math.abs(s.bar * 100 - s.pct)).toBeLessThan(2);
  // Real slices, decoded at thumbnail size from IndexedDB.
  expect(Math.max(...samples.map((s) => s.thumbs))).toBeGreaterThanOrEqual(3);
  const canvas = await pop.evaluate(() => {
    const c = document.querySelector('#film canvas') as HTMLCanvasElement | null;
    return c ? { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width } : null;
  });
  expect(canvas?.w).toBeLessThanOrEqual(2 * 52 + 1);
  expect(canvas?.cssW).toBeCloseTo(52, 0);
  expect(samples.some((s) => /^Slice \d+ of \d+/.test(s.meta))).toBe(true);
  expect(samples.some((s) => /about \d+ s left/.test(s.meta))).toBe(true);
});

test('Esc in the popup stops the capture, says so, restores the page and opens what was captured', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('sticky-header');
  await page.evaluate(() => scrollTo(0, 321));
  const before = await pageState(page);
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { stepDelayMs: 200 });
  const editorOpened = context.waitForEvent('page', { predicate: isEditor(extensionId) });
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  await pop.keyboard.press('Escape');
  await expect(pop.locator('#phase')).toHaveText('Stopped · opening what was captured');
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('partial');
  expect(s.error?.code).toBe('ABORTED_BY_USER');
  expect(s.error?.message).toBe('You pressed Esc, so the capture stopped early.');
  expect((await editorOpened).url()).toContain(`#s=${id}`);
  await page.bringToFront();
  await expect.poll(() => pageState(page)).toEqual(before);
});

test('the Stop button stops the capture too', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { stepDelayMs: 200 });
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  const id = await waitForSlices(serviceWorker, 1);
  await pop.getByRole('button', { name: 'Stop capture' }).click();
  const s = await waitForFinal(serviceWorker, id);
  expect(s.error?.message).toBe('You pressed Stop, so the capture stopped early.');
});

test('closing the popup mid-capture does not cancel it', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  await pop.close();
  await expect
    .poll(() => serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.viewers()))
    .toBe(0);
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('ready');
  expect(s.css.h).toBe(8000);
});

test('a second click during a capture joins it; it does not cancel', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { stepDelayMs: 150 });
  const first = serviceWorker.evaluate((t) => globalThis.__pagesnap?.clickAction(t) ?? null, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  // Long after the old 800 ms double-click window.
  await page.waitForTimeout(900);
  const second = await serviceWorker.evaluate(
    (t) => globalThis.__pagesnap?.clickAction(t) ?? null,
    tabId,
  );
  expect(second).toBe(id);
  // The reopened popup shows the live capture, with what was already stored.
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  await expect(pop.locator('html')).toHaveAttribute('data-phase', /capturing|stitching|opening/);
  await expect
    .poll(() => pop.evaluate(() => Number(document.documentElement.dataset.thumbs)))
    .toBeGreaterThanOrEqual(2);
  expect(await pct(pop)).toBeGreaterThan(0);
  expect(await first).toBe(id);
  expect((await getSession(serviceWorker, id)).status).toBe('ready');
});

test('a page that cannot be captured at all says why in the popup (no editor)', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('short');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { forceRestricted: true, failVisibleShot: true });
  let editors = 0;
  context.on('page', (p) => {
    if (isEditor(extensionId)(p)) editors++;
  });
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  await expect(pop.locator('html')).toHaveAttribute('data-phase', 'failed');
  await expect(pop.locator('#phase')).toHaveText('Can’t capture this page');
  await expect(pop.locator('#msg')).toContainText('didn’t allow a screenshot');
  await page.waitForTimeout(800);
  expect(editors).toBe(0);
  expect(pop.isClosed()).toBe(false);
  // Esc closes it.
  // (The page can close while the key is still being dispatched.)
  await Promise.all([pop.waitForEvent('close'), pop.keyboard.press('Escape').catch(() => {})]);
});

test('the visible-area fallback is explained before the editor opens', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { forceRestricted: true });
  const editorOpened = context.waitForEvent('page', { predicate: isEditor(extensionId) });
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  await expect(pop.locator('#phase')).toHaveText('Only the visible area');
  await expect(pop.locator('#msg')).toContainText('only the visible area was captured');
  await editorOpened;
});

test('Chrome’s real popup: the capture runs under it untouched, and it closes when the editor opens', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  await page.evaluate(() => scrollTo(0, 777));
  const before = await pageState(page);
  const editorOpened = context.waitForEvent('page', {
    predicate: isEditor(extensionId),
    timeout: 60_000,
  });
  await openRealPopup(serviceWorker);
  // The popup asked for its tab: the capture runs with the popup open (focus moved to it).
  await expect
    .poll(() => serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.activeId()))
    .toBeTruthy();
  const id = (await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.activeId())) ?? '';
  await waitForSlices(serviceWorker, 3);
  expect(await popupCount(serviceWorker)).toBe(1);
  expect(await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.viewers())).toBe(1);
  const editor = await editorOpened;
  expect(editor.url()).toContain(`#s=${id}`);
  const s = await getSession(serviceWorker, id);
  expect(s.status).toBe('ready');
  expect(s.error).toBeNull();
  expect(s.css.h).toBe(8000);
  // Opening the popup paused nothing: the cadence stayed at Chrome's limit.
  const timings = await serviceWorker.evaluate(
    (sid) => globalThis.__pagesnapCapture?.timings(sid),
    id,
  );
  const gaps = [...(timings?.frameGapsMs ?? [])].sort((a, b) => a - b);
  expect(gaps[gaps.length >> 1]).toBeLessThan(620);
  await expect.poll(() => popupCount(serviceWorker)).toBe(0);
  await page.bringToFront();
  expect(await pageState(page)).toEqual(before);
  // It painted (ms from its navigation start). The ~50 ms budget is measured standalone (about
  // 40 ms median); under a loaded full suite only a gross regression should fail here.
  const perf = await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.popupPerf());
  console.log(`[popup paint] ${JSON.stringify(perf)}`);
  expect(perf?.fcp ?? 0).toBeGreaterThan(0);
  expect(perf?.fcp ?? 9999).toBeLessThan(1500);
});

test('the popup stays tiny: no React, a few KB of script and CSS', async ({ serviceWorker }) => {
  const sizes = await serviceWorker.evaluate(async () => {
    const html = await (await fetch('/popup.html')).text();
    const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1] ?? '');
    const files = await Promise.all(
      urls.map(async (u) => ({ u, text: await (await fetch(u)).text() })),
    );
    return files.map((f) => ({
      url: f.u,
      bytes: f.text.length,
      react: /react\.(production|development)|__SECRET_INTERNALS|createRoot/.test(f.text),
    }));
  });
  console.log(`[popup bundle] ${JSON.stringify(sizes)}`);
  expect(sizes.length).toBeGreaterThanOrEqual(2);
  expect(sizes.some((f) => f.react)).toBe(false);
  expect(sizes.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(40_000);
});

test('the test-tab popup closes itself when the editor opens', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('short');
  const tabId = await pagesnap.tabIdOf(page);
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  const closed = pop.waitForEvent('close');
  await context.waitForEvent('page', { predicate: isEditor(extensionId) });
  await closed;
});

test('the stitching phase shows a full bar', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('short');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { finalizeDelayMs: 1500 });
  const pop = await popupFor(context, serviceWorker, extensionId, tabId);
  await expect(pop.locator('html')).toHaveAttribute('data-phase', 'stitching');
  await expect(pop.locator('#phase')).toHaveText('Stitching…');
  await expect.poll(() => pct(pop)).toBe(100);
});

test('the context menu path opens the popup, which starts the capture', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('short');
  await page.bringToFront();
  const editorOpened = context.waitForEvent('page', { predicate: isEditor(extensionId) });
  // Same code as `contextMenus.onClicked` (a real menu click can't be synthesised).
  await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.action.openPopup({ windowId: tab?.windowId ?? -1 });
  });
  expect(await popupCount(serviceWorker)).toBe(1);
  await editorOpened;
  await expect.poll(() => popupCount(serviceWorker)).toBe(0);
});
