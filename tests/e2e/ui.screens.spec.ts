/**
 * Screenshots of the editor UI states for design review (owner: C). Opt-in, since they write files
 * and take a while:
 *
 *   PAGESNAP_UI_SHOTS=1 PAGESNAP_E2E_ID=c pnpm exec playwright test ui.screens
 *
 * Output: /tmp/pagesnap-qa/ui-v2/<state>-<w>x<h>[-light].png (`PAGESNAP_UI_SHOTS_DIR` overrides). `PAGESNAP_UI_SHOTS_DPR` sets the device
 * scale (default 2). The window is sized so the page viewport is exactly w × h.
 */
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  lmsAnnotations,
  lmsPagePng,
  patchSession,
  seedDoc,
  seedImageSession,
  setUiState,
  uiState,
  waitReady,
} from './ui.helpers';

const OUT = process.env.PAGESNAP_UI_SHOTS_DIR ?? '/tmp/pagesnap-qa/ui-v2';
const DPR = Number(process.env.PAGESNAP_UI_SHOTS_DPR ?? 2);
const SIZES = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
];
/** Headless Chromium's window chrome height (measured by the harness: 900 → 813 viewport). */
const CHROME_H = 87;

test.skip(!process.env.PAGESNAP_UI_SHOTS, 'set PAGESNAP_UI_SHOTS=1 to write screenshots');
test.describe.configure({ mode: 'serial' });

