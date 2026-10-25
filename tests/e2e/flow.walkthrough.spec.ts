/**
 * User-facing walkthrough screenshots from the real pipeline (skipped unless
 * PAGESNAP_WALKTHROUGH=1). Headless, 1440 × 900 window at DPR 2, like a MacBook:
 *
 *   PAGESNAP_WALKTHROUGH=1 PAGESNAP_BROWSER=cft pnpm exec playwright test flow.walkthrough
 *
 * Captures the Canvas LMS replica, marks it up the way a student would (box the due date, arrow +
 * "Is this the final deadline?", highlight a requirement, underline the word count), presses
 * Cmd+C and saves the toast plus the exact PNG that lands on the clipboard to WALK_DIR.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { Rect } from '@/shared/types';
import { clickImage, dragImage, readClipboardPng, snapshot } from './engine.helpers';
import { expect, test } from './fixtures';
import { allowClipboard, captureFixture } from './flow.helpers';

const WALK_DIR = '/tmp/pagesnap-qa/flow';

test.skip(
  !process.env.PAGESNAP_WALKTHROUGH,
  'set PAGESNAP_WALKTHROUGH=1 to write walkthrough shots',
);
test.use({ dpr: 2, windowSize: { width: 1440, height: 900 } });
test.setTimeout(120_000);

/**
 * CSS rect, in the stitched image's CSS px, of `selector` (or of `text` inside it) in the
 * inner-scroller page: the panel is expanded in place, so content y = panel top + scroll offset.
 */
async function rectOf(page: Page, selector: string, text?: string): Promise<Rect> {
  return page.evaluate(
    ([sel, t]) => {
      const content = document.querySelector('#content') as HTMLElement;
      const el = document.querySelector(sel) as HTMLElement;
      let r = el.getBoundingClientRect();
      if (t) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent?.indexOf(t) ?? -1;
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + t.length);
          r = range.getBoundingClientRect();
          break;
        }
      }
      const c = content.getBoundingClientRect();
      const top = c.top + content.clientTop;
      return { x: r.left, y: top + (r.top - top) + content.scrollTop, w: r.width, h: r.height };
    },
    [selector, text ?? null] as const,
  );
}

/** Wheel the editor until image-px rows `y0..y1` are on screen (or start at the top, if taller). */
async function bringIntoView(ed: Page, y0: number, y1: number): Promise<void> {
  const box = await ed.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await ed.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) {
    const s = await snapshot(ed);
    const viewH = s.viewport.h / s.camera.zoom;
    const margin = 40 / s.camera.zoom;
    const want = y1 - y0 > viewH - 2 * margin ? y0 - margin : (y0 + y1) / 2 - viewH / 2;
    const dy = Math.max(-400, Math.min(400, (want - s.camera.y) * s.camera.zoom));
    if (Math.abs(dy) < 4) return;
    await ed.mouse.wheel(0, dy);
    await ed.waitForTimeout(60);
  }
  throw new Error(`couldn't scroll to ${y0}..${y1}`);
}

test('walkthrough: Canvas page → marks → Cmd+C → what gets pasted', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  mkdirSync(WALK_DIR, { recursive: true });
  const cap = await captureFixture(pagesnap, serviceWorker, 'inner-scroller', async (page) => {
    await page.screenshot({ path: `${WALK_DIR}/01-page.png` });
  });
  const { editor: ed, page, session } = cap;
  const dpr = session.dpr;
  await ed.waitForTimeout(300);
  await ed.screenshot({ path: `${WALK_DIR}/02-editor-opened.png` });

  const img = (r: Rect, pad = 0): Rect => ({
    x: (r.x - pad) * dpr,
    y: (r.y - pad) * dpr,
    w: (r.w + 2 * pad) * dpr,
    h: (r.h + 2 * pad) * dpr,
  });
  const due = img(await rectOf(page, '.details span:first-child'), 7);
  const words = img(await rectOf(page, '.desc', '1000 - 1200 word'));
  const requirement = img(
    await rectOf(page, '.desc', 'Consider the government, community and individuals'),
  );

  // 1. Box the due date (Arrow is armed on open, so pick the rectangle first).
  await bringIntoView(ed, due.y - 300, due.y + due.h + 200);
  await ed.keyboard.press('r');
  await dragImage(ed, { x: due.x, y: due.y }, { x: due.x + due.w, y: due.y + due.h });

  // 2. A question in the free space after the next line, with an arrow back to the box.
  const hl = img(await rectOf(page, '.desc .hl'));
  const note = { x: hl.x + hl.w + 30 * dpr, y: hl.y - 8 * dpr };
  await ed.keyboard.press('t');
  await clickImage(ed, note);
  await ed.keyboard.type('Is this the final deadline?');
  await ed.keyboard.press('Enter');
  await ed.keyboard.press('a');
  await dragImage(
    ed,
    { x: note.x - 10 * dpr, y: note.y + 6 * dpr },
    { x: due.x + due.w + 6 * dpr, y: due.y + due.h - 6 * dpr },
  );

  // 3. Highlight a requirement line, 4. underline the word count.
  await bringIntoView(ed, words.y - 100, requirement.y + requirement.h + 100);
  await ed.keyboard.press('h');
  const hy = requirement.y + requirement.h / 2;
  await dragImage(ed, { x: requirement.x, y: hy }, { x: requirement.x + requirement.w, y: hy });
  await ed.keyboard.press('u');
  const uy = words.y + words.h + 2 * dpr;
  await dragImage(ed, { x: words.x, y: uy }, { x: words.x + words.w, y: uy });

  expect((await snapshot(ed)).shapes.map((s) => s.kind)).toEqual([
    'rect',
    'text',
    'arrow',
    'highlight',
    'underline',
  ]);
  // Park the pointer off the canvas so no hover cursor shows in the shots.
  await ed.mouse.move(5, 5);
  await bringIntoView(ed, due.y - 120, uy + 40);
  await ed.waitForTimeout(200);
  await ed.screenshot({ path: `${WALK_DIR}/03-annotated.png` });

  // 5. Cmd+C, the toast, and the clipboard image itself.
  await allowClipboard(context, page);
  await ed.keyboard.press('ControlOrMeta+c');
  const toast = ed.getByTestId('toast');
  await expect(ed.getByTestId('toast-title')).toHaveText(/^Copied/);
  await expect(toast).not.toHaveAttribute('data-hidden');
  await ed.waitForTimeout(350); // let the toast's entrance transition finish
  await ed.screenshot({ path: `${WALK_DIR}/04-copied-toast.png` });
  const toastBox = await toast.boundingBox();
  if (toastBox) {
    await ed.screenshot({
      path: `${WALK_DIR}/04b-toast-closeup.png`,
      clip: {
        x: toastBox.x - 24,
        y: toastBox.y - 24,
        width: toastBox.width + 48,
        height: toastBox.height + 48,
      },
    });
  }
  const pasted = await readClipboardPng(page);
  writeFileSync(`${WALK_DIR}/05-clipboard.png`, PNG.sync.write(pasted));
  const s = await snapshot(ed);
  expect([pasted.width, pasted.height]).toEqual([s.copy.size?.w, s.copy.size?.h]);
  console.log(`WALKTHROUGH ${JSON.stringify({ copy: s.copy, page: session.css, dir: WALK_DIR })}`);
});
