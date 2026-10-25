/**
 * Screenshots of the editor UI states for design review (owner: C). Opt-in, since they write files
 * and take a while:
 *
 *   PAGESNAP_UI_SHOTS=1 PAGESNAP_E2E_ID=c pnpm exec playwright test ui.screens
 *
 * Output: /tmp/pagesnap-qa/ui/<state>-<w>x<h>[-light].png. `PAGESNAP_UI_SHOTS_DPR` sets the device
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

const OUT = '/tmp/pagesnap-qa/ui';
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

      // Copied toast: smart region on a tall page.
      await setUiState(ed, {
        copy: {
          state: 'copied',
          request: 'default',
          outcome: 'smart',
          size: { w: lms.cssW, h: 1184 },
          tall: false,
          at: Date.now(),
        },
      });
      await shot(ed, 'copied-smart');
      await setUiState(ed, {
        copy: {
          state: 'copied',
          request: 'default',
          outcome: 'full',
          size: { w: lms.cssW, h: 3398 },
          tall: false,
          at: Date.now(),
        },
      });
      await shot(ed, 'copied-full');

      // Tool tooltip + size menu open.
      await ed.getByRole('button', { name: 'Highlighter' }).hover();
      await ed.waitForTimeout(700);
      await shot(ed, 'tooltip');
      await ed.getByTestId('size-button').click();
      await shot(ed, 'size-menu');
      await ed.keyboard.press('Escape');

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
    });

    test('options page', async ({ context, extensionId }) => {
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(page.getByRole('heading', { name: 'Page Snap' })).toBeVisible();
      await shot(page, 'options');
      await page.emulateMedia({ colorScheme: 'light' });
      await shot(page, 'options-light');
    });
  });
}
