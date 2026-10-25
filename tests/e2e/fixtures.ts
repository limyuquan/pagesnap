/**
 * Playwright fixtures for Page Snap e2e tests. Import `test` and `expect` from here.
 *
 * - `context`: persistent Chromium context with the e2e build loaded (headless unless HEADED=1).
 *   Options: `dpr` (default 2) and `windowSize` (default 1280 × 900).
 *
 *   DPR is set with `--force-device-scale-factor` and Playwright's viewport emulation is OFF
 *   (`viewport: null`). Measured: with `deviceScaleFactor` emulation the page reports DPR 2 but
 *   `captureVisibleTab` still returns 1x bitmaps, and the flag combined with a fixed viewport makes
 *   the page report DPR 1 with 2x bitmaps. Only flag + no emulation matches real Chrome. The
 *   viewport is then the window minus browser UI (about 87 px less in height in headless), so
 *   tests must read `innerWidth`/`innerHeight` instead of assuming a size.
 * - `serviceWorker`, `extensionId`.
 * - `pagesnap`: helpers to open fixtures, trigger the capture hook, seed sessions, open the editor.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  chromium,
  type Page,
  type Worker,
} from '@playwright/test';
import type { Browser } from 'wxt/browser';
import type { SyntheticOptions } from '@/shared/testing/synthetic';
import { FIXTURE_ORIGIN } from '../../playwright.config';

/** Built by `pnpm build:e2e`. `PAGESNAP_E2E_ID` must match the one used for the build (wxt.config.ts). */
export const EXTENSION_PATH = path.resolve(
  `.output/chrome-mv3-e2e${process.env.PAGESNAP_E2E_ID ? `-${process.env.PAGESNAP_E2E_ID}` : ''}`,
);

/** `chrome` inside `serviceWorker.evaluate` callbacks. */
export type ChromeGlobal = { chrome: typeof Browser };

export interface PagesnapHelpers {
  /** `http://127.0.0.1:4321/<name>` (name with or without `.html`, query allowed). */
  fixtureUrl(name: string): string;
  /** Open a fixture in a new tab, wait for load and bring it to the front. */
  openFixture(name: string): Promise<Page>;
  /** Chrome tab id of a Playwright page (matched by URL). */
  tabIdOf(page: Page): Promise<number>;
  /**
   * Capture `page` through the e2e hook (`__pagesnap.startCapture`, no user gesture needed) and
   * wait for the editor tab. Resolves with the session id and the editor page.
   */
  capture(page: Page): Promise<{ sessionId: string; editor: Page }>;
  /** Store a synthetic `ready` session in the extension's IndexedDB. */
  seedSession(opts?: SyntheticOptions): Promise<string>;
  /** Open `editor.html#s=<sessionId>` in a new tab. */
  openEditor(sessionId: string): Promise<Page>;
}

interface Options {
  dpr: number;
  windowSize: { width: number; height: number };
}

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  pagesnap: PagesnapHelpers;
}

export const test = base.extend<Fixtures & Options>({
  dpr: [2, { option: true }],
  windowSize: [{ width: 1280, height: 900 }, { option: true }],

  context: async ({ dpr, windowSize }, use) => {
    if (!existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(`No e2e build at ${EXTENSION_PATH}. Run \`pnpm build:e2e\` first.`);
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: null,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        `--force-device-scale-factor=${dpr}`,
        `--window-size=${windowSize.width},${windowSize.height}`,
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const isOurs = (w: Worker) =>
      w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
    const sw =
      context.serviceWorkers().find(isOurs) ??
      (await context.waitForEvent('serviceworker', { predicate: isOurs }));
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  pagesnap: async ({ context, serviceWorker, extensionId }, use) => {
    const fixtureUrl = (name: string) => {
      const [file = '', query] = name.split('?');
      const withExt = file.endsWith('.html') ? file : `${file}.html`;
      return `${FIXTURE_ORIGIN}/${withExt}${query ? `?${query}` : ''}`;
    };

    const tabIdOf = async (page: Page) => {
      const url = page.url();
      const id = await serviceWorker.evaluate(async (u) => {
        const { chrome } = globalThis as unknown as ChromeGlobal;
        const tabs = await chrome.tabs.query({});
        return tabs.find((t) => t.url === u)?.id ?? null;
      }, url);
      if (id == null) throw new Error(`No tab found for ${url}`);
      return id;
    };

    const isEditor = (p: Page) =>
      p.url().startsWith(`chrome-extension://${extensionId}/editor.html`);

    const helpers: PagesnapHelpers = {
      fixtureUrl,
      tabIdOf,
      async openFixture(name) {
        const page = await context.newPage();
        await page.goto(fixtureUrl(name), { waitUntil: 'load' });
        await page.bringToFront();
        return page;
      },
      async capture(page) {
        await page.bringToFront();
        const tabId = await tabIdOf(page);
        const editorPromise = context.waitForEvent('page', {
          predicate: isEditor,
          timeout: 60_000,
        });
        const sessionId = await serviceWorker.evaluate(async (id) => {
          const hook = globalThis.__pagesnap;
          if (!hook) throw new Error('__pagesnap hook missing: not an e2e build?');
          return hook.startCapture(id);
        }, tabId);
        const editor = await editorPromise;
        await editor.waitForLoadState('domcontentloaded');
        return { sessionId, editor };
      },
      async seedSession(opts = {}) {
        return serviceWorker.evaluate(async (o) => {
          const hook = globalThis.__pagesnap;
          if (!hook) throw new Error('__pagesnap hook missing: not an e2e build?');
          return hook.seedSyntheticSession(o);
        }, opts);
      },
      async openEditor(sessionId) {
        const page = await context.newPage();
        await page.goto(
          `chrome-extension://${extensionId}/editor.html#s=${encodeURIComponent(sessionId)}`,
        );
        return page;
      },
    };
    await use(helpers);
  },
});

export const expect = test.expect;
