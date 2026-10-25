import { captureFull, dump, type Img, near, pageState, stitched, tile } from './capture.helpers';
import { expect, test } from './fixtures';

const COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#bcf60c',
];

/** Rows (CSS px) in column `x` (CSS px) whose colour is near `color`. */
function rowsWith(img: Img, dpr: number, x: number, color: string, tol = 8): number[] {
  const out: number[] = [];
  const h = Math.round(img.height / dpr);
  for (let y = 0; y < h; y++)
    if (near(img.hex(x * dpr, y * dpr + dpr / 2), color, tol)) out.push(y);
  return out;
}

/** Contiguous runs `[start, end)` in a sorted list of rows. */
function runs(rows: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const y of rows) {
    const last = out[out.length - 1];
    if (last && y === last[1]) last[1] = y + 1;
    else out.push([y, y + 1]);
  }
  return out;
}

test.describe('fixtures', () => {
  test.use({ dpr: 2 });

  test('short page: a single slice of the viewport', async ({ pagesnap, serviceWorker, dpr }) => {
    const page = await pagesnap.openFixture('short');
    const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    expect(session.slices).toHaveLength(1);
    expect(session.css).toEqual(view);
    await dump(serviceWorker, sessionId, 'fixture-short');
    const img = await stitched(serviceWorker, sessionId);
    expect(near(img.hex(600 * dpr, 300 * dpr), '#0a84ff')).toBe(true);
    expect(near(img.hex(600 * dpr, (view.h - 10) * dpr), '#ffffff')).toBe(true);
  });

  test('sticky header and sticky panel appear exactly once', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('sticky-header');
    await page.evaluate(() => scrollTo(0, 700));
    const before = await pageState(page);
    const vw = await page.evaluate(() => innerWidth);
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    expect(session.css.h).toBe(5064);
    expect(await pageState(page)).toEqual(before);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('header') as Element).position,
      ),
    ).toBe('sticky');

    await dump(serviceWorker, sessionId, 'fixture-sticky-header');
    const img = await stitched(serviceWorker, sessionId);
    expect(runs(rowsWith(img, dpr, 600, '#1c1c1e'))).toEqual([[0, 64]]);
    expect(runs(rowsWith(img, dpr, vw - 30, '#ffd60a'))).toEqual([[88, 288]]);
    for (let i = 0; i < 10; i++) {
      expect(near(img.hex(600 * dpr, (64 + i * 500 + 250) * dpr), COLORS[i % 8] ?? '')).toBe(true);
    }
  });

  test('header that turns fixed on scroll (jump) appears once', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('sticky-header?jump=1');
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    await dump(serviceWorker, sessionId, 'fixture-sticky-header-jump');
    const img = await stitched(serviceWorker, sessionId);
    expect(runs(rowsWith(img, dpr, 600, '#1c1c1e'))).toEqual([[0, 64]]);
    expect(await page.evaluate(() => document.querySelector('header')?.className)).toBe('static');
  });

  test('fixed top bar in the first slice only, footer and chat bubble in the last only', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('fixed-footer-and-chat-bubble');
    const vw = await page.evaluate(() => innerWidth);
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    const H = session.css.h;
    expect(H).toBe(6056);
    await dump(serviceWorker, sessionId, 'fixture-fixed-footer');
    const img = await stitched(serviceWorker, sessionId);
    expect(runs(rowsWith(img, dpr, 600, '#0a84ff'))).toEqual([[0, 56]]);
    expect(runs(rowsWith(img, dpr, 600, '#2c2c2e'))).toEqual([[H - 64, H]]);
    const bubble = runs(rowsWith(img, dpr, vw - 54, '#34c759', 4));
    expect(bubble).toHaveLength(1);
    const [b0, b1] = bubble[0] ?? [0, 0];
    expect(Math.abs(b0 - (H - 148))).toBeLessThanOrEqual(2);
    expect(Math.abs(b1 - (H - 88))).toBeLessThanOrEqual(2);
    for (let i = 0; i < 12; i++) {
      expect(near(img.hex(600 * dpr, (56 + i * 500 + 250) * dpr), COLORS[i % 8] ?? '')).toBe(true);
    }
  });

  test('wide page is captured in columns without seams', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('wide');
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    expect(session.css).toEqual({ w: 3000, h: 2000 });
    expect(session.image).toEqual({ w: 3000 * dpr, h: 2000 * dpr });
    await dump(serviceWorker, sessionId, 'fixture-wide');
    const img = await stitched(serviceWorker, sessionId);
    const bad: string[] = [];
    for (let r = 0; r < 4; r++) {
      const y = r * 500 + 300;
      for (let x = 0; x < 3000; x++) {
        const local = x % 500;
        const want =
          local < 2 || local >= 498 ? '#000000' : COLORS[(r * 6 + Math.floor(x / 500)) % 8];
        const got = img.hex(x * dpr + dpr / 2, y * dpr);
        if (!near(got, want ?? '')) bad.push(`(${x},${y}) ${got} != ${want}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  test('inner scroller (Canvas LMS) is expanded in place with the shell once', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('inner-scroller');
    await page.evaluate(() => document.querySelector('#content')?.scrollTo(0, 400));
    const before = await pageState(page);
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    expect(session.warnings.map((w) => w.code)).toContain('INNER_SCROLLER');
    const first = session.slices[0];
    if (!first) throw new Error('no slices');
    const R = first.target.clientRect;
    const contentH = first.target.content.h;
    expect(first.target.kind).toBe('element');
    expect(session.css.h).toBeCloseTo(session.viewport.h + contentH - R.h, 5);
    expect(await pageState(page)).toEqual(before);
    expect(await page.evaluate(() => document.querySelector('#content')?.scrollTop)).toBe(400);

    await dump(serviceWorker, sessionId, 'fixture-inner-scroller');
    const img = await stitched(serviceWorker, sessionId);
    const H = session.css.h;
    // The end marker (60 px, #2d3b45, full content width) appears exactly once, at the bottom of
    // the content. Body text has the same colour, so require it across three columns.
    const xs = [R.x + 40, R.x + R.w / 2 - 200, R.x + R.w - 60];
    const sets = xs.map((x) => new Set(rowsWith(img, dpr, x, '#2d3b45')));
    const marker = runs([...(sets[0] ?? [])].filter((y) => sets.every((s) => s.has(y))));
    expect(marker).toHaveLength(1);
    const [m0, m1] = marker[0] ?? [0, 0];
    expect(m1 - m0).toBe(60);
    expect(Math.abs(m1 - (R.y + contentH - 48))).toBeLessThanOrEqual(1);
    // The notice block is there, near the top of the content.
    expect(rowsWith(img, dpr, R.x + 30, '#fffbd6').length).toBeGreaterThan(100);
    // The dark global nav continues to the bottom; the course nav column stays white.
    expect(near(img.hex(10 * dpr, (H - 5) * dpr), '#394b58')).toBe(true);
    expect(near(img.hex(150 * dpr, (H - 5) * dpr), '#ffffff')).toBe(true);
    // The breadcrumb bar's bottom border (1 px #c7cdd1) is drawn once, above the scroller.
    expect(runs(rowsWith(img, dpr, 400, '#c7cdd1', 12)).filter(([a]) => a < R.y)).toHaveLength(1);
  });

  test('lazy images, scroll-reveal and content-visibility render before their slice', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('lazy-images');
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __fixture: { allImagesLoaded(): boolean } }
        ).__fixture.allImagesLoaded(),
      ),
    ).toBe(true);
    const spots = await page.evaluate(() => {
      const abs = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY };
      };
      return {
        images: [...document.images].map(abs),
        reveals: [...document.querySelectorAll('.reveal')].map(abs),
        cv: [...document.querySelectorAll('.cv .inner')].map(abs),
        height: document.documentElement.scrollHeight,
      };
    });
    expect(session.css.h).toBe(spots.height);
    await dump(serviceWorker, sessionId, 'fixture-lazy-images');
    const img = await stitched(serviceWorker, sessionId);
    spots.images.forEach((p, i) => {
      expect(img.hex((p.x + 600) * dpr, (p.y + 250) * dpr), `image ${i}`).toBe(COLORS[i % 8]);
    });
    spots.reveals.forEach((p, i) => {
      expect(near(img.hex((p.x + 20) * dpr, (p.y + 20) * dpr), '#0a84ff'), `reveal ${i}`).toBe(
        true,
      );
    });
    spots.cv.forEach((p, i) => {
      expect(near(img.hex((p.x + 500) * dpr, (p.y + 50) * dpr), '#34c759'), `cv ${i}`).toBe(true);
      expect(near(img.hex((p.x + 500) * dpr, (p.y + 150) * dpr), '#ffffff'), `cv ${i}`).toBe(true);
    });
  });
});

test.describe('huge page', () => {
  test.use({ dpr: 2, windowSize: { width: 1280, height: 1400 } });

  test('70,000 px at DPR 2 becomes a tiled 140,000 px session', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    test.setTimeout(180_000);
    const page = await pagesnap.openFixture('huge');
    const { session, sessionId, timings } = await captureFull(pagesnap, serviceWorker, page);
    console.log(`[huge] ${JSON.stringify({ ...timings, frameGapsMs: undefined })}`);
    expect(session.status).toBe('ready');
    expect(session.image.h).toBe(140_000);
    expect(session.css.h).toBe(70_000);

    // Sample one label-free column in 16,000 px chunks (canvas side limits).
    const bad: string[] = [];
    const x = 900 * dpr;
    for (let y0 = 0; y0 < session.image.h; y0 += 16_000) {
      const h = Math.min(16_000, session.image.h - y0);
      const col = await stitched(serviceWorker, sessionId, { x, y: y0, w: 1, h });
      for (let y = y0; y < y0 + h; y += 2) {
        const cssY = Math.floor(y / dpr);
        const want = cssY % 1000 < 2 ? '#000000' : COLORS[Math.floor(cssY / 1000) % 8];
        const got = col.hex(0, y - y0);
        if (!near(got, want ?? '')) bad.push(`y=${cssY}: ${got} != ${want}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);

    // Display tiles through openCaptureSource, at the top, middle and bottom.
    const tiles = Math.ceil(140_000 / 2048);
    for (const index of [0, 34, tiles - 1]) {
      const t = await tile(serviceWorker, sessionId, index);
      expect(t.width).toBe(session.image.w);
      const top = index * 2048;
      expect(t.height).toBe(Math.min(2048, 140_000 - top));
      const y = Math.min(1000, Math.floor(t.height / 2));
      const cssY2 = Math.floor((top + y) / dpr);
      const want2 = COLORS[Math.floor(cssY2 / 1000) % 8] ?? '';
      if (cssY2 % 1000 > 2) expect(near(t.hex(x, y), want2), `tile ${index}`).toBe(true);
    }
  });
});
