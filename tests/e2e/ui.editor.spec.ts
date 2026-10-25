/**
 * Editor UI (owner: C): shell, tools, colour/size, toasts, capture states, a11y smoke.
 * Runs against the real engine when it's there; store-driven assertions use the e2e-only
 * `window.__pagesnapUi` hook so they don't depend on clipboard permissions or timing.
 */
import type { Page } from '@playwright/test';
import { type ChromeGlobal, expect, test } from './fixtures';
import { patchSession, setUiState, uiState, waitReady } from './ui.helpers';

test.use({ dpr: 1 });

async function openSeeded(
  pagesnap: { seedSession(o?: object): Promise<string>; openEditor(id: string): Promise<Page> },
  opts: object = { cssW: 1280, cssH: 3000 },
) {
  const id = await pagesnap.seedSession(opts);
  const page = await pagesnap.openEditor(id);
  await waitReady(page, { force: true });
  return { id, page };
}

const tool = (page: Page, name: string) =>
  page
    .getByRole('toolbar', { name: 'Annotation tools' })
    .getByRole('button', { name, exact: true });

test('editor opens with the Arrow tool active', async ({ pagesnap }) => {
  const { id, page } = await openSeeded(pagesnap);
  await expect(page.getByTestId('editor-root')).toHaveAttribute('data-session', id);
  await expect(tool(page, 'Arrow')).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['Select', 'Rectangle', 'Underline', 'Highlighter', 'Pen', 'Text']) {
    await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'false');
  }
  expect((await uiState(page)).tool).toBe('arrow');
  await expect(page.getByTestId('page-title')).toHaveText('Synthetic bands');
  await expect(page.getByRole('button', { name: 'Copy image' })).toBeEnabled();
  await expect(page).toHaveTitle(/Synthetic bands · Page Snap/);
});

test('tools switch by click and by hotkey', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  await tool(page, 'Rectangle').click();
  await expect(tool(page, 'Rectangle')).toHaveAttribute('aria-pressed', 'true');
  await expect(tool(page, 'Arrow')).toHaveAttribute('aria-pressed', 'false');
  expect((await uiState(page)).tool).toBe('rect');

  for (const [key, name, id] of [
    ['h', 'Highlighter', 'highlight'],
    ['p', 'Pen', 'pen'],
    ['t', 'Text', 'text'],
    ['u', 'Underline', 'underline'],
    ['v', 'Select', 'select'],
    ['a', 'Arrow', 'arrow'],
  ] as const) {
    await page.keyboard.press(key);
    await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'true');
    expect((await uiState(page)).tool).toBe(id);
  }
});

