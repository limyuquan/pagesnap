/**
 * Capture edge cases from the Phase 4 review (correctness #4–#13, qa-edge E1/E2/E6/E8, sitesA S-3,
 * sitesB I-7): pages still loading, pending images, two tabs back to back, our own editor, write
 * failures, a dead SW, pause on minimise, scroll-locked pages, SPA route changes, browser zoom.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Worker } from '@playwright/test';
import type {} from '@/capture/testHook';
import {
  captureFull,
  getSession,
  startCaptureAsync,
  stitched,
  waitForFinal,
  waitForSlices,
} from './capture.helpers';
import { type ChromeGlobal, expect, test } from './fixtures';

test.use({ dpr: 1 });

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6'];

/** A local server whose pages stream slowly or whose images load late (qa-edge's slow.html). */
let server: Server;
let origin = '';
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/img') {
      await new Promise((r) => setTimeout(r, Number(u.searchParams.get('d') ?? 1000)));
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#222"/></svg>',
      );
      return;
    }
    const chunkMs = Number(u.searchParams.get('ms') ?? 0);
    const imgs = u.searchParams.get('imgs') === '1';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.write(
      `<!doctype html><html><head><meta charset=utf-8><title>slow</title><style>body{margin:0}.b{height:500px;border-top:2px solid #000;box-sizing:border-box}img{display:block;width:400px;height:300px}</style></head><body>${' '.repeat(2048)}`,
    );
    for (let i = 0; i < 12; i++) {
      const img = imgs ? `<img src="/img?d=${6000 + i * 100}&i=${i}">` : '';
      res.write(`<div class=b style="background:${COLORS[i % COLORS.length]}">${img}</div>\n`);
      if (chunkMs) await new Promise((r) => setTimeout(r, chunkMs));
    }
    res.end('<div id=end style="height:200px;background:#000"></div></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const badge = (sw: Worker, tabId: number) =>
  sw.evaluate((t) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return chrome.action.getBadgeText({ tabId: t });
  }, tabId);

const setFlags = (sw: Worker, flags: Record<string, unknown>) =>
  sw.evaluate((f) => globalThis.__pagesnapCapture?.setFlags(f), flags);

const click = (sw: Worker, tabId: number) =>
  sw.evaluate((t) => globalThis.__pagesnap?.clickAction(t) ?? null, tabId);

test('a page that is still loading is captured once it has parsed (no 5 s agent timeout)', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  // About 7 s of streaming HTML: longer than the old 5 s connect timeout.
  await page.goto(`${origin}/slow.html?ms=600`, { waitUntil: 'commit' });
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 300));
  expect(await page.evaluate(() => document.readyState)).toBe('loading');
  const tabId = await pagesnap.tabIdOf(page);
  const done = click(serviceWorker, tabId);
  await new Promise((r) => setTimeout(r, 1500));
  // Waiting for the page: the badge says so.
  expect(await badge(serviceWorker, tabId)).toMatch(/^(…|\d{1,2}%)$/);
  const id = await done;
  if (!id) throw new Error('no session');
  const s = await getSession(serviceWorker, id);
  expect(s.status).toBe('ready');
  expect(s.css.h).toBe(12 * 500 + 200);
});

test('images still loading are waited for briefly and then reported', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto(`${origin}/slow.html?imgs=1`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const { session, timings } = await captureFull(pagesnap, serviceWorker, page);
  expect(session.status).toBe('ready');
  expect(session.warnings.map((w) => w.code)).toContain('IMAGES_PENDING');
  // The wait is capped (800 ms a slice, then 200 ms once 4 s were spent): not 6 s per image.
  expect(timings?.captureMs ?? 0).toBeLessThan(15_000);
});

test('a click on tab B right after starting tab A captures B; A stops', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const a = await pagesnap.openFixture('bands');
  const b = await context.newPage();
  await b.goto(pagesnap.fixtureUrl('short'));
  const [ta, tb] = [await pagesnap.tabIdOf(a), await pagesnap.tabIdOf(b)];
  await a.bringToFront();
  const first = click(serviceWorker, ta);
  await new Promise((r) => setTimeout(r, 200));
  await b.bringToFront();
  // Within the old 800 ms double-click window: must not be swallowed.
  const second = await click(serviceWorker, tb);
  const idA = await first;
  expect(second).toBeTruthy();
  expect(second).not.toBe(idA);
  const sb = await getSession(serviceWorker, second as string);
  expect(sb.url).toContain('short.html');
  expect(sb.status).toBe('ready');
  if (idA) {
    const sa = await getSession(serviceWorker, idA);
    expect(sa.error?.code).toBe('TAB_CHANGED');
  }
});

