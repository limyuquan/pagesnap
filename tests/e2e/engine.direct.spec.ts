/**
 * Direct manipulation: with any tool active, a press on a mark selects and moves it, its handles
 * resize / rotate / bend it, Alt draws on top, and every gesture is one undo step.
 */
import type { Page } from '@playwright/test';
import {
  clickImage,
  dragImage,
  exportPng,
  hexToRgb,
  near,
  pixel,
  readClipboardPng,
  snapshot,
  toPage,
  waitReady,
} from './engine.helpers';
import { expect, test } from './fixtures';

const RED = hexToRgb('#FF3B30');
const BLUE = '#0A84FF';

type P = { x: number; y: number };
type AnyShape = { id: string; kind: string; [k: string]: unknown };

const RECT = {
  id: 'r1',
  kind: 'rect',
  color: '#FF3B30',
  shadow: false,
  box: { x: 400, y: 2200, w: 600, h: 400 },
  width: 10,
  fill: 'none',
};
const TEXT = {
  id: 't1',
  kind: 'text',
  color: '#FF3B30',
  shadow: false,
  at: { x: 1400, y: 2200 },
  text: 'Hello',
  size: 52,
  weight: 700,
  style: 'outline',
};
const ARROW = {
  id: 'a1',
  kind: 'arrow',
  color: '#FF3B30',
  shadow: false,
  a: { x: 400, y: 2900 },
  b: { x: 1200, y: 2900 },
  width: 12,
  bend: 0,
  heads: 'end',
};

async function open(
  pagesnap: {
    seedSession: (o: object) => Promise<string>;
    openEditor: (id: string) => Promise<Page>;
  },
  cssH = 3000,
  y = 2000,
): Promise<Page> {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (y) => (window as any).__pagesnapEngine.state().actions.setCamera({ y }),
    y,
  );
  return ed;
}

/** Add shapes as one commit (setup, not under test). */
async function seed(ed: Page, shapes: object[]): Promise<void> {
  await ed.evaluate((shapes) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const s = (window as any).__pagesnapEngine.state();
    s._engine._commit({ ...s.doc, shapes: [...s.doc.shapes, ...shapes] }, []);
  }, shapes);
}

const shape = async (ed: Page, id: string): Promise<AnyShape> => {
  const s = await snapshot(ed);
  const sh = s.shapes.find((x) => x.id === id);
  if (!sh) throw new Error(`no shape ${id}`);
  return sh as AnyShape;
};

/** A handle's image-px position, as the editor shows it. */
async function handle(ed: Page, id: string, h: string): Promise<P> {
  const hs: { id: string; x: number; y: number }[] = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (id) => (window as any).__pagesnapEngine.handles(id),
    id,
  );
  const found = hs.find((x) => x.id === h);
  if (!found) throw new Error(`no handle ${h} on ${id}: ${hs.map((x) => x.id).join()}`);
  return { x: found.x, y: found.y };
}

async function hoverAt(ed: Page, p: P): Promise<{ cursor: string; hover: string | null }> {
  const q = await toPage(ed, p.x, p.y);
  await ed.mouse.move(q.x - 3, q.y);
  await ed.mouse.move(q.x, q.y);
  return ed.evaluate(() => ({
    cursor: (document.querySelector('[data-testid="editor-canvas"]') as HTMLElement).style.cursor,
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    hover: (window as any).__pagesnapEngine.hover() as string | null,
  }));
}

async function undo(ed: Page) {
  await ed.keyboard.press('ControlOrMeta+z');
}
async function redo(ed: Page) {
  await ed.keyboard.press('ControlOrMeta+Shift+z');
}

/** Image px per screen CSS px (mouse positions are whole CSS px). */
async function slop(ed: Page): Promise<number> {
  return 1.5 / (await snapshot(ed)).camera.zoom;
}

