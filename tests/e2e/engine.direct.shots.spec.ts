/**
 * QA screenshots of direct manipulation (hover outline, handles, rotation, bend, the toolbar
 * following the selection, the cursors). Runs only with `PAGESNAP_QA_DIR=<dir>`; writes PNGs
 * there for a human to look at. Not an assertion suite.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { clickImage, dragImage, snapshot, toPage, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

const DIR = process.env.PAGESNAP_QA_DIR;
test.skip(!DIR, 'set PAGESNAP_QA_DIR to write the direct-manipulation screenshots');

type P = { x: number; y: number };

async function handle(ed: Page, id: string, h: string): Promise<P> {
  const hs: { id: string; x: number; y: number }[] = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (id) => (window as any).__pagesnapEngine.handles(id),
    id,
  );
  const f = hs.find((x) => x.id === h);
  if (!f) throw new Error(`no handle ${h}`);
  return f;
}

async function handlePage(ed: Page, id: string, h: string): Promise<P> {
  const q = await handle(ed, id, h);
  return toPage(ed, q.x, q.y);
}

async function seed(ed: Page, shapes: object[]) {
  await ed.evaluate((shapes) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const s = (window as any).__pagesnapEngine.state();
    s._engine._commit({ ...s.doc, shapes: [...s.doc.shapes, ...shapes] }, []);
  }, shapes);
}

/** Screenshot an image-px region of the canvas (plus a margin in CSS px). */
async function shot(ed: Page, name: string, r: { x: number; y: number; w: number; h: number }) {
  const a = await toPage(ed, r.x, r.y);
  const b = await toPage(ed, r.x + r.w, r.y + r.h);
  await ed.waitForTimeout(150);
  await ed.screenshot({
    path: join(DIR as string, name),
    clip: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
  });
}

async function cursor(ed: Page): Promise<string> {
  return ed.evaluate(
    () => (document.querySelector('[data-testid="editor-canvas"]') as HTMLElement).style.cursor,
  );
}

