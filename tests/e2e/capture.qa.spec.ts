/**
 * Real-site QA over the network (opt-in: `PAGESNAP_QA=1`). Captures live pages and saves the
 * stitched PNGs to /tmp/pagesnap-qa/capture/ for a human (or agent) to look at.
 *
 *   PAGESNAP_QA=1 PAGESNAP_E2E_ID=a pnpm exec playwright test tests/e2e/capture.qa.spec.ts
 *   PAGESNAP_QA_URLS="name=https://...,other=https://..." to capture other pages.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { captureFull, DUMP_DIR, savePng } from './capture.helpers';
import { expect, test } from './fixtures';

const DEFAULT_SITES: Record<string, string> = {
  wikipedia: 'https://en.wikipedia.org/wiki/Singapore',
  github: 'https://github.com/facebook/react',
  mdn: 'https://developer.mozilla.org/en-US/docs/Web/CSS/position',
  hn: 'https://news.ycombinator.com/',
  reactdev: 'https://react.dev/learn',
  tailwind: 'https://tailwindcss.com/docs/installation/using-vite',
  verge: 'https://www.theverge.com/',
  reddit: 'https://www.reddit.com/r/programming/',
  chromedocs: 'https://developer.chrome.com/docs/extensions/reference/api/tabs',
};

/**
 * What the capture itself could leave behind (real pages mutate their own DOM, so a full DOM
 * comparison is noise): scroll position, our nodes and inline `!important` declarations.
 */
function ours(page: Page) {
  return page.evaluate(() => ({
    scrollX,
    scrollY,
    pagesnapNodes: document.querySelectorAll('[data-pagesnap]').length,
    importantInline: [...document.querySelectorAll('[style]')].filter((el) =>
      (el.getAttribute('style') ?? '').includes('!important'),
    ).length,
  }));
}

const SITES = process.env.PAGESNAP_QA_URLS
  ? Object.fromEntries(process.env.PAGESNAP_QA_URLS.split(',').map((kv) => kv.split('=', 2)))
  : DEFAULT_SITES;

test.describe('real sites', () => {
  test.skip(!process.env.PAGESNAP_QA, 'set PAGESNAP_QA=1 to run real-site QA');
  test.use({ dpr: 2 });

  for (const [name, url] of Object.entries(SITES)) {
    test(name, async ({ context, pagesnap, serviceWorker }) => {
      test.setTimeout(240_000);
      const page = await context.newPage();
      await page.goto(url as string, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.bringToFront();
      const before = await ours(page);
      const { session, sessionId, timings } = await captureFull(pagesnap, serviceWorker, page);
      const after = await ours(page);
      const report = {
        name,
        url,
        status: session.status,
        error: session.error,
        warnings: session.warnings.map((w) => w.code),
        target: session.slices[0]?.target.kind,
        viewport: session.viewport,
        css: session.css,
        image: session.image,
        dpr: session.dpr,
        slices: session.slices.length,
        contentHeights: [...new Set(session.slices.map((sl) => sl.target.content.h))],
        timings: { ...timings, frameGapsMs: undefined },
        restored: JSON.stringify(before) === JSON.stringify(after),
        restoreDiff: JSON.stringify(before) === JSON.stringify(after) ? null : { before, after },
      };
      console.log(`[qa ${name}] ${JSON.stringify(report)}`);
      const files = await savePng(
        serviceWorker,
        sessionId,
        path.join(DUMP_DIR, `${name}.png`),
        0.5,
        4000,
      );
      writeFileSync(
        path.join(DUMP_DIR, `${name}.json`),
        JSON.stringify({ ...report, files }, null, 2),
      );
      expect(['ready', 'partial']).toContain(session.status);
    });
  }
});