test('Arrow tool: hover shows move, press-drag moves the rect without drawing, empty draws', async ({
  pagesnap,
}) => {
  const ed = await open(pagesnap);
  await seed(ed, [RECT]);
  expect((await snapshot(ed)).tool).toBe('arrow');

  // Hover: on the border → move + outline; inside the hollow box and on empty page → crosshair.
  expect(await hoverAt(ed, { x: 400, y: 2400 })).toEqual({ cursor: 'move', hover: 'r1' });
  expect(await hoverAt(ed, { x: 700, y: 2400 })).toEqual({ cursor: 'crosshair', hover: null });
  expect(await hoverAt(ed, { x: 1800, y: 2800 })).toEqual({ cursor: 'crosshair', hover: null });

  const rev0 = (await snapshot(ed)).rev;
  await dragImage(ed, { x: 400, y: 2400 }, { x: 500, y: 2450 });
  let s = await snapshot(ed);
  expect(s.shapes).toHaveLength(1); // no arrow
  expect(s.selection).toEqual(['r1']);
  expect(s.tool).toBe('arrow');
  const box = (s.shapes[0] as unknown as typeof RECT).box;
  const tol = await slop(ed);
  expect(Math.abs(box.x - 500)).toBeLessThan(tol);
  expect(Math.abs(box.y - 2250)).toBeLessThan(tol);
  expect(s.rev).toBe(rev0 + 1);
  await undo(ed);
  expect(((await shape(ed, 'r1')) as unknown as typeof RECT).box).toEqual(RECT.box);
  await redo(ed);

  // A click (no drag) on the mark only selects it.
  const rev1 = (await snapshot(ed)).rev;
  await clickImage(ed, { x: 1600, y: 2450 }); // empty: deselects
  expect((await snapshot(ed)).selection).toEqual([]);
  await clickImage(ed, { x: box.x, y: 2500 });
  s = await snapshot(ed);
  expect(s.selection).toEqual(['r1']);
  expect(s.rev).toBe(rev1);

  // Press on empty page: deselects and draws an arrow.
  await dragImage(ed, { x: 1500, y: 2700 }, { x: 2100, y: 2850 });
  s = await snapshot(ed);
  expect(s.shapes.map((x) => x.kind)).toEqual(['rect', 'arrow']);
  expect(s.selection).toEqual([]);
  // Drawing inside the hollow rect draws, too.
  await dragImage(ed, { x: 600, y: 2350 }, { x: 900, y: 2550 });
  expect((await snapshot(ed)).shapes.map((x) => x.kind)).toEqual(['rect', 'arrow', 'arrow']);
});

test('rotate a rect with its handle (Arrow tool), one undo step', async ({ pagesnap }) => {
  const ed = await open(pagesnap);
  await seed(ed, [RECT]);
  await clickImage(ed, { x: 400, y: 2400 });
  const rot = await handle(ed, 'r1', 'rot');
  expect((await hoverAt(ed, rot)).cursor).toContain('data:image/svg+xml');
  const rev0 = (await snapshot(ed)).rev;
  // From above the centre to its right: a quarter turn clockwise (soft-snaps to exactly 90°).
  await dragImage(ed, rot, { x: 700 + 500, y: 2400 }, { steps: 12 });
  let r = await shape(ed, 'r1');
  expect(r.rotation as number).toBeCloseTo(Math.PI / 2, 6);
  expect(r.box).toEqual(RECT.box);
  let s = await snapshot(ed);
  expect(s.rev).toBe(rev0 + 1);
  expect(s.shapes).toHaveLength(1);
  // Shift snaps to 15°.
  const rot2 = await handle(ed, 'r1', 'rot');
  await ed.keyboard.down('Shift');
  await dragImage(ed, rot2, { x: 700 + 400, y: 2400 + 120 }, { steps: 10 });
  await ed.keyboard.up('Shift');
  r = await shape(ed, 'r1');
  const deg = ((r.rotation as number) * 180) / Math.PI;
  expect(Math.abs(deg - Math.round(deg / 15) * 15)).toBeLessThan(1e-6);
  expect(deg).toBeGreaterThan(90);
  await undo(ed);
  expect((await shape(ed, 'r1')).rotation as number).toBeCloseTo(Math.PI / 2, 6);
  await undo(ed);
  expect((await shape(ed, 'r1')).rotation).toBeUndefined();

  // A rotated rect hit-tests on its rotated border: hover there says move.
  await redo(ed);
  s = await snapshot(ed);
  expect((await hoverAt(ed, { x: 800, y: 2100 })).hover).toBe('r1'); // rotated end edge
  expect((await hoverAt(ed, { x: 400, y: 2400 })).hover).toBeNull(); // old left edge
});