for (const size of SIZES) {
  test.describe(`${size.w}x${size.h}`, () => {
    test.use({ dpr: DPR, windowSize: { width: size.w, height: size.h + CHROME_H } });

    const shot = async (page: Page, name: string) => {
      mkdirSync(OUT, { recursive: true });
      const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      await page.waitForTimeout(450); // let enter transitions settle
      await page.screenshot({ path: `${OUT}/${name}-${size.w}x${size.h}.png` });
      return vp;
    };

    test('editor states', async ({ context, pagesnap, serviceWorker, extensionId }) => {
      // Headless Chromium reports `light`; dark is the reference look. The scheme is set before
      // navigation because the engine reads its backdrop colour when the canvas mounts.
      const open = async (id: string, colorScheme: 'dark' | 'light' = 'dark') => {
        const p = await context.newPage();
        await p.emulateMedia({ colorScheme });
        await p.goto(`chrome-extension://${extensionId}/editor.html#s=${id}`);
        return p;
      };
      test.setTimeout(180_000);
      const lms = await lmsPagePng(pagesnap);
      const seed = async () => {
        const id = await seedImageSession(serviceWorker, pagesnap, {
          title: lms.title,
          url: lms.url,
          cssW: lms.cssW,
          dpr: DPR,
          pngBase64: lms.pngBase64,
        });
        return id;
      };

      // Ready, fresh (empty hint).
      const fresh = await seed();
      let ed = await open(fresh);
      await waitReady(ed, { force: true });
      const vp = await shot(ed, 'ready-empty');
      expect(vp).toEqual({ w: size.w, h: size.h });
      await ed.close();

      // Ready with annotations.
      const marked = await seed();
      ed = await open(marked);
      await waitReady(ed, { force: true });
      const st = await uiState(ed);
      if (st.session) {
        await seedDoc(serviceWorker, lmsAnnotations(marked, st.session.image, DPR, lms.targets));
        await ed.reload();
        await waitReady(ed, { force: true });
      }
      await shot(ed, 'ready-annotated');

      // Copy toasts, one per scope kind the engine reports (CONTRACTS §8, F2).
      const pageH = Math.round(st.session?.css.h ?? 4348);
      const cssW = lms.cssW;
      let at = Date.now();
      const copied = async (
        name: string,
        outcome: string,
        kind: string,
        top: number,
        h: number,
        tall = false,
      ) => {
        await setUiState(ed, {
          copy: {
            state: 'copied',
            request: kind === 'full' ? 'full' : 'default',
            outcome,
            size: { w: cssW, h },
            tall,
            at: at++,
            scope: {
              kind,
              mode: 'fill',
              region: { x: 0, y: top * DPR, w: cssW * DPR, h: h * DPR },
              cssTop: top,
              cssBottom: top + h,
              cssHeight: h,
              pageCssHeight: pageH,
            },
          } as never,
        });
        await shot(ed, name);
      };
      await copied('copied-from-top', 'smart', 'fromTop', 0, Math.min(2576, pageH));
      await copied('copied-around-marks', 'smart', 'aroundMarks', 900, Math.min(2576, pageH - 900));
      await copied('copied-from-here', 'viewport', 'fromHere', 1200, Math.min(2576, pageH - 1200));
      await copied('copied-full', 'full', 'full', 0, pageH, pageH > 2576);
      await setUiState(ed, {
        copy: {
          state: 'failed',
          request: 'default',
          reason: 'loading',
          message: 'Still loading',
          at: at++,
        } as never,
      });
      await shot(ed, 'copy-still-loading');
      await setUiState(ed, {
        copy: {
          state: 'failed',
          request: 'default',
          reason: 'timeout',
          message: 'TIMEOUT',
          at: at++,
        } as never,
      });
      await shot(ed, 'copy-timeout');
      await setUiState(ed, { copy: { state: 'idle' }, download: { state: 'idle' } });
      await ed.waitForTimeout(400);

      // Tool tooltip, colour popover, size menu, zoom menu.
      await ed.getByRole('button', { name: 'Highlighter' }).hover();
      await ed.waitForTimeout(700);
      await shot(ed, 'tooltip');
      await ed.mouse.move(size.w / 2, size.h / 2);
      await ed.getByTestId('color-button').click();
      await shot(ed, 'color-popover');
      await ed.keyboard.press('Escape');
      await ed.getByTestId('size-button').click();
      await shot(ed, 'size-menu');
      await ed.keyboard.press('Escape');
      await ed.getByTestId('zoom-button').click();
      await shot(ed, 'zoom-menu');
      await ed.keyboard.press('Escape');

      // Select tool, nothing selected: colour and size quiet but not blank.
      await ed.keyboard.press('v');
      await ed.mouse.move(size.w / 2, size.h / 2);
      await shot(ed, 'select-idle');
      await ed.keyboard.press('a');

      // Keyboard focus on the capture: the keys hint.
      await ed.getByTestId('copy-button').focus();
      await ed.keyboard.press('Tab');
      await shot(ed, 'stage-keys');
      await ed.close();

      // Light scheme.
      ed = await open(marked, 'light');
      await waitReady(ed, { force: true });
      await shot(ed, 'ready-annotated-light');
      await ed.close();

      // Partial capture.
      const partial = await seed();
      await patchSession(serviceWorker, partial, {
        status: 'partial',
        error: { code: 'TAB_CHANGED', message: 'The tab was switched during the capture.' },
      });
      ed = await open(partial);
      await waitReady(ed, { force: true });
      await expect(ed.getByTestId('capture-notice')).toBeVisible();
      await shot(ed, 'partial');
      await ed.close();

      // Visible-only fallback.
      const visible = await seed();
      await patchSession(serviceWorker, visible, {
        mode: 'visible',
        warnings: [{ code: 'VISIBLE_ONLY', message: 'Restricted page' }],
      });
      ed = await open(visible);
      await waitReady(ed, { force: true });
      await shot(ed, 'visible-only');
      await ed.close();

      // Error.
      const failed = await pagesnap.seedSession({ cssW: 1280, cssH: 900 });
      await patchSession(serviceWorker, failed, {
        status: 'error',
        title: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/gofullpage',
        error: { code: 'RESTRICTED', message: 'Cannot access contents of the page.' },
        slices: [],
      });
      ed = await open(failed);
      await expect(ed.getByTestId('state-error')).toBeVisible();
      await shot(ed, 'error');
      await ed.close();
      ed = await open(failed, 'light');
      await expect(ed.getByTestId('state-error')).toBeVisible();
      await shot(ed, 'error-light');
      await ed.close();

      // Capturing (editor opened early).
      const running = await seed();
      await patchSession(serviceWorker, running, {
        status: 'capturing',
        progress: { done: 4, total: 9 },
      });
      ed = await open(running);
      await expect(ed.getByTestId('state-loading')).toBeVisible();
      await shot(ed, 'capturing');
      await ed.close();

      // Capture that stopped sending updates.
      await context.addInitScript(() => {
        (window as unknown as { __pagesnapUiTiming: object }).__pagesnapUiTiming = {
          stallMs: 800,
        };
      });
      const dead = await seed();
      await patchSession(serviceWorker, dead, {
        status: 'capturing',
        progress: { done: 6, total: 14 },
      });
      ed = await open(dead);
      await expect(ed.getByTestId('state-loading')).toHaveAttribute('data-phase', 'stalled');
      await shot(ed, 'capture-stalled');
      await ed.close();

      // Opening failed (storage error / timeout).
      await context.addInitScript(() => {
        IDBFactory.prototype.open = () =>
          Object.assign(new EventTarget(), { result: null, error: null }) as never;
      });
      ed = await open(marked);
      await expect(ed.getByTestId('state-error')).toBeVisible({ timeout: 30_000 });
      await shot(ed, 'open-failed');
      await ed.close();
    });

    test('options page', async ({ context, extensionId, pagesnap }) => {
      await pagesnap.seedSession({ cssW: 1280, cssH: 4000 });
      await pagesnap.seedSession({ cssW: 1280, cssH: 9000 });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(page.getByRole('heading', { name: 'Page Snap' })).toBeVisible();
      await expect(page.getByTestId('storage-usage')).toContainText('captures');
      await shot(page, 'options');
      await page.getByRole('button', { name: 'Delete all captures…' }).scrollIntoViewIfNeeded();
      await shot(page, 'options-storage');
      await page.getByRole('button', { name: 'Delete all captures…' }).click();
      await shot(page, 'options-delete-confirm');
      await page.emulateMedia({ colorScheme: 'light' });
      await shot(page, 'options-delete-confirm-light');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.evaluate(() => scrollTo(0, 0));
      await shot(page, 'options-light');
    });
  });
}

