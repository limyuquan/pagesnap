import { snapshot, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

test('fit-width by default; wheel pans, Cmd+wheel zooms at the cursor, keyboard zoom', async ({
  pagesnap,
}) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 6000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  let s = await snapshot(ed);
  // Fit width: the whole 2560-px-wide image inside the viewport minus 24 px gutters, ≤ 100%.
  expect(s.camera.zoom).toBeCloseTo(Math.min(0.5, (s.viewport.w - 48) / 2560), 6);
  expect(s.camera.y).toBeLessThan(0); // starts at the top with a little padding

  const box = await ed.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await ed.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Two-finger scroll / wheel pans vertically (and horizontally with deltaX).
  const y0 = s.camera.y;
  await ed.mouse.wheel(0, 400);
  await expect
    .poll(async () => (await snapshot(ed)).camera.y)
    .toBeCloseTo(y0 + 400 / s.camera.zoom, 3);

  // Cmd+wheel zooms around the cursor: the image point under it stays put.
  s = await snapshot(ed);
  const cursor = { x: 300, y: 200 };
  await ed.mouse.move(box.x + cursor.x, box.y + cursor.y);
  const before = {
    x: s.camera.x + cursor.x / s.camera.zoom,
    y: s.camera.y + cursor.y / s.camera.zoom,
  };
  await ed.keyboard.down('ControlOrMeta');
  await ed.mouse.wheel(0, -200);
  await ed.keyboard.up('ControlOrMeta');
  s = await snapshot(ed);
  expect(s.camera.zoom).toBeGreaterThan(0.48);
  // After zooming in, the clamp may shift x only if the page no longer fits; y is never clamped here.
  expect(s.camera.y + cursor.y / s.camera.zoom).toBeCloseTo(before.y, 3);

  await ed.keyboard.press('ControlOrMeta+1');
  expect((await snapshot(ed)).camera.zoom).toBeCloseTo(0.5, 6); // 100% = 1/dpr
  await ed.keyboard.press('ControlOrMeta+=');
  expect((await snapshot(ed)).camera.zoom).toBeCloseTo(0.625, 6);
  await ed.keyboard.press('ControlOrMeta+-');
  expect((await snapshot(ed)).camera.zoom).toBeCloseTo(0.5, 6);
  await ed.keyboard.press('ControlOrMeta+0');
  s = await snapshot(ed);
  expect(s.camera.zoom).toBeCloseTo(Math.min(0.5, (s.viewport.w - 48) / 2560), 6);

  // Space-drag pans and doesn't draw.
  const yBefore = s.camera.y;
  await ed.keyboard.down('Space');
  await ed.mouse.move(box.x + 400, box.y + 400);
  await ed.mouse.down();
  await ed.mouse.move(box.x + 400, box.y + 200, { steps: 5 });
  await ed.mouse.up();
  await ed.keyboard.up('Space');
  s = await snapshot(ed);
  expect(s.camera.y).toBeCloseTo(yBefore + 200 / s.camera.zoom, 3);
  expect(s.shapes).toHaveLength(0);
});

test('the canvas renders crisp 1:1 tiles at DPR 2 and 100%', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await ed.keyboard.press('ControlOrMeta+1');
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.setCamera({ x: 0, y: 960 }),
  );
  await ed.waitForTimeout(300); // rest redraw
  // Read back the canvas: the band boundary at image y 1000 (CSS 500) must be a hard edge (no
  // blended row) when tiles are drawn 1:1. At camera y 960 it falls on device row 40.
  const rows = await ed.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="editor-canvas"]');
    if (!c) throw new Error('no canvas');
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    const d = ctx.getImageData(c.width - 40, 36, 1, 8).data;
    const out: number[][] = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0]);
    return { out, w: c.width, dpr: devicePixelRatio };
  });
  expect(rows.dpr).toBe(2);
  // Rows 36–39 are band 0 (#e6194b), rows 40–43 band 1 (#3cb44b): no intermediate colours.
  expect(rows.out.slice(0, 4)).toEqual(Array(4).fill([0xe6, 0x19, 0x4b]));
  expect(rows.out.slice(4)).toEqual(Array(4).fill([0x3c, 0xb4, 0x4b]));
});