test('text: a corner grows the font, a side sets the wrap width', async ({ pagesnap }) => {
  const ed = await open(pagesnap);
  await seed(ed, [TEXT]);
  await ed.keyboard.press('r'); // any tool
  const box = await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const s = (window as any).__pagesnapEngine;
    const hs = s.handles('t1') as { id: string; x: number; y: number }[];
    const nw = hs.find((h) => h.id === 'nw');
    const se = hs.find((h) => h.id === 'se');
    return nw && se ? { nw, se } : null;
  });
  if (!box) throw new Error('no text handles');
  const mid = { x: (box.nw.x + box.se.x) / 2, y: (box.nw.y + box.se.y) / 2 };
  expect((await hoverAt(ed, mid)).cursor).toBe('move');
  await clickImage(ed, mid);
  expect((await snapshot(ed)).selection).toEqual(['t1']);
  const rev0 = (await snapshot(ed)).rev;

  const se = await handle(ed, 't1', 'se');
  await dragImage(ed, se, { x: se.x + 240, y: se.y + 120 }, { steps: 10 });
  let t = await shape(ed, 't1');
  expect(t.size as number).toBeGreaterThan(70);
  // The opposite corner stays put.
  const nw = await handle(ed, 't1', 'nw');
  const tol = await slop(ed);
  expect(Math.abs(nw.x - box.nw.x)).toBeLessThan(tol);
  expect(Math.abs(nw.y - box.nw.y)).toBeLessThan(tol);
  expect((await snapshot(ed)).rev).toBe(rev0 + 1);
  expect((await snapshot(ed)).shapes).toHaveLength(1); // no rect drawn

  // The east side sets a wrap width.
  const e = await handle(ed, 't1', 'e');
  await dragImage(ed, e, { x: e.x - 60, y: e.y }, { steps: 6 });
  t = await shape(ed, 't1');
  expect(t.maxW).toBeGreaterThan(0);

  await undo(ed);
  expect((await shape(ed, 't1')).maxW).toBeUndefined();
  await undo(ed);
  expect((await shape(ed, 't1')).size).toBe(52);
});

test('bend an arrow with its middle handle; the export shows the curve', async ({ pagesnap }) => {
  const ed = await open(pagesnap);
  await seed(ed, [ARROW]);
  await clickImage(ed, { x: 800, y: 2900 });
  expect((await snapshot(ed)).selection).toEqual(['a1']);
  const mid = await handle(ed, 'a1', 'mid');
  expect(mid).toEqual({ x: 800, y: 2900 });
  expect((await hoverAt(ed, mid)).cursor).toBe('pointer');
  const rev0 = (await snapshot(ed)).rev;
  await dragImage(ed, mid, { x: 800, y: 2700 }, { steps: 10 });
  const a = await shape(ed, 'a1');
  const tol = await slop(ed);
  expect(Math.abs((a.bend as number) + 400)).toBeLessThan(2 * tol); // curve through y 2700
  expect(a.a).toEqual(ARROW.a);
  expect(a.b).toEqual(ARROW.b);
  expect((await snapshot(ed)).rev).toBe(rev0 + 1);
  const png = await exportPng(ed, 'full');
  expect(near(pixel(png, 800, 2702), RED, 12)).toBe(true); // the apex
  expect(near(pixel(png, 800, 2900), RED, 12)).toBe(false); // not the chord
  await undo(ed);
  expect((await shape(ed, 'a1')).bend).toBe(0);
});

test('Alt draws on top of a mark; Alt-drag of the selection duplicates it', async ({
  pagesnap,
}) => {
  const ed = await open(pagesnap);
  await seed(ed, [RECT]);
  expect((await hoverAt(ed, { x: 400, y: 2400 })).cursor).toBe('move');
  await ed.keyboard.down('Alt');
  // Alt over an unselected mark: the tool's cursor (a press draws).
  expect((await hoverAt(ed, { x: 400, y: 2401 })).cursor).toBe('crosshair');
  await dragImage(ed, { x: 400, y: 2400 }, { x: 1000, y: 2900 });
  await ed.keyboard.up('Alt');
  let s = await snapshot(ed);
  expect(s.shapes.map((x) => x.kind)).toEqual(['rect', 'arrow']);
  expect((s.shapes[0] as unknown as typeof RECT).box).toEqual(RECT.box);

  // Select the rect, then Alt-drag it: a copy moves, the original stays.
  await clickImage(ed, { x: 1000, y: 2300 });
  expect((await snapshot(ed)).selection).toEqual(['r1']);
  const rev0 = (await snapshot(ed)).rev;
  await ed.keyboard.down('Alt');
  expect((await hoverAt(ed, { x: 1000, y: 2301 })).cursor).toBe('copy');
  await dragImage(ed, { x: 1000, y: 2300 }, { x: 1300, y: 2300 });
  await ed.keyboard.up('Alt');
  s = await snapshot(ed);
  expect(s.shapes.map((x) => x.kind)).toEqual(['rect', 'arrow', 'rect']);
  const copy = s.shapes[2] as unknown as typeof RECT;
  expect(copy.id).not.toBe('r1');
  expect(Math.abs(copy.box.x - 700)).toBeLessThan(await slop(ed));
  expect(s.selection).toEqual([copy.id]);
  expect(s.rev).toBe(rev0 + 1);
  await undo(ed);
  expect((await snapshot(ed)).shapes).toHaveLength(2);
});

