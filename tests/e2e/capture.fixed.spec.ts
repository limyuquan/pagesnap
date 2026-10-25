/**
 * Fixed elements classified by their visible extent (qa-sitesB I-1, I-2): a 0 px fixed wrapper
 * around an absolutely positioned nav is a top float, and a full-height fixed sidebar is shown in
 * every slice.
 */
import { captureFull, dump, type Img, near, stitched } from './capture.helpers';
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

/** Expected colour of the banded content at CSS row `y` (bands start at `top`). */
function bandAt(y: number, top: number): string {
  const local = (y - top) % 500;
  return local < 2 ? '#000000' : (COLORS[Math.floor((y - top) / 500) % 8] ?? '');
}

/** CSS rows `[y0, y1)` in column `x` whose colour is not `want(y)`, as readable strings. */
function mismatches(
  img: Img,
  dpr: number,
  x: number,
  y0: number,
  y1: number,
  want: (y: number) => string,
): string[] {
  const bad: string[] = [];
  for (let y = y0; y < y1; y++) {
    const got = img.hex(x * dpr + dpr / 2, y * dpr + dpr / 2);
    if (!near(got, want(y))) bad.push(`(${x},${y}) ${got} != ${want(y)}`);
  }
  return bad;
}

/** Dark (text) pixels in the CSS box, sampled every CSS px. */
function darkPixels(img: Img, dpr: number, x0: number, x1: number, y0: number, y1: number) {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = img.rgb(x * dpr + dpr / 2, y * dpr + dpr / 2);
      if (r + g + b < 200) n++;
    }
  return n;
}

test.describe('fixed elements by visible extent', () => {
  test.use({ dpr: 2 });

  test('a 0 px fixed wrapper around a 56 px nav: nav once at the top, content never covered', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('fixed-zero-wrapper');
    expect(
      await page.evaluate(
        () => document.getElementById('top-nav-bar')?.getBoundingClientRect().height,
      ),
    ).toBe(0);
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    const H = session.css.h;
    expect(H).toBe(6056);
    expect(session.slices.length).toBeGreaterThan(6);
    await dump(serviceWorker, sessionId, 'fixture-fixed-zero-wrapper');
    const img = await stitched(serviceWorker, sessionId);
    // Rows 0..56 are the nav; every row below is the band content (including right under every
    // slice's top edge), and none of the decoys shows.
    expect(mismatches(img, dpr, 600, 0, 56, () => '#282a35')).toEqual([]);
    expect(mismatches(img, dpr, 600, 56, H, (y) => bandAt(y, 56)).slice(0, 10)).toEqual([]);
    expect(mismatches(img, dpr, 1200, 56, H, (y) => bandAt(y, 56)).slice(0, 10)).toEqual([]);
  });

  test('a full-height fixed left sidebar runs down the whole image; header once, bubble last', async ({
    pagesnap,
    serviceWorker,
    dpr,
  }) => {
    const page = await pagesnap.openFixture('fixed-sidebar');
    const vw = await page.evaluate(() => innerWidth);
    const { session, sessionId } = await captureFull(pagesnap, serviceWorker, page);
    expect(session.status).toBe('ready');
    const H = session.css.h;
    expect(H).toBe(6056);
    await dump(serviceWorker, sessionId, 'fixture-fixed-sidebar');
    const img = await stitched(serviceWorker, sessionId);
    // The header once at the top, over the sidebar too.
    expect(mismatches(img, dpr, 8, 0, 56, () => '#282a35')).toEqual([]);
    expect(mismatches(img, dpr, 600, 0, 56, () => '#282a35')).toEqual([]);
    // The sidebar background in every row below the header, top to bottom.
    expect(mismatches(img, dpr, 8, 56, H, () => '#e7e9eb').slice(0, 10)).toEqual([]);
    expect(mismatches(img, dpr, 220, 56, H, () => '#e7e9eb').slice(0, 10)).toEqual([]);
    // Its menu text is there at the top and at the bottom of the image.
    expect(darkPixels(img, dpr, 40, 200, 60, 200)).toBeGreaterThan(50);
    expect(darkPixels(img, dpr, 40, 200, H - 700, H - 560)).toBeGreaterThan(50);
    // The content beside it is never covered by a repeated header.
    expect(mismatches(img, dpr, 600, 56, H, (y) => bandAt(y, 56)).slice(0, 10)).toEqual([]);
    // The chat bubble only in the last slice.
    const bubble: number[] = [];
    for (let y = 0; y < H; y++)
      if (near(img.hex((vw - 54) * dpr, y * dpr + dpr / 2), '#34c759', 4)) bubble.push(y);
    expect(bubble.length).toBeGreaterThan(50);
    expect(Math.min(...bubble)).toBeGreaterThanOrEqual(H - 86);
    expect(Math.max(...bubble)).toBeLessThanOrEqual(H - 22);
  });
});