test('a click in another window queues its capture; the running one is not cancelled', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const a = await pagesnap.openFixture('bands');
  const ta = await pagesnap.tabIdOf(a);
  const tb = await serviceWorker.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const w = await chrome.windows.create({ url, focused: false });
    return w?.tabs?.[0]?.id ?? -1;
  }, pagesnap.fixtureUrl('short'));
  await new Promise((r) => setTimeout(r, 800));
  await a.bringToFront();
  const first = click(serviceWorker, ta);
  await waitForSlices(serviceWorker, 2);
  const second = click(serviceWorker, tb);
  await expect.poll(() => badge(serviceWorker, tb)).toBe('…');
  const idA = await first;
  const idB = await second;
  expect((await getSession(serviceWorker, idA as string)).status).toBe('ready');
  const sb = await getSession(serviceWorker, idB as string);
  expect(sb.url).toContain('short.html');
  expect(sb.status).toBe('ready');
  void context;
});

test('capturing Page Snap’s own editor says so (no “other extensions” warning)', async ({
  pagesnap,
  serviceWorker,
}) => {
  const seeded = await pagesnap.seedSession({ cssH: 1500 });
  const editor = await pagesnap.openEditor(seeded);
  await editor.bringToFront();
  const tabId = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? -1;
  });
  const id = await serviceWorker.evaluate((t) => globalThis.__pagesnap?.startCapture(t), tabId);
  const s = await getSession(serviceWorker, id as string);
  expect(s.mode).toBe('visible');
  expect(s.warnings[0]?.message).toMatch(/Page Snap’s own page/);
  expect(s.warnings[0]?.message).not.toMatch(/other extensions/);
});

test('a slice write failure stops the capture and keeps only the stored prefix', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('bands');
  await setFlags(serviceWorker, { failSliceWritesFrom: 3 });
  try {
    const { sessionId, session } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('partial');
    expect(session.error?.code).toBe('STORAGE_FAILED');
    expect(session.slices).toHaveLength(3);
    expect(Math.max(...session.layout.parts.map((p) => p.slice))).toBe(2);
    // Every referenced slice exists: the stitched image composites without "not found".
    const img = await stitched(serviceWorker, sessionId, undefined, 0.25);
    expect(img.height).toBeGreaterThan(0);
    expect(await badge(serviceWorker, await pagesnap.tabIdOf(page))).not.toMatch(/%/);
  } finally {
    await setFlags(serviceWorker, { failSliceWritesFrom: -1 });
  }
});

test('if the final save fails the editor still opens, with an error', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('short');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { failFinalSave: true });
  try {
    const { editor } = await pagesnap.capture(page);
    await expect
      .poll(() =>
        editor.evaluate(() => {
          const s = (
            window as unknown as {
              __pagesnapEngine?: { state(): { load: { phase: string; code?: string } } };
            }
          ).__pagesnapEngine?.state();
          return s ? `${s.load.phase}:${s.load.code ?? ''}` : 'none';
        }),
      )
      .toBe('error:CAPTURE_FAILED');
    expect(await badge(serviceWorker, tabId)).not.toMatch(/%/);
  } finally {
    await setFlags(serviceWorker, { failFinalSave: false });
  }
});

test('an editor waiting on a capture whose SW died gets it marked interrupted', async ({
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const id = await pagesnap.seedSession({ cssH: 3000 });
  // Make it look like a capture whose SW died 30 s ago.
  await serviceWorker.evaluate(async (sid) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('pagesnap');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const s = await new Promise<Record<string, unknown>>((resolve) => {
      const g = store.get(sid);
      g.onsuccess = () => resolve(g.result);
    });
    const stale = Date.now() - 30_000;
    store.put({ ...s, status: 'capturing', updatedAt: stale });
    await new Promise((r) => {
      tx.oncomplete = r;
    });
    db.close();
    await chrome.storage.session.set({
      [`session-status:${sid}`]: {
        id: sid,
        status: 'capturing',
        progress: { done: 2, total: 9 },
        error: null,
        updatedAt: stale,
      },
    });
  }, id);
  await pagesnap.openEditor(id);
  await expect
    .poll(async () => (await getSession(serviceWorker, id)).status, { timeout: 15_000 })
    .toBe('partial');
  expect((await getSession(serviceWorker, id)).error?.code).toBe('INTERRUPTED');
});

