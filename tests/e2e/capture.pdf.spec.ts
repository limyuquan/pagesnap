import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {} from '@/capture/testHook';
import { getSession } from './capture.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';

test('Chrome’s PDF viewer falls back to the visible area with a notice', async ({
  context,
  serviceWorker,
}) => {
  // Make a small PDF with Chromium itself and serve it as application/pdf (the fixture server
  // doesn't know the type).
  const maker = await context.newPage();
  await maker.setContent(`<h1>PDF</h1>${'<p>Paragraph</p>'.repeat(80)}`);
  const pdf = await maker.pdf();
  await maker.close();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(pdf);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/paper.pdf`).catch(() => {});
    await page.waitForTimeout(1500);
    await page.bringToFront();
    const tabId = await serviceWorker.evaluate(async () => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? -1;
    });
    const id = await serviceWorker.evaluate((t) => globalThis.__pagesnap?.startCapture(t), tabId);
    const s = await getSession(serviceWorker, id ?? '');
    expect(s.status, JSON.stringify(s.error)).toBe('ready');
    expect(s.mode).toBe('visible');
    expect(s.slices).toHaveLength(1);
    expect(s.warnings.map((w) => w.code)).toEqual(['VISIBLE_ONLY']);
    expect(s.warnings[0]?.message).toMatch(/PDF viewer/);
  } finally {
    server.close();
  }
});
