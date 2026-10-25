import {
  clickImage,
  countColor,
  dragImage,
  exportPng,
  hexToRgb,
  near,
  pixel,
  snapshot,
  waitReady,
} from './engine.helpers';
import { expect, test } from './fixtures';

const RED = hexToRgb('#FF3B30');
const BLUE_BAND = hexToRgb('#4363d8'); // band 2: CSS y 1000–1500 → image y 2000–3000 at DPR 2

async function openOnBand2(pagesnap: {
  seedSession: (o: object) => Promise<string>;
  openEditor: (id: string) => Promise<import('@playwright/test').Page>;
}) {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  // Scroll so band 2 (blue) fills the view.
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.setCamera({ y: 2000 }),
  );
  return { id, ed };
}

test('draws every tool with the mouse and exports the pixels', async ({ pagesnap }) => {
  const { ed } = await openOnBand2(pagesnap);
  expect((await snapshot(ed)).tool).toBe('arrow'); // opens with Arrow armed

  await dragImage(ed, { x: 200, y: 2100 }, { x: 800, y: 2300 }); // arrow
  await ed.keyboard.press('r');
  await dragImage(ed, { x: 1000, y: 2100 }, { x: 1400, y: 2400 });
  await ed.keyboard.press('u');
  await dragImage(ed, { x: 200, y: 2500 }, { x: 800, y: 2530 }); // snaps horizontal
  await ed.keyboard.press('h');
  await dragImage(ed, { x: 200, y: 2650 }, { x: 900, y: 2670 });
  await ed.keyboard.press('p');
  await dragImage(ed, { x: 1600, y: 2100 }, { x: 2200, y: 2500 }, { steps: 20 });
  await ed.keyboard.press('t');
  await clickImage(ed, { x: 1600, y: 2700 });
  await ed.keyboard.type('Hi there');
  await ed.keyboard.press('Enter');

  const s = await snapshot(ed);
  expect(s.shapes.map((x) => x.kind)).toEqual([
    'arrow',
    'rect',
    'underline',
    'highlight',
    'pen',
    'text',
  ]);
  const [arrow, rect, underline, highlight, pen, text] = s.shapes as unknown as [
    object,
    object,
    { a: { y: number }; b: { y: number } },
    object,
    { pts: unknown[] },
    object,
  ];
  expect(arrow).toMatchObject({ color: '#FF3B30', width: 12, shadow: true });
  expect(rect).toMatchObject({ width: 10, fill: 'none' });
  expect(underline.a.y).toBe(underline.b.y);
  expect(highlight).toMatchObject({ color: '#FFD60A', thickness: 44, opacity: 0.45 });
  expect(pen.pts.length).toBeGreaterThan(5);
  expect(text).toMatchObject({ text: 'Hi there', size: 52, weight: 700, style: 'outline' });
  expect(s.rev).toBe(6); // one undo step per gesture

  const png = await exportPng(ed, 'full');
  expect([png.width, png.height]).toEqual([2560, 6000]);
  // Arrow shaft midpoint, rect left edge, underline, pen: red ink.
  expect(near(pixel(png, 500, 2200), RED, 8)).toBe(true);
  expect(near(pixel(png, 1000, 2250), RED, 8)).toBe(true);
  expect(near(pixel(png, 500, 2500), RED, 8)).toBe(true);
  // Highlighter multiplies yellow at 45% over the blue band.
  const hl = pixel(png, 550, 2650);
  const expected = BLUE_BAND.map(
    (c, i) => c * (1 - 0.45 + (0.45 * (hexToRgb('#FFD60A')[i] ?? 0)) / 255),
  );
  expect(near(hl, expected, 4), `highlight ${hl} vs ${expected}`).toBe(true);
  // Untouched band stays blue.
  expect(near(pixel(png, 2400, 2900), BLUE_BAND, 2)).toBe(true);
  // Text: red glyph pixels and its white outline around the click point.
  const textBox = { x: 1590, y: 2660, w: 400, h: 90 };
  expect(countColor(png, RED, textBox, 10)).toBeGreaterThan(200);
  expect(countColor(png, [255, 255, 255], textBox, 10)).toBeGreaterThan(100);
  // Pen: red along the stroke.
  expect(countColor(png, RED, { x: 1600, y: 2100, w: 600, h: 400 }, 10)).toBeGreaterThan(1000);
});

test('Shift snaps arrows to 45° and rects to squares', async ({ pagesnap }) => {
  const { ed } = await openOnBand2(pagesnap);
  await dragImage(ed, { x: 200, y: 2100 }, { x: 800, y: 2420 }, { shift: true });
  await ed.keyboard.press('r');
  await dragImage(ed, { x: 1000, y: 2100 }, { x: 1300, y: 2500 }, { shift: true });
  const [arrow, rect] = (await snapshot(ed)).shapes as unknown as [
    { a: { x: number; y: number }; b: { x: number; y: number } },
    { box: { w: number; h: number } },
  ];
  const deg = (Math.atan2(arrow.b.y - arrow.a.y, arrow.b.x - arrow.a.x) * 180) / Math.PI;
  expect(Math.abs(deg - 45)).toBeLessThan(0.01);
  expect(rect.box.w).toBeCloseTo(rect.box.h, 5);
});