test('direct manipulation screenshots', async ({ pagesnap }) => {
  test.setTimeout(90_000);
  mkdirSync(DIR as string, { recursive: true });
  const page = await pagesnap.openFixture('article');
  const { editor: ed } = await pagesnap.capture(page);
  await waitReady(ed);
  const s0 = await snapshot(ed);
  expect(s0.tool).toBe('arrow');
  const d = s0.dpr;

  const rect = {
    id: 'r1',
    kind: 'rect',
    color: '#FF3B30',
    shadow: true,
    box: { x: 248 * d, y: 330 * d, w: 360 * d, h: 156 * d },
    width: 5 * d,
    fill: 'none',
  };
  const arrow = {
    id: 'a1',
    kind: 'arrow',
    color: '#FF3B30',
    shadow: true,
    a: { x: 880 * d, y: 640 * d },
    b: { x: 640 * d, y: 470 * d },
    width: 6 * d,
    bend: 0,
    heads: 'end',
  };
  const text = {
    id: 't1',
    kind: 'text',
    color: '#FF3B30',
    shadow: true,
    at: { x: 760 * d, y: 120 * d },
    text: 'Use the retry-after value',
    size: 26 * d,
    weight: 700,
    style: 'outline',
  };
  await seed(ed, [rect, arrow, text]);
  const cursors: Record<string, string> = {};

  // 1. Hover outline (Arrow tool, nothing selected).
  const onBorder = await toPage(ed, rect.box.x, rect.box.y + 60 * d);
  await ed.mouse.move(onBorder.x, onBorder.y);
  cursors['hover (move)'] = await cursor(ed);
  await shot(ed, '1-hover-outline.png', { x: 200 * d, y: 290 * d, w: 460 * d, h: 240 * d });
  const onText = await toPage(ed, text.at.x + 60 * d, text.at.y + 16 * d);
  await ed.mouse.move(onText.x, onText.y);
  await shot(ed, '1b-hover-text.png', { x: 720 * d, y: 90 * d, w: 420 * d, h: 90 * d });

  // 2. Selected rect: 8 handles + the rotation handle.
  await clickImage(ed, { x: rect.box.x, y: rect.box.y + 60 * d });
  const away = await toPage(ed, 1150 * d, 760 * d);
  await ed.mouse.move(away.x, away.y);
  await shot(ed, '2-rect-selected.png', { x: 200 * d, y: 270 * d, w: 460 * d, h: 260 * d });

  // Cursors over handles.
  for (const h of ['nw', 'n', 'e', 'rot']) {
    const p = await handlePage(ed, 'r1', h);
    await ed.mouse.move(p.x - 2, p.y);
    await ed.mouse.move(p.x, p.y);
    cursors[`rect ${h}`] = await cursor(ed);
  }

  // 3. Rotate it about -12° with the handle.
  const rot = await handle(ed, 'r1', 'rot');
  const c = { x: rect.box.x + rect.box.w / 2, y: rect.box.y + rect.box.h / 2 };
  const ang = (-102 * Math.PI) / 180;
  await dragImage(
    ed,
    rot,
    { x: c.x + Math.cos(ang) * 300, y: c.y + Math.sin(ang) * 300 },
    {
      steps: 12,
    },
  );
  for (const h of ['nw', 'n', 'e', 'rot']) {
    const p = await handlePage(ed, 'r1', h);
    await ed.mouse.move(p.x - 2, p.y);
    await ed.mouse.move(p.x, p.y);
    cursors[`rotated ${h}`] = await cursor(ed);
  }
  await ed.mouse.move(away.x, away.y);
  await shot(ed, '3-rect-rotated.png', { x: 200 * d, y: 250 * d, w: 460 * d, h: 290 * d });

  // 4. Bent arrow with its handles.
  await clickImage(ed, { x: (arrow.a.x + arrow.b.x) / 2, y: (arrow.a.y + arrow.b.y) / 2 });
  const mid = await handle(ed, 'a1', 'mid');
  await dragImage(ed, mid, { x: mid.x + 50 * d, y: mid.y - 60 * d }, { steps: 10 });
  const pm = await handlePage(ed, 'a1', 'mid');
  await ed.mouse.move(pm.x, pm.y);
  cursors['arrow mid'] = await cursor(ed);
  await ed.mouse.move(away.x, away.y);
  await shot(ed, '4-arrow-bent.png', { x: 600 * d, y: 430 * d, w: 320 * d, h: 240 * d });

  // 5. Text with handles.
  await clickImage(ed, { x: text.at.x + 60 * d, y: text.at.y + 16 * d });
  await ed.mouse.move(away.x, away.y);
  await shot(ed, '5-text-handles.png', { x: 720 * d, y: 70 * d, w: 420 * d, h: 120 * d });

  // 6. Toolbar follows the selection: a blue rect at 8 px.
  await clickImage(ed, { x: rect.box.x + 2 * d, y: rect.box.y + 60 * d });
  await ed.keyboard.press('5');
  await ed.getByTestId('size-button').click();
  await ed.locator('[data-size="8"]').click();
  await ed.mouse.move(away.x, away.y);
  await ed.waitForTimeout(150);
  const bar = await ed.getByTestId('toolbar').boundingBox();
  if (bar) {
    await ed.screenshot({
      path: join(DIR as string, '6-toolbar-selection.png'),
      clip: { x: 0, y: 0, width: bar.width, height: bar.y + bar.height + 330 },
    });
  }
  await ed.getByTestId('size-button').click();
  await ed.waitForTimeout(200);
  await ed.screenshot({
    path: join(DIR as string, '6b-size-menu-rect.png'),
    clip: { x: 300, y: 0, width: 680, height: 460 },
  });
  await ed.keyboard.press('Escape');

  // 7. Cursor sheet.
  const sheet = await ed.context().newPage();
  await sheet.setViewportSize({ width: 760, height: 360 });
  const items = Object.entries(cursors)
    .map(([name, css]) => {
      const m = /url\("([^"]+)"\)/.exec(css);
      const img = m
        ? `<img src="${m[1]}" width="24" height="24">`
        : `<span class="kw">${css}</span>`;
      return `<div class="c"><div class="sw light">${img}</div><div class="sw dark">${img}</div><div class="n">${name}</div></div>`;
    })
    .join('');
  await sheet.setContent(
    `<style>body{font:12px system-ui;margin:16px;display:flex;flex-wrap:wrap;gap:12px}.c{width:110px}.sw{height:40px;display:grid;place-items:center}.light{background:#fff;border:1px solid #ddd}.dark{background:#333}.kw{font:11px monospace;color:#c00}.n{margin-top:4px}</style>${items}`,
  );
  await sheet.screenshot({ path: join(DIR as string, '7-cursors.png'), fullPage: true });
  await sheet.close();
});
