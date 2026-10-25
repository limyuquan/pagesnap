/**
 * README product images, from the real pipeline on a public page (skipped unless
 * PAGESNAP_README_SHOTS=1; needs the network). Headless, 1440 × 900 window at DPR 2:
 *
 *   PAGESNAP_README_SHOTS=1 PAGESNAP_BROWSER=cft pnpm exec playwright test readme.shots
 *
 * Raw shots go to /tmp/pagesnap-readme/; `node scripts/readme-images.mjs` frames them into
 * docs/images/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { Rect } from '@/shared/types';
import { getSession } from './capture.helpers';
import {
  clickImage,
  dragImage,
  readClipboardPng,
  snapshot,
  toPage,
  waitReady,
} from './engine.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';
import { allowClipboard } from './flow.helpers';

const RAW_DIR = '/tmp/pagesnap-readme';
const URL = 'https://github.com/microsoft/playwright';

test.skip(!process.env.PAGESNAP_README_SHOTS, 'set PAGESNAP_README_SHOTS=1 to write README shots');
test.use({ dpr: 2, windowSize: { width: 1440, height: 900 } });
test.setTimeout(180_000);

/**
 * Document-CSS rect of the first visible text node whose trimmed text is (or contains) `text`,
 * or of its closest `closest` ancestor.
 */
async function rectOfText(page: Page, text: string, exact = true, closest = ''): Promise<Rect> {
  return page.evaluate(
    ([t, ex, up]) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const s = n.textContent ?? '';
        const i = s.indexOf(t);
        if (i < 0 || (ex && s.trim() !== t)) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + t.length);
        const r = up
          ? n.parentElement?.closest(up)?.getBoundingClientRect()
          : range.getClientRects()[0];
        if (!r || r.width === 0) continue;
        return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      }
      throw new Error(`text not found: ${t}`);
    },
    [text, exact, closest] as const,
  );
}

/** Wheel the editor until image-px rows `y0..y1` are on screen, centred. */
async function bringIntoView(ed: Page, y0: number, y1: number): Promise<void> {
  const box = await ed.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await ed.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60; i++) {
    const s = await snapshot(ed);
    const viewH = s.viewport.h / s.camera.zoom;
    const want = (y0 + y1) / 2 - viewH / 2;
    const dy = Math.max(-400, Math.min(400, (want - s.camera.y) * s.camera.zoom));
    if (Math.abs(dy) < 4) return;
    await ed.mouse.wheel(0, dy);
    await ed.waitForTimeout(60);
  }
  throw new Error(`couldn't scroll to ${y0}..${y1}`);
}

/** A hand-drawn loop around image-px rect `r` with the pen. */
async function penLoop(ed: Page, r: Rect): Promise<void> {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const pts: { x: number; y: number }[] = [];
  // Start on the right, inside the row: a press on another mark's border would grab that mark.
  for (let i = 0; i <= 44; i++) {
    const t = Math.PI * 0.1 + (i / 40) * Math.PI * 2;
    const k = 1 + 0.05 * Math.sin(i / 3);
    pts.push({
      x: cx + Math.cos(t) * (r.w / 2 + 22) * k,
      y: cy + Math.sin(t) * (r.h / 2 + 10) * k,
    });
  }
  const page = await Promise.all(pts.map((p) => toPage(ed, p.x, p.y)));
  const [first, ...rest] = page;
  if (!first) return;
  await ed.mouse.move(first.x, first.y);
  await ed.mouse.down();
  for (const p of rest) await ed.mouse.move(p.x, p.y, { steps: 2 });
  await ed.mouse.up();
}

const setFlags = (sw: import('@playwright/test').Worker, flags: Record<string, unknown>) =>
  sw.evaluate((f) => globalThis.__pagesnapCapture?.setFlags(f), flags);

async function openPage(context: import('@playwright/test').BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.bringToFront();
  return page;
}