test('a minimised window pauses the capture, which resumes when it is restored', async ({
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  const windowState = (state: 'minimized' | 'normal') =>
    serviceWorker.evaluate(
      async ([t, st]) => {
        const { chrome } = globalThis as unknown as ChromeGlobal;
        const tab = await chrome.tabs.get(t as number);
        await chrome.windows.update(tab.windowId, { state: st as 'normal' });
      },
      [tabId, state] as const,
    );
  await startCaptureAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  await windowState('minimized');
  await expect.poll(() => badge(serviceWorker, tabId)).toBe('II');
  await new Promise((r) => setTimeout(r, 1500));
  expect((await getSession(serviceWorker, id)).status).toBe('capturing');
  await windowState('normal');
  await page.bringToFront();
  const s = await waitForFinal(serviceWorker, id, 60_000);
  expect(s.status).toBe('ready');
  expect(s.slices).toHaveLength(10);
});

test('a window minimised for too long stops the capture with a clear message', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await setFlags(serviceWorker, { pauseLimitMs: 1500 });
  try {
    await startCaptureAsync(serviceWorker, tabId);
    const id = await waitForSlices(serviceWorker, 2);
    await serviceWorker.evaluate(async (t) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      const tab = await chrome.tabs.get(t);
      await chrome.windows.update(tab.windowId, { state: 'minimized' });
    }, tabId);
    const s = await waitForFinal(serviceWorker, id);
    expect(s.status).toBe('partial');
    expect(s.error?.code).toBe('TAB_CHANGED');
    expect(s.error?.message).toMatch(/hidden \(or its window minimised\) for too long/);
  } finally {
    await setFlags(serviceWorker, { pauseLimitMs: 0 });
    await serviceWorker.evaluate(async (t) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      const tab = await chrome.tabs.get(t);
      await chrome.windows.update(tab.windowId, { state: 'normal' });
    }, tabId);
  }
});

test('a scroll-locked page (cookie wall) captured as one screen gets a note', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  await context.route('**/capture-locked.html', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{margin:0;position:fixed;top:0;left:0;right:0}.b{height:500px;border-top:2px solid #000}#wall{position:fixed;inset:0;background:rgba(0,0,0,.5)}</style>
      ${COLORS.map((c) => `<div class=b style="background:${c}"></div>`).join('')}<div id=wall></div>`,
    }),
  );
  const page = await pagesnap.openFixture('capture-locked');
  const { session } = await captureFull(pagesnap, serviceWorker, page);
  expect(session.slices).toHaveLength(1);
  expect(session.warnings.map((w) => w.code)).toContain('NOT_SCROLLABLE');
});

for (const kind of ['route', 'rewrite'] as const) {
  test(`an SPA ${kind === 'route' ? 'route change stops' : 'URL rewrite while scrolling doesn’t stop'} the capture`, async ({
    context,
    pagesnap,
    serviceWorker,
  }) => {
    await context.route('**/capture-spa.html', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>body{margin:0}.b{height:500px;border-top:2px solid #000}</style><main id=m>${Array.from(
          { length: 16 },
          (_, i) => `<div class=b style="background:${COLORS[i % COLORS.length]}">${i}</div>`,
        ).join('')}</main>`,
      }),
    );
    const page = await pagesnap.openFixture('capture-spa');
    const tabId = await pagesnap.tabIdOf(page);
    await startCaptureAsync(serviceWorker, tabId);
    const id = await waitForSlices(serviceWorker, 2);
    await page.evaluate((k) => {
      if (k === 'route') {
        history.pushState({}, '', '/other-route');
        const m = document.getElementById('m') as HTMLElement;
        m.replaceChildren(...[...m.children].map((c) => c.cloneNode(true)));
      } else {
        history.replaceState({}, '', `${location.pathname}?page=2`);
      }
    }, kind);
    const s = await waitForFinal(serviceWorker, id);
    if (kind === 'route') {
      expect(s.status).toBe('partial');
      expect(s.error?.code).toBe('TAB_CHANGED');
    } else {
      expect(s.status).toBe('ready');
    }
  });
}

test.describe('browser zoom at DPR 2', () => {
  test.use({ dpr: 2 });
  test('the scale snaps to devicePixelRatio (110% → 2.2, not 2.2012)', async ({
    pagesnap,
    serviceWorker,
  }) => {
    const page = await pagesnap.openFixture('bands');
    const tabId = await pagesnap.tabIdOf(page);
    await serviceWorker.evaluate(async (t) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      await chrome.tabs.setZoom(t, 1.1);
    }, tabId);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(2.2, 3);
    try {
      const { session } = await captureFull(pagesnap, serviceWorker, page);
      expect(session.dpr).toBe(2.2);
      expect(session.image.h).toBe(Math.round(session.css.h * 2.2));
    } finally {
      await serviceWorker.evaluate(async (t) => {
        const { chrome } = globalThis as unknown as ChromeGlobal;
        await chrome.tabs.setZoom(t, 1);
      }, tabId);
    }
  });
});
