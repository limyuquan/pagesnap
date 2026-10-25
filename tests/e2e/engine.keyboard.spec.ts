/**
 * Keyboard (qa-edge E4, E5, E7): scrolling without a pointer, nudging the selection, and ⌘C from
 * inside an open text box.
 */
import type { Page } from '@playwright/test';
import { clickImage, dragImage, readClipboardPng, snapshot, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

async function open(pagesnap: import('./fixtures').PagesnapHelpers) {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 8000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  // Focus the page itself (as after clicking the canvas), not a toolbar button.
  await ed.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return ed;
}

const camY = async (ed: Page) => (await snapshot(ed)).camera.y;

test('arrows, PageUp/PageDown, Space/Shift+Space and Home/End scroll the capture', async ({
  pagesnap,
}) => {
  const ed = await open(pagesnap);
  const s0 = await snapshot(ed);
  const z = s0.camera.zoom;
  const y0 = s0.camera.y;

  await ed.keyboard.press('ArrowDown');
  expect(await camY(ed)).toBeCloseTo(y0 + 48 / z, 3);
  await ed.keyboard.press('ArrowUp');
  expect(await camY(ed)).toBeCloseTo(y0, 3);

  await ed.keyboard.press('PageDown');
  const page = (s0.viewport.h * 0.9) / z;
  expect(await camY(ed)).toBeCloseTo(y0 + page, 3);
  await ed.keyboard.press('PageUp');
  expect(await camY(ed)).toBeCloseTo(y0, 3);

  // A Space tap pages down; Shift+Space pages back up.
  await ed.keyboard.press('Space');
  expect(await camY(ed)).toBeCloseTo(y0 + page, 3);
  await ed.keyboard.press('Shift+Space');
  expect(await camY(ed)).toBeCloseTo(y0, 3);

  await ed.keyboard.press('End');
  const end = await snapshot(ed);
  expect(end.camera.y + end.viewport.h / z).toBeGreaterThan(end.image.h);
  await ed.keyboard.press('Home');
  expect(await camY(ed)).toBeLessThanOrEqual(0);
  // Scrolling by keyboard never zooms.
  expect((await snapshot(ed)).camera.zoom).toBe(z);
});

test('Space on a focused button presses the button and does not scroll', async ({ pagesnap }) => {
  const ed = await open(pagesnap);
  const y0 = await camY(ed);
  await ed.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'probe';
    b.id = 'probe';
    b.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99';
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    b.onclick = () => ((window as any).__probeClicks = ((window as any).__probeClicks ?? 0) + 1);
    document.body.append(b);
    b.focus();
  });
  await ed.keyboard.press('Space');
  await ed.keyboard.press('ArrowDown');
  expect(await camY(ed)).toBe(y0);
  // biome-ignore lint/suspicious/noExplicitAny: test probe
  expect(await ed.evaluate(() => (window as any).__probeClicks)).toBe(1);
});

test('arrows nudge the selection by 1 CSS px (Shift: 10), one undo step per burst', async ({
  pagesnap,
}) => {
  const ed = await open(pagesnap);
  await ed.keyboard.press('r');
  await dragImage(ed, { x: 400, y: 400 }, { x: 900, y: 700 });
  await ed.keyboard.press('v');
  await clickImage(ed, { x: 400, y: 550 });
  const before = await snapshot(ed);
  expect(before.selection).toHaveLength(1);
  const box0 = (before.shapes[0] as unknown as { box: { x: number; y: number } }).box;
  const y0 = before.camera.y;

  await ed.keyboard.press('ArrowRight');
  await ed.keyboard.press('ArrowRight');
  await ed.keyboard.press('Shift+ArrowDown');
  const after = await snapshot(ed);
  const box1 = (after.shapes[0] as unknown as { box: { x: number; y: number } }).box;
  // DPR 2: 1 CSS px = 2 image px.
  expect(box1.x - box0.x).toBe(4);
  expect(box1.y - box0.y).toBe(20);
  expect(after.camera.y).toBe(y0); // the view didn't scroll

  await ed.keyboard.press('ControlOrMeta+z');
  const undone = await snapshot(ed);
  expect((undone.shapes[0] as unknown as { box: { x: number; y: number } }).box).toEqual(box0);
  expect(undone.canUndo).toBe(true); // the rect itself is still one step back
});

test('Cmd+C in an open text box (no text selected) commits the text and copies the image', async ({
  pagesnap,
  context,
}) => {
  const reader = await pagesnap.openFixture('short');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(reader.url()).origin,
  });
  const ed = await open(pagesnap);
  await ed.bringToFront();
  await ed.keyboard.press('t');
  await clickImage(ed, { x: 400, y: 500 });
  await ed.keyboard.type('Hello copy');
  await ed.keyboard.press('ControlOrMeta+c');
  await expect
    .poll(async () => (await snapshot(ed)).copy.state, { timeout: 20_000 })
    .toBe('copied');
  const s = await snapshot(ed);
  expect(s.editingTextId).toBeNull();
  expect(s.shapes).toHaveLength(1);
  expect(s.shapes[0]).toMatchObject({ kind: 'text', text: 'Hello copy' });
  const png = await readClipboardPng(reader);
  expect(png.width).toBe(1280);
});