test('readme: capture, mark up, copy, edit', async ({ context, pagesnap, serviceWorker }) => {
  mkdirSync(RAW_DIR, { recursive: true });
  const page = await openPage(context);
  const css = {
    choose: await rectOfText(page, 'Choose the path that fits your workflow', false),
    table: await rectOfText(page, 'Best for', true, 'table'),
    cliRow: await rectOfText(page, 'Playwright CLI', true, 'tr'),
    agents: await rectOfText(page, 'Coding agents (Claude Code, Copilot)'),
    mcp: await rectOfText(page, 'Playwright MCP'),
  };
  writeFileSync(`${RAW_DIR}/targets.json`, JSON.stringify(css, null, 2));
  await page.screenshot({ path: `${RAW_DIR}/page.png` });

  const { sessionId, editor: ed } = await pagesnap.capture(page, { via: 'click' });
  await waitReady(ed);
  const dpr = (await getSession(serviceWorker, sessionId)).dpr;
  const img = (r: Rect, pad = 0): Rect => ({
    x: (r.x - pad) * dpr,
    y: (r.y - pad) * dpr,
    w: (r.w + 2 * pad) * dpr,
    h: (r.h + 2 * pad) * dpr,
  });
  const table = img(css.table);
  await bringIntoView(ed, table.y - 260 * dpr, table.y + table.h + 60 * dpr);

  // 1. Box the CLI row, 2. highlight what it's for, 3. loop the MCP alternative.
  const row = img(css.cliRow, 4);
  await ed.keyboard.press('r');
  await dragImage(ed, { x: row.x, y: row.y }, { x: row.x + row.w, y: row.y + row.h });
  const agents = img(css.agents);
  await ed.keyboard.press('h');
  const hy = agents.y + agents.h / 2;
  await dragImage(ed, { x: agents.x - 4, y: hy }, { x: agents.x + agents.w + 4, y: hy });
  await ed.keyboard.press('p');
  await penLoop(ed, img(css.mcp, 2));

  // 4. The question, right of the table, with an arrow back to the box.
  const note = { x: table.x + table.w + 110 * dpr, y: row.y - 64 * dpr };
  await ed.keyboard.press('t');
  await clickImage(ed, note);
  await ed.keyboard.type('CLI or MCP for Claude Code?');
  await ed.keyboard.press('Enter');
  await ed.keyboard.press('a');
  const arrowFrom = { x: note.x + 14 * dpr, y: note.y + 34 * dpr };
  const arrowTo = { x: row.x + row.w + 10 * dpr, y: row.y + row.h / 2 };
  await dragImage(ed, arrowFrom, arrowTo);

  // 5. Underline the line that asks the question.
  const choose = img(css.choose);
  await ed.keyboard.press('u');
  const uy = choose.y + choose.h + 2 * dpr;
  await dragImage(ed, { x: choose.x, y: uy }, { x: choose.x + choose.w, y: uy });

  await ed.keyboard.press('a');
  expect((await snapshot(ed)).shapes.map((s) => s.kind)).toEqual([
    'rect',
    'highlight',
    'pen',
    'text',
    'arrow',
    'underline',
  ]);
  await ed.mouse.move(5, 5);
  await ed.waitForTimeout(300);
  await ed.screenshot({ path: `${RAW_DIR}/annotated.png` });

  // Cmd+C: the toast, and the exact PNG that lands on the clipboard.
  await allowClipboard(context, page);
  await ed.keyboard.press('ControlOrMeta+c');
  await expect(ed.getByTestId('toast-title')).toHaveText(/^Copied/);
  await ed.waitForTimeout(1300); // the copied-area flash fades; the toast stays
  await expect(ed.getByTestId('toast')).not.toHaveAttribute('data-hidden');
  await ed.screenshot({ path: `${RAW_DIR}/copied.png` });
  writeFileSync(`${RAW_DIR}/clipboard.png`, PNG.sync.write(await readClipboardPng(page)));
  await expect(ed.getByTestId('toast')).toHaveAttribute('data-hidden', /.*/, { timeout: 15_000 });

  // Edit with the Arrow tool still armed: click the arrow, bend it from its middle handle.
  const mid = { x: (arrowFrom.x + arrowTo.x) / 2, y: (arrowFrom.y + arrowTo.y) / 2 };
  await clickImage(ed, mid);
  expect((await snapshot(ed)).selection).toHaveLength(1);
  await dragImage(ed, mid, { x: mid.x - 10 * dpr, y: mid.y - 26 * dpr }, { steps: 12 });
  await ed.mouse.move(5, 5);
  await ed.waitForTimeout(300);
  await ed.screenshot({ path: `${RAW_DIR}/edit.png` });
});

test('readme: progress panel', async ({ context, pagesnap, serviceWorker, extensionId }) => {
  mkdirSync(RAW_DIR, { recursive: true });
  const page = await openPage(context);
  await page.screenshot({ path: `${RAW_DIR}/progress-page.png` });
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { stepDelayMs: 900 });
  try {
    const opened = context.waitForEvent('page', {
      predicate: (p) => p.url().includes('popup.html'),
    });
    await serviceWorker.evaluate(async (url) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      await chrome.windows.create({ url, type: 'popup', width: 360, height: 260, focused: false });
    }, `chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    const pop = await opened;
    await pop.waitForLoadState('domcontentloaded');
    const pct = () => pop.evaluate(() => Number(document.documentElement.dataset.pct ?? 0));
    await expect.poll(pct, { timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(58);
    await pop.waitForTimeout(450); // let the bar ease in
    const box = await pop.locator('body').boundingBox();
    if (!box) throw new Error('no popup body');
    const clip = { x: 0, y: 0, width: box.width, height: box.height };
    for (const scheme of ['dark', 'light'] as const) {
      await pop.emulateMedia({ colorScheme: scheme });
      await pop.waitForTimeout(120);
      await pop.screenshot({ path: `${RAW_DIR}/progress-${scheme}.png`, clip });
    }
  } finally {
    await setFlags(serviceWorker, { stepDelayMs: 0 });
  }
});
