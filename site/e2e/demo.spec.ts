/**
 * The website demo runs the real editor: capture the fictional page, draw with the tools, copy,
 * and read the PNG back from the clipboard. Also checks the embedding seam: the editor's keys
 * only work while the demo is in use.
 */
import { expect, type Page, test } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const RED = [255, 59, 48] as const;

async function openEditor(page: Page) {
  await page.goto('/');
  await page.locator('#demo').scrollIntoViewIfNeeded();
  const demo = page.getByTestId('demo');
  await expect(demo).toBeVisible();
  await demo.getByTestId('demo-icon').click();
  await expect(demo.getByTestId('demo-progress')).toBeVisible();
  await expect(demo.locator('[data-testid="editor-root"][data-phase="ready"]')).toBeVisible({
    timeout: 30_000,
  });
  return demo;
}

/** Count clearly red pixels in the PNG on the clipboard, and return its size. */
async function readClipboardPng(page: Page) {
  return page.evaluate(async (red) => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return null;
    const blob = await item.getType('image/png');
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let reds = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (
        Math.abs((px[i] ?? 0) - red[0]) < 24 &&
        Math.abs((px[i + 1] ?? 0) - red[1]) < 30 &&
        Math.abs((px[i + 2] ?? 0) - red[2]) < 30
      )
        reds++;
    }
    return { w: bmp.width, h: bmp.height, reds };
  }, RED);
}

test('desktop: capture, draw every kind of mark, edit, undo, copy', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  const demo = await openEditor(page);
  const canvas = demo.getByTestId('editor-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const at = (fx: number, fy: number) => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });
  const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
  };
  const done = (step: string) => demo.locator(`.dm-step[data-step="${step}"]`);

  // The arrow tool is armed.
  await expect(demo.locator('button[data-tool="arrow"]')).toHaveAttribute('aria-pressed', 'true');
  await drag(at(0.15, 0.7), at(0.3, 0.55));
  await expect(done('arrow')).toHaveAttribute('data-done');

  await page.keyboard.press('r');
  await drag(at(0.55, 0.3), at(0.75, 0.45));
  await expect(done('rect')).toHaveAttribute('data-done');

  await page.keyboard.press('h');
  await drag(at(0.4, 0.8), at(0.6, 0.8));
  await expect(done('highlight')).toHaveAttribute('data-done');

  await page.keyboard.press('u');
  await drag(at(0.4, 0.88), at(0.6, 0.88));
  await page.keyboard.press('p');
  await drag(at(0.1, 0.2), at(0.2, 0.3));

  await page.keyboard.press('t');
  await page.mouse.click(at(0.8, 0.75).x, at(0.8, 0.75).y);
  await page.keyboard.type('Why $10?');
  await page.keyboard.press('Enter');
  await expect(done('text')).toHaveAttribute('data-done');

  // Click a mark with any tool to move it.
  await page.keyboard.press('a');
  await drag(at(0.75, 0.375), at(0.7, 0.33));
  await expect(done('edit')).toHaveAttribute('data-done');

  // Undo and redo go through the real history.
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Shift+Meta+z');

  await page.keyboard.press('Meta+c');
  await expect(demo.getByTestId('toast-title')).toContainText(/Copied/);
  await expect(done('copy')).toHaveAttribute('data-done');
  const png = await readClipboardPng(page);
  expect(png).not.toBeNull();
  // The page is 3,338 px tall, so ⌘C copies a slice of at most 2,576 px, at 1 px per CSS px.
  expect(png?.w).toBe(1200);
  expect(png?.h).toBeLessThanOrEqual(2576);
  expect(png?.reds).toBeGreaterThan(2000);

  // Paste it into the box under the demo.
  await page.getByTestId('paste-input').click();
  await page.keyboard.press('Meta+v');
  await expect(page.getByTestId('paste-result')).toContainText(`1,200 ×`);

  // Start over removes the editor tab.
  await demo.getByTestId('demo-reset').click();
  await expect(demo.getByTestId('editor-tab')).toHaveCount(0);
});

test('desktop: the editor only takes keys while the demo is in use', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  const demo = await openEditor(page);
  const rect = demo.locator('button[data-tool="rect"]');

  // Click outside the demo: R is the page's again, and Space scrolls the page.
  await page.locator('#f-markup').click();
  await page.keyboard.press('r');
  await expect(rect).toHaveAttribute('aria-pressed', 'false');
  const before = await page.evaluate(() => scrollY);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before);

  // Click the capture: the keys are the editor's.
  await page.locator('#demo').scrollIntoViewIfNeeded();
  const box = await demo.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  await page.keyboard.press('r');
  await expect(rect).toHaveAttribute('aria-pressed', 'true');
});

test('phone: tap the tools, draw with a finger, copy', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'phone');
  const demo = await openEditor(page);
  const box = await demo.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const cdp = await context.newCDPSession(page);
  const swipe = async (x0: number, y0: number, x1: number, y1: number) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x0, y: y0 }],
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 + ((x1 - x0) * i) / 10, y: y0 + ((y1 - y0) * i) / 10 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe(box.x + 60, box.y + 300, box.x + 200, box.y + 200);
  await demo.locator('button[data-tool="rect"]').tap();
  await swipe(box.x + 80, box.y + 100, box.x + 260, box.y + 180);
  await expect(demo.locator('.dm-step[data-step="rect"]')).toHaveAttribute('data-done');
  await demo.getByTestId('copy-button').tap();
  await expect(demo.getByTestId('toast-title')).toContainText(/Copied/);
  const png = await readClipboardPng(page);
  expect(png?.w).toBe(390);
  expect(png?.reds).toBeGreaterThan(500);
});
