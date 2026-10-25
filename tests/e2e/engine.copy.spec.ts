import type { Page } from '@playwright/test';
import {
  countColor,
  dragImage,
  hexToRgb,
  near,
  pixel,
  readClipboardPng,
  snapshot,
  waitReady,
} from './engine.helpers';
import { expect, test } from './fixtures';

const RED = hexToRgb('#FF3B30');

let reader: Page;

test.beforeEach(async ({ context, pagesnap }) => {
  reader = await pagesnap.openFixture('short');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(reader.url()).origin,
  });
});

async function copyAndRead(ed: Page, keys: string) {
  await ed.bringToFront();
  await ed.keyboard.press(keys);
  await expect
    .poll(async () => (await snapshot(ed)).copy.state, { timeout: 20_000 })
    .toBe('copied');
  const s = await snapshot(ed);
  const png = await readClipboardPng(reader);
  return { s, png };
}

test('Cmd+C on a short page copies the whole annotated image at 1x', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 2000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await dragImage(ed, { x: 300, y: 600 }, { x: 1300, y: 900 });
  const { s, png } = await copyAndRead(ed, 'ControlOrMeta+c');
  expect(s.copy).toMatchObject({ outcome: 'full', size: { w: 1280, h: 2000 }, tall: false });
  expect([png.width, png.height]).toEqual([1280, 2000]);
  // Arrow shaft midpoint (image (800, 750) → CSS (400, 375)).
  expect(near(pixel(png, 400, 375), RED, 10)).toBe(true);
  expect(countColor(png, RED, { x: 150, y: 300, w: 520, h: 160 }, 10)).toBeGreaterThan(500);
});

test('Cmd+C on a tall page copies the smart region; Shift+Cmd+C copies the full page', async ({
  pagesnap,
}) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 8000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.setCamera({ y: 9800 }),
  );
  await dragImage(ed, { x: 300, y: 10_000 }, { x: 1300, y: 10_300 });

  const smart = await copyAndRead(ed, 'ControlOrMeta+c');
  expect(smart.s.copy.outcome).toBe('smart');
  const size = smart.s.copy.size as { w: number; h: number };
  expect(size.w).toBe(1280);
  expect(size.h).toBeLessThanOrEqual(2576);
  // bbox (~300 image px + head) padded by 160 CSS px each side.
  expect(size.h).toBeGreaterThan(160 * 2 + 150);
  expect([smart.png.width, smart.png.height]).toEqual([size.w, size.h]);
  expect(countColor(smart.png, RED, undefined, 10)).toBeGreaterThan(500);

  const full = await copyAndRead(ed, 'ControlOrMeta+Shift+c');
  expect(full.s.copy).toMatchObject({ outcome: 'full', size: { w: 1280, h: 8000 }, tall: true });
  expect([full.png.width, full.png.height]).toEqual([1280, 8000]);
  // The arrow sits at CSS y ≈ 5000–5150 in the full copy.
  expect(countColor(full.png, RED, { x: 100, y: 4950, w: 600, h: 250 }, 10)).toBeGreaterThan(500);
});

test('Cmd+C on a tall page without annotations copies the current view', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 8000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.setCamera({ y: 6000 }),
  );
  const { s, png } = await copyAndRead(ed, 'ControlOrMeta+c');
  expect(s.copy.outcome).toBe('viewport');
  const view = s.viewport.h / s.camera.zoom / s.dpr; // CSS px visible
  expect(png.width).toBe(1280);
  expect(Math.abs(png.height - view)).toBeLessThanOrEqual(2);
  // Band at CSS y 3000 + 100 → band 6 (#f032e6).
  expect(near(pixel(png, 640, 100), hexToRgb('#f032e6'), 3)).toBe(true);
});