test('colour well and size controls drive the store', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  const well = page.getByTestId('color-button');
  await expect(well).toHaveAccessibleName('Colour, Red');

  // The swatches live in a popover row, with their number keys.
  await well.click();
  const colours = page.getByRole('menu', { name: /Colour/ });
  await expect(colours.getByRole('menuitemradio')).toHaveCount(8);
  await expect(colours.getByRole('menuitemradio', { name: 'Red' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(colours.getByRole('menuitemradio', { name: 'Red' })).toBeFocused();
  await expect(colours.getByRole('menuitemradio', { name: 'Blue' })).toHaveText('5');
  await colours.getByRole('menuitemradio', { name: 'Blue' }).click();
  await expect(colours).toBeHidden();
  expect((await uiState(page)).styles.arrow.color.toUpperCase()).toBe('#0A84FF');
  await expect(well).toHaveAccessibleName('Colour, Blue');

  // Keyboard: open, arrows move along the row, Enter picks, focus returns to the well.
  await well.focus();
  await page.keyboard.press('Enter');
  await expect(colours.getByRole('menuitemradio', { name: 'Blue' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(colours.getByRole('menuitemradio', { name: 'Purple' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await uiState(page)).styles.arrow.color.toUpperCase()).toBe('#AF52DE');
  await expect(well).toBeFocused();

  // Number keys (engine shortcut) reflect in the well, popover closed.
  await page.locator('body').click({ position: { x: 5, y: 200 } });
  await page.keyboard.press('1');
  await expect(well).toHaveAccessibleName('Colour, Red');

  // Size menu: each step previews the real stroke.
  await page.getByTestId('size-button').click();
  const menu = page.getByRole('menu', { name: /Stroke width/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: '6 px', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(menu.getByRole('menuitemradio', { name: '6 px', exact: true })).toBeFocused();
  await expect(menu.locator('[data-size="12"] .ps-size-line')).toHaveCSS('height', '12px');
  await menu.getByRole('menuitemradio', { name: '12 px', exact: true }).click();
  await expect(menu).toBeHidden();
  expect((await uiState(page)).styles.arrow.size).toBe(12);
  await expect(page.getByTestId('size-value')).toHaveText('12');

  // ] steps up (engine shortcut), and the control follows.
  await page.keyboard.press(']');
  await expect(page.getByTestId('size-value')).toHaveText('16');

  // Keyboard: open with ArrowDown, move, pick with Enter; Esc closes without switching tools.
  await page.getByTestId('size-button').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  expect((await uiState(page)).styles.arrow.size).toBe(12);
  await page.getByTestId('size-button').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.getByTestId('size-button')).toBeFocused();
  expect((await uiState(page)).tool).toBe('arrow');

  // The highlighter keeps its own colour.
  await tool(page, 'Highlighter').click();
  await expect(well).toHaveAccessibleName(/^Colour, (Yellow|Custom)$/);

  // Select with nothing selected: colour and size are inactive but never blank; they keep
  // showing the last draw tool's style.
  await tool(page, 'Rectangle').click();
  await tool(page, 'Select').click();
  await expect(well).toBeDisabled();
  await expect(well).toHaveAccessibleName('Colour, Red');
  await expect(page.getByTestId('size-button')).toBeDisabled();
  await expect(page.getByTestId('size-value')).toHaveText('5');
});

test('the active tool reads as pressed', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  const look = (name: string) =>
    tool(page, name).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow };
    });
  await page.mouse.move(5, 300);
  const on = await look('Arrow');
  const off = await look('Rectangle');
  expect(on.bg).not.toBe(off.bg);
  expect(on.shadow).toContain('inset');
  // 17% white in dark, 11% black in light (design review §1).
  expect(on.bg).toMatch(/rgba\((255, 255, 255, 0\.17|0, 0, 0, 0\.11)\)/);
});

test('zoom reads Fit in fit-width mode, a percentage after zooming', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  const zoom = page.getByTestId('zoom-value');
  await expect(zoom).toHaveText('Fit');
  await page.getByTestId('zoom-button').click();
  await expect(page.getByRole('menuitemradio', { name: /Fit width/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('menuitemradio', { name: /Actual size/ }).click();
  await expect(zoom).toHaveText('100%');
  await page.getByTestId('zoom-button').click();
  await expect(page.getByRole('menuitemradio', { name: /Actual size/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('menuitemradio', { name: /Fit width/ }).click();
  await expect(zoom).toHaveText('Fit');
});

test('copy toast says what was copied', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap, { cssW: 1280, cssH: 6000 });
  const toast = page.getByTestId('toast');
  const title = page.getByTestId('toast-title');
  let at = Date.now();
  const copied = (outcome: string, h: number, scope?: object, tall = false) =>
    setUiState(page, {
      copy: {
        state: 'copied',
        request: outcome === 'full' ? 'full' : 'default',
        outcome,
        size: { w: 1280, h },
        tall,
        at: at++,
        ...(scope && { scope }),
      } as never,
    });
  const scope = (kind: string, cssTop: number, cssBottom: number) => ({
    kind,
    mode: 'fill',
    region: { x: 0, y: cssTop, w: 1280, h: cssBottom - cssTop },
    cssTop,
    cssBottom,
    cssHeight: cssBottom - cssTop,
    pageCssHeight: 6000,
  });

  await copied('full', 6000, undefined, true);
  await expect(toast).not.toHaveAttribute('data-hidden');
  await expect(title).toHaveText('Copied full page');
  await expect(page.getByTestId('toast-size')).toHaveText('1280 × 6000');
  await expect(toast).toContainText('AI chats will scale it down');
  await expect(page.getByTestId('copy-button')).toHaveAttribute('data-state', 'copied');

  await copied('smart', 2576, scope('fromTop', 0, 2576));
  await expect(title).toHaveText('Copied the top of the page');
  await expect(toast).toContainText('From the top of the page down to 2,576 px.');
  await expect(toast).toContainText(/C copies all 6,000 px\./);

  await copied('smart', 2576, scope('aroundMarks', 1400, 3976));
  await expect(title).toHaveText('Copied around your marks');
  await expect(toast).toContainText(/2,576 of 6,000 px\. .*C copies the whole page\./);

  await copied('viewport', 2576, scope('fromHere', 2000, 4576));
  await expect(title).toHaveText('Copied from here down');
  await expect(toast).toContainText('2,576 of 6,000 px. Mark something to copy around it.');

  await setUiState(page, {
    copy: { state: 'failed', request: 'default', reason: 'not-focused', message: '', at: at++ },
  });
  await expect(title).toHaveText(/^Click the page, then .+C again$/);

  await setUiState(page, {
    copy: {
      state: 'failed',
      request: 'default',
      reason: 'timeout',
      message: 'TIMEOUT',
      at: at++,
    } as never,
  });
  await expect(title).toHaveText('Copying took too long');

  await setUiState(page, {
    download: { state: 'saved', filename: 'page-snap.png', size: { w: 2560, h: 12000 }, at: at++ },
  });
  await expect(title).toHaveText('Saved page-snap.png');

  await setUiState(page, {
    download: { state: 'failed', message: 'TIMEOUT', reason: 'timeout', at: at++ } as never,
  });
  await expect(title).toHaveText('Saving took too long');
});

test('⌘C before the capture is on screen says it is still loading', async ({
  pagesnap,
  serviceWorker,
}) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  await patchSession(serviceWorker, id, { status: 'capturing', progress: { done: 2, total: 5 } });
  const page = await pagesnap.openEditor(id);
  await expect(page.getByTestId('state-loading')).toBeVisible();
  await page.locator('body').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByTestId('toast-title')).toHaveText('Still loading the capture…');
});

test('clicking Copy reports a result in the toast', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap, { cssW: 1280, cssH: 2000 });
  test.skip(
    !(await page.evaluate(() => !!window.__pagesnapTest)),
    'engine copy not implemented yet (stub store)',
  );
  await page.getByRole('button', { name: 'Copy image' }).click();
  // Either outcome is a UI pass: copied (with its size) or a human failure message.
  await expect(page.getByTestId('toast')).not.toHaveAttribute('data-hidden', { timeout: 15_000 });
  await expect(page.getByTestId('toast-title')).toHaveText(
    /^(Copied full page|Copied the area around your marks|Copied the current view|Click the page.*|Couldn’t copy the image)$/,
  );
  const st = await uiState(page);
  expect(['copied', 'failed']).toContain(st.copy.state);
  if (st.copy.state === 'copied') {
    await expect(page.getByTestId('toast-size')).toHaveText(
      `${st.copy.size.w} × ${st.copy.size.h}`,
    );
  }
});

test('first-open hint goes away on the first mark', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  const hint = page.getByTestId('empty-hint');
  await expect(hint).toBeVisible();
  await expect(hint).not.toHaveAttribute('data-hidden');
  await expect(page.getByTestId('hint-text')).toHaveText('Drag to draw an arrow');
  await expect(hint).toContainText(/C copies$/);
  // It follows the tool until the first mark.
  await page.keyboard.press('r');
  await expect(page.getByTestId('hint-text')).toHaveText('Drag to draw a rectangle');
  await page.keyboard.press('a');
  await expect(page.getByTestId('hint-text')).toHaveText('Drag to draw an arrow');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

  const box = await page.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 380, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => (await uiState(page)).doc?.shapes.length ?? 0).toBe(1);
  await expect(hint).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await uiState(page)).doc?.shapes.length ?? 0).toBe(0);
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
  // Undoing back to empty doesn't bring the hint back.
  await expect(hint).toHaveCount(0);
});