test('the toolbar shows and edits the selection; ⌘D duplicates', async ({ pagesnap }) => {
  const ed = await open(pagesnap);
  await seed(ed, [RECT]);
  await clickImage(ed, { x: 400, y: 2400 });
  // Rect stroke 10 image px at DPR 2 = 5 CSS px.
  await expect(ed.getByTestId('size-value')).toHaveText('5');
  await expect(ed.getByTestId('color-button')).toHaveAttribute('aria-label', /Red/);

  await ed.getByTestId('color-button').click();
  await ed.locator(`[data-color="${BLUE}"]`).click();
  let s = await snapshot(ed);
  expect(s.shapes[0]).toMatchObject({ id: 'r1', color: BLUE });
  await expect(ed.getByTestId('color-button')).toHaveAttribute('aria-label', /Blue/);
  // The Arrow tool's own default is untouched.
  const arrowColor = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    () => (window as any).__pagesnapEngine.state().styles.arrow.color,
  );
  expect(arrowColor).toBe('#FF3B30');

  await ed.getByTestId('size-button').click();
  await ed.locator('[data-size="8"]').click();
  expect(await shape(ed, 'r1')).toMatchObject({ width: 16 });
  await ed.getByTestId('size-button').click();
  await ed.locator('button[data-fill="tint"]').click();
  expect(await shape(ed, 'r1')).toMatchObject({ fill: 'tint' });
  // ] steps the selection's size; a key colour too.
  await ed.getByTestId('editor-canvas').focus();
  await ed.keyboard.press(']');
  expect(await shape(ed, 'r1')).toMatchObject({ width: 24 });
  await ed.keyboard.press('4');
  expect(await shape(ed, 'r1')).toMatchObject({ color: '#34C759' });
  for (let i = 0; i < 5; i++) await undo(ed);
  expect(await shape(ed, 'r1')).toMatchObject({ color: '#FF3B30', width: 10, fill: 'none' });

  // ⌘D: a copy 16 CSS px (32 image px) down-right, selected; one undo step.
  await clickImage(ed, { x: 400, y: 2400 });
  await ed.keyboard.press('ControlOrMeta+d');
  s = await snapshot(ed);
  expect(s.shapes).toHaveLength(2);
  const dup = s.shapes[1] as unknown as typeof RECT;
  expect(dup.box).toEqual({ ...RECT.box, x: 432, y: 2232 });
  expect(s.selection).toEqual([dup.id]);
  // Cmd+A selects all, keeping the tool; Delete removes; Esc deselects.
  await ed.keyboard.press('ControlOrMeta+a');
  s = await snapshot(ed);
  expect(s.selection).toHaveLength(2);
  expect(s.tool).toBe('arrow');
  await ed.keyboard.press('Escape');
  expect((await snapshot(ed)).selection).toEqual([]);
  await undo(ed);
  expect((await snapshot(ed)).shapes).toHaveLength(1);
});

