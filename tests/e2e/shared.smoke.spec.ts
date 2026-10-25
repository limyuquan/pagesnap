import { type ChromeGlobal, expect, test } from './fixtures';

test('extension loads with the e2e manifest and test hooks', async ({
  serviceWorker,
  extensionId,
}) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const info = await serviceWorker.evaluate(() => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const m = chrome.runtime.getManifest();
    return {
      name: m.name,
      permissions: m.permissions,
      hostPermissions: m.host_permissions,
      popup: m.action?.default_popup ?? null,
      hooks: Object.keys(globalThis.__pagesnap ?? {}).sort(),
    };
  });
  expect(info.name).toBe('Page Snap');
  expect(info.permissions).toEqual([
    'activeTab',
    'scripting',
    'storage',
    'unlimitedStorage',
    'contextMenus',
  ]);
  expect(info.hostPermissions).toEqual(['<all_urls>']);
  expect(info.popup).toBeNull();
  expect(info.hooks).toEqual(['clickAction', 'seedSyntheticSession', 'startCapture']);
});

test('editor renders for a seeded session', async ({ pagesnap }) => {
  const sessionId = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const editor = await pagesnap.openEditor(sessionId);
  const root = editor.getByTestId('editor-root');
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute('data-session', sessionId);
});

test('fixture pages are served and tab ids resolve', async ({ pagesnap }) => {
  const page = await pagesnap.openFixture('bands');
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(8000);
  expect(await pagesnap.tabIdOf(page)).toBeGreaterThan(0);
});

test('captureVisibleTab works without a user gesture in the e2e build', async ({
  pagesnap,
  serviceWorker,
  dpr,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  const dataUrl = await serviceWorker.evaluate(async (id) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const tab = await chrome.tabs.get(id);
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  }, tabId);
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  const { bitmap, view } = await page.evaluate(async (url) => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    return {
      bitmap: { w: bmp.width, h: bmp.height },
      view: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    };
  }, dataUrl);
  expect(view.dpr).toBe(dpr);
  expect(bitmap).toEqual({ w: view.w * dpr, h: view.h * dpr });
});