test.describe('capture states', () => {
  test('partial capture shows a quiet notice that can be dismissed', async ({
    pagesnap,
    serviceWorker,
  }) => {
    const id = await pagesnap.seedSession({ cssW: 1280, cssH: 4000 });
    await patchSession(serviceWorker, id, {
      status: 'partial',
      error: { code: 'TAB_CHANGED', message: 'The tab was switched.' },
    });
    const page = await pagesnap.openEditor(id);
    await waitReady(page, { force: true });
    const notice = page.getByTestId('capture-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Partial capture.');
    await expect(notice).toHaveAttribute('data-tone', 'warn');
    await expect(notice).toContainText('The tab was switched.');
    await expect(notice).toContainText('4,000 px');
    await notice.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('visible-only fallback explains why', async ({ pagesnap, serviceWorker }) => {
    const id = await pagesnap.seedSession({ cssW: 1280, cssH: 800 });
    await patchSession(serviceWorker, id, {
      mode: 'visible',
      warnings: [{ code: 'VISIBLE_ONLY', message: 'restricted' }],
    });
    const page = await pagesnap.openEditor(id);
    await waitReady(page, { force: true });
    const notice = page.getByTestId('capture-notice');
    await expect(notice).toHaveAttribute('data-tone', 'warn');
    await expect(notice).toContainText('restricted');
  });

  test('capture error shows a human message and a retry hint', async ({
    pagesnap,
    serviceWorker,
  }) => {
    const id = await pagesnap.seedSession({ cssW: 1280, cssH: 800 });
    await patchSession(serviceWorker, id, {
      status: 'error',
      url: 'https://chromewebstore.google.com/',
      error: { code: 'RESTRICTED', message: 'Cannot access contents of the page.' },
      slices: [],
    });
    const page = await pagesnap.openEditor(id);
    const err = page.getByTestId('state-error');
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('data-code', 'RESTRICTED');
    await expect(page.getByRole('alert')).toContainText('Chrome doesn’t allow capturing this page');
    await expect(err).toContainText('To try again, go back to the page and press');
    await expect(err.getByRole('link', { name: 'Open the page' })).toHaveAttribute(
      'href',
      'https://chromewebstore.google.com/',
    );
    // No tools or Copy on an error.
    await expect(page.getByRole('button', { name: 'Copy image' })).toHaveCount(0);
  });

  test('unknown capture id', async ({ pagesnap }) => {
    const page = await pagesnap.openEditor('nope-00000000');
    await expect(page.getByTestId('state-error')).toHaveAttribute('data-code', 'NO_SESSION');
    await expect(page.getByRole('alert')).toContainText('This capture isn’t here anymore');
  });

  test('capture still running shows progress', async ({ pagesnap, serviceWorker }) => {
    const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
    await patchSession(serviceWorker, id, { status: 'capturing', progress: { done: 4, total: 9 } });
    const page = await pagesnap.openEditor(id);
    const loading = page.getByTestId('state-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toContainText('Capturing the page');
    await expect(loading).toContainText('4 of 9');
    await expect(loading.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
    await expect(page.getByRole('button', { name: 'Copy image' })).toBeDisabled();

    // Finishing the capture lands in the editor.
    await patchSession(serviceWorker, id, { status: 'ready', progress: { done: 9, total: 9 } });
    await serviceWorker.evaluate(async (sid) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      await chrome.storage.session.set({
        [`session-status:${sid}`]: {
          id: sid,
          status: 'ready',
          progress: { done: 9, total: 9 },
          error: null,
          updatedAt: Date.now(),
        },
      });
    }, id);
    await expect(page.getByTestId('editor-root')).toHaveAttribute('data-phase', 'ready', {
      timeout: 15_000,
    });
  });
});

test.describe('stuck states', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      (window as unknown as { __pagesnapUiTiming: object }).__pagesnapUiTiming = {
        stallMs: 1500,
        openMs: 1500,
      };
    });
  });

  test('a capture with no sign of life says it stopped responding', async ({
    pagesnap,
    serviceWorker,
  }) => {
    const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
    await patchSession(serviceWorker, id, { status: 'capturing', progress: { done: 3, total: 9 } });
    const page = await pagesnap.openEditor(id);
    const loading = page.getByTestId('state-loading');
    await expect(loading).toContainText('Capturing the page');
    await expect(loading).toHaveAttribute('data-phase', 'stalled', { timeout: 5000 });
    await expect(loading).toContainText('The capture stopped responding');
    await expect(loading).toContainText('Stuck at 3 of 9');
    await expect(loading).toContainText(/go back to the page and press/);
  });

  test('opening that never finishes turns into an error with a reload action', async ({
    context,
    pagesnap,
  }) => {
    const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
    // IndexedDB that never answers: the editor can't read the capture or its status.
    await context.addInitScript(() => {
      IDBFactory.prototype.open = () =>
        Object.assign(new EventTarget(), { result: null, error: null }) as never;
    });
    const page = await pagesnap.openEditor(id);
    const err = page.getByTestId('state-error');
    await expect(err).toBeVisible({ timeout: 8000 });
    await expect(err).toHaveAttribute('data-code', 'LOAD_FAILED');
    await expect(err).toContainText('This capture couldn’t be opened');
    // Either the UI's own open timeout or the engine's storage timeout gets here first.
    await expect(err.getByRole('button', { name: 'Reload this tab' })).toBeVisible();
  });
});