test('multi-selection: Shift-click with any tool, group box scales proportionally', async ({
  pagesnap,
}) => {
  const ed = await open(pagesnap);
  await seed(ed, [RECT, ARROW]);
  await clickImage(ed, { x: 400, y: 2400 });
  await ed.keyboard.down('Shift');
  await clickImage(ed, { x: 800, y: 2900 });
  await ed.keyboard.up('Shift');
  let s = await snapshot(ed);
  expect(new Set(s.selection)).toEqual(new Set(['r1', 'a1']));
  const rev0 = s.rev;
  // Drag the group's south-east corner: everything scales about the north-west corner.
  const b = await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const st = (window as any).__pagesnapEngine.state();
    const ids = new Set(st.selection);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const sh of st.doc.shapes) {
      if (!ids.has(sh.id)) continue;
      const pts =
        sh.kind === 'rect'
          ? [sh.box, { x: sh.box.x + sh.box.w, y: sh.box.y + sh.box.h }]
          : [sh.a, sh.b];
      for (const p of pts) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    return { x0, y0, x1, y1 };
  });
  // The group box includes strokes and the head, so grab just inside its corner region.
  const corner = { x: b.x1 + 10, y: b.y1 + 25 };
  const before = await hoverAt(ed, corner);
  expect(before.cursor).toContain('data:image/svg+xml');
  await dragImage(ed, corner, { x: corner.x + 300, y: corner.y + 200 }, { steps: 10 });
  s = await snapshot(ed);
  const r = s.shapes[0] as unknown as typeof RECT;
  expect(r.box.w).toBeGreaterThan(600 * 1.15);
  expect(r.box.w / r.box.h).toBeCloseTo(1.5, 2);
  expect(s.rev).toBe(rev0 + 1);
  await undo(ed);
  expect(((await shape(ed, 'r1')) as unknown as typeof RECT).box).toEqual(RECT.box);
});

test('⌘C contains a mark rotated with its handle', async ({ context, pagesnap }) => {
  const reader = await pagesnap.openFixture('short');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(reader.url()).origin,
  });
  // Short page (≤ 2576 CSS px): ⌘C copies the whole page at 1x.
  const ed = await open(pagesnap, 2000, 0);
  const rect = { ...RECT, box: { x: 1000, y: 800, w: 600, h: 400 }, width: 20 };
  await seed(ed, [rect]);
  await clickImage(ed, { x: 1000, y: 1000 });
  const rot = await handle(ed, 'r1', 'rot');
  // Up and to the right of the centre (1300, 1000), Shift: exactly 45°.
  await ed.keyboard.down('Shift');
  await dragImage(ed, rot, { x: 1300 + 300, y: 1000 - 300 }, { steps: 12 });
  await ed.keyboard.up('Shift');
  expect((await shape(ed, 'r1')).rotation as number).toBeCloseTo(Math.PI / 4, 9);

  await ed.bringToFront();
  await ed.keyboard.press('ControlOrMeta+c');
  await expect
    .poll(async () => (await snapshot(ed)).copy.state, { timeout: 20_000 })
    .toBe('copied');
  const png = await readClipboardPng(reader);
  expect([png.width, png.height]).toEqual([1280, 2000]);
  // Top edge midpoint, rotated 45° about the centre: image (1441.4, 858.6) → 1x (720.7, 429.3).
  expect(near(pixel(png, 720.7, 429.3), RED, 14)).toBe(true);
  // Where the unrotated top-left corner was, and the centre: no ink.
  expect(near(pixel(png, 503, 403), RED, 14)).toBe(false);
  expect(near(pixel(png, 650, 500), RED, 14)).toBe(false);
});

test('hover hit-testing stays cheap with 200 marks', async ({ pagesnap }) => {
  const ed = await open(pagesnap);
  const shapes: object[] = [];
  for (let i = 0; i < 200; i++) {
    const x = 100 + (i % 20) * 120;
    const y = 2050 + Math.floor(i / 20) * 150;
    const k = i % 4;
    if (k === 0)
      shapes.push({ ...RECT, id: `r${i}`, box: { x, y, w: 90, h: 100 }, rotation: i / 50 });
    else if (k === 1)
      shapes.push({ ...ARROW, id: `a${i}`, a: { x, y }, b: { x: x + 100, y: y + 90 }, bend: 30 });
    else if (k === 2) shapes.push({ ...TEXT, id: `t${i}`, at: { x, y }, text: 'Note', size: 30 });
    else
      shapes.push({
        id: `p${i}`,
        kind: 'pen',
        color: '#FF3B30',
        shadow: false,
        size: 12,
        marker: false,
        pts: Array.from({ length: 60 }, (_, j) => [x + j * 1.5, y + Math.sin(j / 5) * 30, 0.5]),
      });
  }
  await seed(ed, shapes);
  const ms = await ed.evaluate(() => {
    const canvas = document.querySelector('[data-testid="editor-canvas"]') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const t0 = performance.now();
    const n = 400;
    for (let i = 0; i < n; i++) {
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: r.left + ((i * 37) % r.width),
          clientY: r.top + ((i * 53) % r.height),
          pointerId: 1,
          bubbles: true,
        }),
      );
    }
    return (performance.now() - t0) / n;
  });
  console.log(`hover: ${ms.toFixed(3)} ms per pointermove with 200 marks`);
  expect(ms).toBeLessThan(1);
});
