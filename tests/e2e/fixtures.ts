/**
 * Playwright fixtures for Page Snap e2e tests. Import `test` and `expect` from here.
 *
 * - `context`: persistent Chromium context with the e2e build loaded (headless unless
 *   PAGESNAP_HEADED=1).
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
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
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

/**
 * Which browser runs the suite. `PAGESNAP_BROWSER=cft` uses Chrome for Testing (real Chrome
 * builds that still honour `--load-extension`; branded Chrome ignores it since 137), headless
 * (new headless mode) like the default run.
 * Install it outside the repo:
 *   npx @puppeteer/browsers install chrome@stable --path ~/.cache/pagesnap-cft
 * or point `PAGESNAP_CFT_PATH` at the executable.
 */
export const BROWSER_KIND: 'chromium' | 'cft' =
  process.env.PAGESNAP_BROWSER === 'cft' ? 'cft' : 'chromium';

/** The newest Chrome for Testing under ~/.cache/pagesnap-cft, or `PAGESNAP_CFT_PATH`. */
export function cftExecutable(): string {
  if (process.env.PAGESNAP_CFT_PATH) return process.env.PAGESNAP_CFT_PATH;
  const root = path.join(os.homedir(), '.cache/pagesnap-cft/chrome');
  const builds = existsSync(root) ? readdirSync(root).sort().reverse() : [];
  for (const b of builds) {
    const candidates = [
      `${b}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${b}/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${b}/chrome-linux64/chrome`,
      `${b}/chrome-win64/chrome.exe`,
    ].map((c) => path.join(root, c));
    const found = candidates.find((c) => existsSync(c));
    if (found) return found;
  }
  throw new Error(
    'Chrome for Testing not found. Run `npx @puppeteer/browsers install chrome@stable --path ~/.cache/pagesnap-cft` or set PAGESNAP_CFT_PATH.',
  );
}

/** Browser start-up budget. A healthy launch takes ~0.5–2 s. */
const LAUNCH_TIMEOUT_MS = 20_000;

/** Opt-in visible browser window. Never the default: headed windows steal focus on macOS. */
export const HEADED = process.env.PAGESNAP_HEADED === '1';

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
   * Capture `page` through the e2e hook (no user gesture needed) and wait for the editor tab.
   * Resolves with the session id and the editor page. `via: 'click'` goes through the toolbar
   * button's own listener (`__pagesnap.clickAction`, the same code path as a real click or
   * Alt+Shift+P); the default calls `__pagesnap.startCapture` directly.
   */
  capture(
    page: Page,
    opts?: { via?: 'hook' | 'click' },
  ): Promise<{ sessionId: string; editor: Page }>;
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
    const cft = BROWSER_KIND === 'cft';
    const launch = () =>
      chromium.launchPersistentContext('', {
        ...(cft ? { executablePath: cftExecutable() } : { channel: 'chromium' }),
        // Headless by default for both browsers (Playwright uses Chrome's new headless mode,
        // which is the full browser with extensions). A visible window only with PAGESNAP_HEADED=1.
        headless: !HEADED,
        viewport: null,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          `--force-device-scale-factor=${dpr}`,
          `--window-size=${windowSize.width},${windowSize.height}`,
        ],
      });
    let context: BrowserContext;
    try {
      context = await launch();
    } catch (err) {
      // Measured with Chrome for Testing on macOS: about 1 launch in 250 never returns when six
      // start at once (the binary hangs before the CDP pipe opens; nothing of ours has run yet).
      // Retry the launch only, loudly. Test bodies are never retried.
      if (!cft || !(err instanceof Error) || !/Timeout/i.test(err.message)) throw err;
      console.warn(
        `[pagesnap e2e] Chrome for Testing didn't start in ${LAUNCH_TIMEOUT_MS} ms; relaunching once`,
      );
      context = await launch();
    }
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
      async capture(page, { via = 'hook' } = {}) {
        await page.bringToFront();
        const tabId = await tabIdOf(page);
        const editorPromise = context.waitForEvent('page', {
          predicate: isEditor,
          timeout: 60_000,
        });
        const sessionId = await serviceWorker.evaluate(
          async ([id, how]) => {
            const hook = globalThis.__pagesnap;
            if (!hook) throw new Error('__pagesnap hook missing: not an e2e build?');
            return how === 'click' ? hook.clickAction(id) : hook.startCapture(id);
          },
          [tabId, via] as const,
        );
        if (!sessionId) throw new Error('The click cancelled a running capture');
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