test('keyboard: Tab reaches the capture, which scrolls with the keys', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap, { cssW: 1280, cssH: 8000 });
  await page.getByTestId('copy-button').focus();
  await page.keyboard.press('Tab');
  const stage = page.getByRole('main', { name: 'Capture' });
  await expect(stage).toBeFocused();
  await expect(page.getByTestId('keys-hint')).not.toHaveAttribute('data-hidden');
  const y0 = (await uiState(page)).camera.y;
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await uiState(page)).camera.y).toBeGreaterThan(y0);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await uiState(page)).camera.y).toBeLessThanOrEqual(y0);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('keys-hint')).toHaveAttribute('data-hidden');
});

for (const width of [820, 1000, 1100, 1280, 1440]) {
  test.describe(`toolbar at ${width} px`, () => {
    test.use({ windowSize: { width, height: 800 } });
    test('fits without overlap', async ({ pagesnap }) => {
      const { page } = await openSeeded(pagesnap);
      expect(await page.evaluate(() => innerWidth)).toBe(width);
      const boxes = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="toolbar"]') as HTMLElement;
        const els = [
          ...bar.querySelectorAll<HTMLElement>('button, a.ps-ident, span.ps-ident'),
        ].filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
        return els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: el.getAttribute('aria-label') ?? el.textContent ?? '',
            x0: r.left,
            x1: r.right,
          };
        });
      });
      for (const b of boxes) {
        expect(b.x0, b.name).toBeGreaterThanOrEqual(0);
        expect(b.x1, b.name).toBeLessThanOrEqual(width);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (!a || !b) continue;
          const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          expect(overlap, `${a.name} / ${b.name}`).toBeLessThanOrEqual(0.5);
        }
      }
      const kbd = page.getByTestId('copy-button').locator('kbd');
      if (width <= 860) await expect(kbd).toBeHidden();
      else await expect(kbd).toBeVisible();
      if (width <= 1040) await expect(page.getByTestId('page-title')).toBeHidden();
      else await expect(page.getByTestId('page-title')).toBeVisible();
    });
  });
}

