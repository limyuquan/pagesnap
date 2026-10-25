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

test('colour and size controls drive the store', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap);
  const colours = page.getByRole('radiogroup', { name: 'Colour' });
  await expect(colours.getByRole('radio')).toHaveCount(8);
  await expect(colours.getByRole('radio', { name: 'Red' })).toHaveAttribute('aria-checked', 'true');

  await colours.getByRole('radio', { name: 'Blue' }).click();
  await expect(colours.getByRole('radio', { name: 'Blue' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect((await uiState(page)).styles.arrow.color.toUpperCase()).toBe('#0A84FF');

  // Arrow keys move within the radio group.
  await colours.getByRole('radio', { name: 'Blue' }).press('ArrowRight');
  expect((await uiState(page)).styles.arrow.color.toUpperCase()).toBe('#AF52DE');
  await expect(colours.getByRole('radio', { name: 'Purple' })).toBeFocused();

  // Number keys (engine shortcut) reflect in the swatches.
  await page.keyboard.press('1');
  await expect(colours.getByRole('radio', { name: 'Red' })).toHaveAttribute('aria-checked', 'true');

  // Size menu.
  await page.getByTestId('size-button').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: '6 px', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(menu.getByRole('menuitemradio', { name: '6 px', exact: true })).toBeFocused();
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
  await expect(colours.getByRole('radio', { name: 'Yellow' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Select with nothing selected: colour and size are disabled.
  await tool(page, 'Select').click();
  await expect(colours.getByRole('radio', { name: 'Red' })).toBeDisabled();
  await expect(page.getByTestId('size-button')).toBeDisabled();
});

test('copy toast says what was copied', async ({ pagesnap }) => {
  const { page } = await openSeeded(pagesnap, { cssW: 1280, cssH: 6000 });
  const toast = page.getByTestId('toast');
  const title = page.getByTestId('toast-title');

  await setUiState(page, {
    copy: {
      state: 'copied',
      request: 'full',
      outcome: 'full',
      size: { w: 1280, h: 6000 },
      tall: true,
      at: Date.now(),
    },
  });
  await expect(toast).not.toHaveAttribute('data-hidden');
  await expect(title).toHaveText('Copied full page');
  await expect(page.getByTestId('toast-size')).toHaveText('1280 × 6000');
  await expect(toast).toContainText('AI chats will scale it down');
  await expect(page.getByTestId('copy-button')).toHaveAttribute('data-state', 'copied');

  await setUiState(page, {
    copy: {
      state: 'copied',
      request: 'default',
      outcome: 'smart',
      size: { w: 1280, h: 1184 },
      tall: false,
      at: Date.now() + 1,
    },
  });
  await expect(title).toHaveText('Copied the area around your marks');
  await expect(toast).toContainText('6,000 px tall');
  await expect(toast).toContainText(/copies all of it/);

  await setUiState(page, {
    copy: {
      state: 'copied',
      request: 'default',
      outcome: 'viewport',
      size: { w: 1280, h: 2576 },
      tall: false,
      at: Date.now() + 2,
    },
  });
  await expect(title).toHaveText('Copied the current view');

  await setUiState(page, {
    copy: {
      state: 'failed',
      request: 'default',
      reason: 'not-focused',
      message: '',
      at: Date.now() + 3,
    },
  });
  await expect(title).toHaveText(/^Click the page, then .+C again$/);

  await setUiState(page, {
    download: {
      state: 'saved',
      filename: 'page-snap.png',
      size: { w: 2560, h: 12000 },
      at: Date.now() + 4,
    },
  });
  await expect(title).toHaveText('Saved page-snap.png');
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
  await expect(hint).toContainText('Draw on the page');
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
    await expect(notice).toContainText('The tab changed mid-capture.');
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
    await expect(page.getByTestId('capture-notice')).toContainText('Visible area only.');
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
