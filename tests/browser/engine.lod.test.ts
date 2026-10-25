/**
 * Level-of-detail tiles from the compositor (qa-stress S1): reduced-scale regions have the right
 * size and pixels, both through `compositeRegion` (1/2, 1/4) and through the slice thumbnails
 * (≤ 1/8), and a zoomed-out tile of a long page renders quickly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compositorBackend, isLodSource, openCaptureSource } from '@/compositor';
import { closeDb, deleteSession } from '@/shared/db';
import { BAND_CSS, bandColor, seedSyntheticSession } from '@/shared/testing/synthetic';

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await deleteSession(id);
  await closeDb();
});

function rgbAt(bmp: ImageBitmap, x: number, y: number): [number, number, number] {
  const c = new OffscreenCanvas(1, 1);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no ctx');
  ctx.drawImage(bmp, x, y, 1, 1, 0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const near = (a: number[], b: number[], tol: number) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

describe('LOD regions', () => {
  it('renders 1/2, 1/4, 1/8 and 1/16 with the right size and band colours', async () => {
    const dpr = 2;
    const id = await seedSyntheticSession({ cssW: 640, cssH: 12_000, viewportH: 800, dpr });
    created.push(id);
    const source = await openCaptureSource(id);
    expect(isLodSource(source)).toBe(true);
    expect(compositorBackend(source)).toBe('worker');
    const rect = { x: 0, y: 4096, w: 1280, h: 16_384 };
    for (const scale of [1 / 2, 1 / 4, 1 / 8, 1 / 16]) {
      const bmp = await source.getRegionBitmap(rect, scale);
      expect([bmp.width, bmp.height]).toEqual([1280 * scale, 16_384 * scale]);
      // Sample the middle of every band in the region, away from labels and band edges.
      for (let cssY = 2048 + 250; cssY < 2048 + 8192; cssY += BAND_CSS) {
        const band = Math.floor(cssY / BAND_CSS);
        const y = (cssY * dpr - rect.y) * scale;
        const got = rgbAt(bmp, Math.round(1100 * scale), Math.round(y));
        expect(near(got, hexRgb(bandColor(band)), 6), `scale ${scale} band ${band}: ${got}`).toBe(
          true,
        );
      }
      bmp.close();
    }
    source.dispose();
  });

  it('a 1/16 tile of a 2560 × 118548 page is quick once its slices are decoded', async () => {
    const id = await seedSyntheticSession({ cssW: 1280, cssH: 59_274, viewportH: 813, dpr: 2 });
    created.push(id);
    const source = await openCaptureSource(id);
    const rect = { x: 0, y: 0, w: 2560, h: 32_768 };
    const t0 = performance.now();
    const cold = await source.getRegionBitmap(rect, 1 / 16, { priority: 'low' });
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    // Same slices, another level: served from the thumbnails, no decode.
    const warm = await source.getRegionBitmap(rect, 1 / 32);
    const warmMs = performance.now() - t1;
    console.log(`[lod] 1/16 cold ${coldMs.toFixed(0)} ms, 1/32 warm ${warmMs.toFixed(0)} ms`);
    expect([cold.width, cold.height]).toEqual([160, 2048]);
    expect([warm.width, warm.height]).toEqual([80, 1024]);
    expect(warmMs).toBeLessThan(100);
    cold.close();
    warm.close();
    source.dispose();
  });

  it('a cancelled region request rejects with an AbortError', async () => {
    const id = await seedSyntheticSession({ cssW: 400, cssH: 6000, viewportH: 600, dpr: 1 });
    created.push(id);
    const source = await openCaptureSource(id);
    const ac = new AbortController();
    const p = source.getRegionBitmap({ x: 0, y: 2048, w: 400, h: 2048 }, 1 / 4, {
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    source.dispose();
  });
});