/** The bar on narrow windows (split screen): the identity gives way, nothing overlaps. */
for (const w of [1000, 1100, 820]) {
  test.describe(`narrow ${w}`, () => {
    test.use({ dpr: DPR, windowSize: { width: w, height: 700 + CHROME_H } });
    test('toolbar', async ({ context, pagesnap, serviceWorker, extensionId }) => {
      const lms = await lmsPagePng(pagesnap);
      const id = await seedImageSession(serviceWorker, pagesnap, {
        title: lms.title,
        url: lms.url,
        cssW: lms.cssW,
        dpr: DPR,
        pngBase64: lms.pngBase64,
      });
      const ed = await context.newPage();
      await ed.emulateMedia({ colorScheme: 'dark' });
      await ed.goto(`chrome-extension://${extensionId}/editor.html#s=${id}`);
      await waitReady(ed, { force: true });
      mkdirSync(OUT, { recursive: true });
      await ed.waitForTimeout(450);
      await ed.screenshot({ path: `${OUT}/narrow-${w}.png` });
      await ed.screenshot({
        path: `${OUT}/narrow-${w}-bar.png`,
        clip: { x: 0, y: 0, width: w, height: 46 },
      });
      await ed.getByTestId('color-button').click();
      await ed.waitForTimeout(300);
      await ed.screenshot({
        path: `${OUT}/narrow-${w}-color-popover.png`,
        clip: { x: 0, y: 0, width: w, height: 140 },
      });
      await ed.close();
    });
  });
}
