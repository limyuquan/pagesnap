/**
 * The Alt+Shift+P command path, end to end. Playwright's `keyboard.press` sends `keyDown` events
 * that Chrome treats as page input only, so the extension command never fires (measured). A raw
 * CDP `Input.dispatchKeyEvent` of type `rawKeyDown` goes through the browser's own accelerator
 * handling instead, which is where extension commands live: Chrome then dispatches
 * `_execute_action` as `action.onClicked`, exactly like a real key press. On macOS the event
 * needs the native key code too.
 */
import type { Page, Worker } from '@playwright/test';
import type {} from '@/capture/testHook';
import { getSession, pageState } from './capture.helpers';
import { snapshot, waitReady } from './engine.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';

const ALT = 1;
const SHIFT = 8;

async function pressCaptureShortcut(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const key = {
    modifiers: ALT | SHIFT,
    key: 'P',
    code: 'KeyP',
    windowsVirtualKeyCode: 80,
    // macOS matches accelerators on the native key code (kVK_ANSI_P = 35).
    nativeVirtualKeyCode: process.platform === 'darwin' ? 35 : 80,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await cdp.detach();
}

/**
 * Press Alt+Shift+P until a capture is running. In a brand-new profile Chrome binds extension
 * command accelerators a moment after startup (measured: about one press in three is ignored in
 * the first ~second), which a real user never sees. Re-pressing is safe: a second press within
 * 800 ms of a capture starting is treated as a double-press and ignored.
 */
async function startViaShortcut(page: Page, sw: Worker): Promise<void> {
  const running = () => sw.evaluate(() => globalThis.__pagesnapCapture?.activeId() ?? null);
  for (let i = 0; i < 10; i++) {
    await pressCaptureShortcut(page);
    for (let t = 0; t < 10; t++) {
      if (await running()) return;
      await page.waitForTimeout(50);
    }
  }
  throw new Error('Alt+Shift+P never started a capture');
}

test('Alt+Shift+P is registered and captures the page into the editor', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const commands = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return chrome.commands.getAll();
  });
  const action = commands.find((c) => c.name === '_execute_action');
  // Chrome shows the bound key in its own notation (⌥⇧P on macOS, Alt+Shift+P elsewhere).
  expect(action?.shortcut).toMatch(/^(⌥⇧P|Alt\+Shift\+P)$/);

  const page = await pagesnap.openFixture('bands');
  await page.evaluate(() => scrollTo(0, 777));
  const before = await pageState(page);
  const editorOpened = context.waitForEvent('page', {
    predicate: (p) => p.url().startsWith(`chrome-extension://${extensionId}/editor.html`),
    timeout: 60_000,
  });
  await startViaShortcut(page, serviceWorker);
  const editor = await editorOpened;
  await waitReady(editor);
  const id = new URL(editor.url()).hash.replace(/^#s=/, '');
  const session = await getSession(serviceWorker, decodeURIComponent(id));
  expect(session.status).toBe('ready');
  expect(session.css.h).toBe(8000);
  expect((await snapshot(editor)).tool).toBe('arrow');
  expect(await pageState(page)).toEqual(before);
});

test('pressing Alt+Shift+P again mid-capture cancels it, keeping what was captured', async ({
  context,
  pagesnap,
  serviceWorker,
  extensionId,
}) => {
  const page = await pagesnap.openFixture('bands');
  const editorOpened = context.waitForEvent('page', {
    predicate: (p) => p.url().startsWith(`chrome-extension://${extensionId}/editor.html`),
    timeout: 60_000,
  });
  await startViaShortcut(page, serviceWorker);
  // Past the double-press guard, with a couple of slices stored.
  await expect
    .poll(
      () =>
        serviceWorker.evaluate(async () => {
          const hook = globalThis.__pagesnapCapture;
          const id = hook?.activeId();
          const s = id ? await hook?.session(id) : null;
          return s?.slices.length ?? 0;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await pressCaptureShortcut(page);
  const editor = await editorOpened;
  const id = decodeURIComponent(new URL(editor.url()).hash.replace(/^#s=/, ''));
  const session = await getSession(serviceWorker, id);
  expect(session.status).toBe('partial');
  expect(session.error?.code).toBe('ABORTED_BY_USER');
  await waitReady(editor);
  // Alt+Shift+P is the toolbar action, so the notice says the capture was stopped from there.
  await expect(editor.getByTestId('capture-notice')).toContainText(
    'You clicked Page Snap again, so the capture stopped early.',
  );
});
