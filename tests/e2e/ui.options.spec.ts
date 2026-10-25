/** Options page (owner: C): settings save to chrome.storage.local and the editor picks them up. */
import { type ChromeGlobal, expect, test } from './fixtures';
import { uiState, waitReady } from './ui.helpers';

test.use({ dpr: 1 });

test('options page saves settings', async ({ context, extensionId, serviceWorker, pagesnap }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByRole('heading', { name: 'Page Snap', level: 1 })).toBeVisible();

  const stored = () =>
    serviceWorker.evaluate(async () => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      return (await chrome.storage.local.get('settings')).settings as
        | {
            copy: { resolution: string };
            editor: { shadow: boolean; defaultColor?: string };
          }
        | undefined;
    });

  // Copy size.
  const standard = page.getByRole('radio', { name: /Standard/ });
  const full = page.getByRole('radio', { name: /Full resolution/ });
  await expect(standard).toBeChecked();
  await full.check();
  await expect.poll(async () => (await stored())?.copy.resolution).toBe('native');
  await expect(page.getByRole('status')).toHaveText('Saved');

  // Starting colour.
  const colours = page.getByRole('radiogroup', { name: 'Starting colour' });
  await expect(colours.getByRole('radio', { name: 'Red' })).toHaveAttribute('aria-checked', 'true');
  await colours.getByRole('radio', { name: 'Blue' }).click();
  await expect.poll(async () => (await stored())?.editor.defaultColor).toBe('#0A84FF');

  // Contrast shadow.
  const shadow = page.getByRole('switch', { name: /Contrast shadow/ });
  await expect(shadow).toBeChecked();
  await shadow.uncheck();
  await expect.poll(async () => (await stored())?.editor.shadow).toBe(false);

  // Capture shortcut is shown, with a way to change it.
  await expect(page.getByTestId('capture-shortcut')).toHaveText(/P$/);
  await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();

  // Survives a reload.
  await page.reload();
  await expect(page.getByRole('radio', { name: /Full resolution/ })).toBeChecked();
  await expect(
    page.getByRole('radiogroup', { name: 'Starting colour' }).getByRole('radio', { name: 'Blue' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: /Contrast shadow/ })).not.toBeChecked();

  // The editor starts with the chosen colour.
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 1200 });
  const editor = await pagesnap.openEditor(id);
  const real = await waitReady(editor, { force: true });
  await expect
    .poll(async () => (await uiState(editor)).styles.arrow.color.toUpperCase())
    .toBe('#0A84FF');
  // The highlighter keeps yellow.
  expect((await uiState(editor)).styles.highlight.color.toUpperCase()).toBe('#FFD60A');
  void real;
});