test('select: click, drag to move, handles resize, Delete removes, Esc deselects', async ({
  pagesnap,
}) => {
  const { ed } = await openOnBand2(pagesnap);
  await ed.keyboard.press('r');
  await dragImage(ed, { x: 400, y: 2200 }, { x: 800, y: 2500 });
  await ed.keyboard.press('a');
  await dragImage(ed, { x: 1200, y: 2200 }, { x: 1600, y: 2400 });
  await ed.keyboard.press('v');

  // Click the rect's border (away from its handles), then drag it by (100, 50).
  await clickImage(ed, { x: 400, y: 2280 });
  let s = await snapshot(ed);
  expect(s.selection).toEqual([s.shapes[0]?.id]);
  await dragImage(ed, { x: 400, y: 2280 }, { x: 500, y: 2330 });
  s = await snapshot(ed);
  const box = (s.shapes[0] as unknown as { box: { x: number; y: number; w: number; h: number } })
    .box;
  expect(box.x).toBeCloseTo(500, 0);
  expect(box.y).toBeCloseTo(2250, 0);

  // Drag the south-east handle.
  await dragImage(ed, { x: 900, y: 2550 }, { x: 1000, y: 2700 });
  s = await snapshot(ed);
  const resized = (s.shapes[0] as unknown as { box: { w: number; h: number } }).box;
  expect(resized.w).toBeCloseTo(500, 0);
  expect(resized.h).toBeCloseTo(450, 0);

  // Arrow endpoint handle.
  await clickImage(ed, { x: 1400, y: 2300 });
  s = await snapshot(ed);
  expect(s.selection).toEqual([s.shapes[1]?.id]);
  await dragImage(ed, { x: 1600, y: 2400 }, { x: 1700, y: 2600 });
  s = await snapshot(ed);
  expect((s.shapes[1] as unknown as { b: { x: number; y: number } }).b).toEqual(
    expect.objectContaining({ x: expect.closeTo(1700, 0), y: expect.closeTo(2600, 0) }),
  );

  await ed.keyboard.press('Escape');
  expect((await snapshot(ed)).selection).toEqual([]);

  await clickImage(ed, { x: 1450, y: 2400 });
  await ed.keyboard.press('Delete');
  s = await snapshot(ed);
  expect(s.shapes.map((x) => x.kind)).toEqual(['rect']);
  await clickImage(ed, { x: 500, y: 2400 });
  await ed.keyboard.press('Backspace');
  expect((await snapshot(ed)).shapes).toEqual([]);
});

test('text: Shift+Enter newline, Esc cancels, double-click re-edits, hotkeys stay quiet', async ({
  pagesnap,
}) => {
  const { ed } = await openOnBand2(pagesnap);
  await ed.keyboard.press('t');
  await clickImage(ed, { x: 300, y: 2200 });
  // "a", "r", "v", "1" and "[" are shortcuts outside a text box.
  await ed.keyboard.type('arv1[');
  await ed.keyboard.press('Shift+Enter');
  await ed.keyboard.type('line two');
  let s = await snapshot(ed);
  expect(s.tool).toBe('text');
  expect(s.editingTextId).not.toBeNull();
  await ed.keyboard.press('Enter');
  s = await snapshot(ed);
  expect(s.editingTextId).toBeNull();
  expect(s.shapes).toHaveLength(1);
  expect(s.shapes[0]).toMatchObject({ kind: 'text', text: 'arv1[\nline two', color: '#FF3B30' });

  // Esc on a new text box discards it.
  await clickImage(ed, { x: 300, y: 2700 });
  await ed.keyboard.type('nope');
  await ed.keyboard.press('Escape');
  expect((await snapshot(ed)).shapes).toHaveLength(1);

  // Double-click re-edits (from the select tool).
  await ed.keyboard.press('v');
  const at = (s.shapes[0] as unknown as { at: { x: number; y: number } }).at;
  await clickImage(ed, { x: at.x + 30, y: at.y + 30 }, 2);
  s = await snapshot(ed);
  expect(s.editingTextId).toBe(s.shapes[0]?.id);
  await ed.keyboard.press('ControlOrMeta+a');
  await ed.keyboard.type('edited');
  await ed.keyboard.press('Enter');
  s = await snapshot(ed);
  expect(s.shapes[0]).toMatchObject({ text: 'edited' });

  // Typing right after the double-click keeps what's typed (no late select-all).
  await clickImage(ed, { x: at.x + 30, y: at.y + 30 }, 2);
  await ed.keyboard.press('End');
  await ed.keyboard.press('Shift+Enter');
  await ed.keyboard.type('more');
  await ed.keyboard.press('Enter');
  expect((await snapshot(ed)).shapes[0]).toMatchObject({ text: 'edited\nmore' });

  // Esc while re-editing restores the old text.
  await clickImage(ed, { x: at.x + 30, y: at.y + 30 }, 2);
  await ed.keyboard.type('xxx');
  await ed.keyboard.press('Escape');
  expect((await snapshot(ed)).shapes[0]).toMatchObject({ text: 'edited\nmore' });
});

test('colour keys 1–8 and [ ] size apply to new shapes and the selection', async ({ pagesnap }) => {
  const { ed } = await openOnBand2(pagesnap);
  await ed.keyboard.press('5'); // blue
  await ed.keyboard.press(']'); // 6 → 8 CSS px
  await dragImage(ed, { x: 200, y: 2100 }, { x: 800, y: 2300 });
  let s = await snapshot(ed);
  expect(s.shapes[0]).toMatchObject({ color: '#0A84FF', width: 16 });
  // Highlighter keeps its own colour.
  await ed.keyboard.press('h');
  await dragImage(ed, { x: 200, y: 2500 }, { x: 800, y: 2500 });
  s = await snapshot(ed);
  expect(s.shapes[1]).toMatchObject({ color: '#FFD60A' });
  // Recolour and resize the selected arrow.
  await ed.keyboard.press('v');
  await clickImage(ed, { x: 500, y: 2200 });
  await ed.keyboard.press('7');
  await ed.keyboard.press('[');
  s = await snapshot(ed);
  expect(s.shapes[0]).toMatchObject({ color: '#111111', width: 12 });
});