test('a11y smoke: names, roles, keyboard focus, tooltips', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  await expect(page.getByRole('toolbar', { name: 'Annotation tools' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Tools' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'History' })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Capture' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ has: page.getByTestId('toast-title') }),
  ).toHaveCount(0);

  // Every button has an accessible name.
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim()))
      .map((b) => b.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);

  // Keyboard: Tab reaches the tools, focus is visible, and the tooltip names the shortcut.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  const first = page.locator(':focus');
  await expect(first).toBeVisible();
  let reachedTool = false;
  for (let i = 0; i < 12 && !reachedTool; i++) {
    reachedTool =
      (await page.evaluate(() => document.activeElement?.getAttribute('data-tool'))) != null;
    if (!reachedTool) await page.keyboard.press('Tab');
  }
  expect(reachedTool).toBe(true);
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  });
  expect(outline.style).toBe('solid');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  const tip = page.getByTestId('tooltip');
  await expect(tip).toHaveAttribute('data-open', '');
  await expect(tip.locator('kbd')).toHaveText(/^[VARUHPT]$/);

  // Hover tooltips include the hotkey.
  await tool(page, 'Rectangle').hover();
  await expect(tip).toHaveAttribute('data-open', '');
  await expect(tip).toHaveText('RectangleR');
});

test('panning and pointer moves do not re-render the chrome', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap, { cssW: 1280, cssH: 8000 });
  const renders = () =>
    page.evaluate(
      () =>
        ({
          ...(window as unknown as { __pagesnapUi: { renders: Record<string, number> } })
            .__pagesnapUi.renders,
        }) as Record<string, number>,
    );
  await page.waitForTimeout(300);
  const before = await renders();
  const cam0 = (await uiState(page)).camera;

  const box = await page.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + 200, box.y + 200);
  for (let i = 0; i < 40; i++) await page.mouse.move(box.x + 200 + i * 7, box.y + 200 + i * 3);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);

  const cam1 = (await uiState(page)).camera;
  expect(cam1.y).not.toBe(cam0.y); // the page really scrolled
  expect(await renders()).toEqual(before);
});
