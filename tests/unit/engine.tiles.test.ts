/**
 * Tile cache invariants (correctness #2, qa-stress S1): no reload loop while idle, the prefetch
 * stays within the budget, wanted tiles are never evicted, and zoomed-out views use a coarse
 * level so their bytes stay small.
 */
import { describe, expect, it } from 'vitest';
import { planDisplayTiles } from '@/compositor';
import { fitWidthCamera, visibleRect } from '@/editor/engine/geometry';
import {
  levelForScale,
  maxLevelFor,
  planLevelTiles,
  TILE_BUDGET_BYTES,
  TileCache,
} from '@/editor/engine/tiles';
import type { CaptureSource } from '@/shared/source';
import type { Rect, Size } from '@/shared/types';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function idle(n = 300) {
  for (let i = 0; i < n; i++) await tick();
}

function fakeBitmap(w: number, h: number, onClose?: () => void): ImageBitmap {
  return { width: w, height: h, close: () => onClose?.() } as unknown as ImageBitmap;
}

/** A source with only the v0.1 full-resolution API. */
function plainSource(image: Size) {
  const tiles = planDisplayTiles(image);
  const counter = { loads: 0, closes: 0 };
  const source: CaptureSource = {
    session: { image } as never,
    tiles,
    async getTileBitmap(i) {
      counter.loads++;
      await tick();
      const t = tiles[i] as (typeof tiles)[number];
      return fakeBitmap(t.rect.w, t.rect.h, () => counter.closes++);
    },
    dispose() {},
  };
  return { source, counter };
}

/** A source with the LOD API (`getRegionBitmap`). */
function lodSource(image: Size) {
  const { source, counter } = plainSource(image);
  const scales: number[] = [];
  const lod = Object.assign(source, {
    async getRegionBitmap(rect: Rect, scale: number) {
      counter.loads++;
      scales.push(scale);
      await tick();
      return fakeBitmap(
        Math.max(1, Math.round(rect.w * scale)),
        Math.max(1, Math.round(rect.h * scale)),
        () => counter.closes++,
      );
    },
  });
  return { source: lod, counter, scales };
}

const prefetchOf = (v: Rect): Rect => ({ x: v.x, y: v.y - v.h, w: v.w, h: v.h * 3 });

describe('TileCache: no reload loop', () => {
  // The reviewers' repro (review.tiles2.test.ts): fit width on big displays at DPR 2.
  for (const [label, cssW, vpH] of [
    ['5K display, 2560 CSS', 2560, 1300],
    ['MBP 16, 1728 CSS', 1728, 1000],
    ['MBP 14, 1512 CSS', 1512, 860],
  ] as const) {
    it(`idle at fit width: ${label}`, async () => {
      const dpr = 2;
      const image = { w: cssW * dpr, h: 30_000 * dpr };
      const { source, counter } = plainSource(image);
      const cache = new TileCache(source, () => {});
      const viewport = { w: cssW, h: vpH };
      const cam = { ...fitWidthCamera(image, viewport, dpr), y: 20_000 };
      const visible = visibleRect(cam, viewport);
      for (let i = 0; i < 5; i++) {
        cache.update(visible, prefetchOf(visible));
        await idle(100);
      }
      const settled = counter.loads;
      for (let i = 0; i < 20; i++) {
        cache.update(visible, prefetchOf(visible)); // frames keep coming
        await idle(20);
      }
      expect(counter.loads, 'loads after settling').toBe(settled);
      expect(settled).toBeLessThan(15);
      expect(cache.bytes).toBeLessThanOrEqual(Math.max(TILE_BUDGET_BYTES, cache.wantedBytes));
    });
  }

  it('reviewers’ 3840-wide case: prefetch over budget no longer thrashes', async () => {
    const image = { w: 3840, h: 40_000 };
    const { source, counter } = plainSource(image);
    const cache = new TileCache(source, () => {});
    const visible = { x: 0, y: 10_000, w: 3840, h: 4000 };
    for (let i = 0; i < 40; i++) {
      cache.update(visible, { x: 0, y: 6000, w: 3840, h: 12_000 });
      await idle(10);
    }
    expect(counter.loads).toBeLessThan(10);
    expect(cache.wantedBytes).toBeLessThanOrEqual(TILE_BUDGET_BYTES);
  });

  it('never evicts a wanted tile, even when the budget is tiny', async () => {
    const image = { w: 2560, h: 60_000 };
    const { source, counter } = plainSource(image);
    const cache = new TileCache(source, () => {}, 1); // 1 byte: only visible tiles fit
    const visible = { x: 0, y: 3000, w: 2560, h: 3000 };
    for (let i = 0; i < 20; i++) {
      cache.update(visible, prefetchOf(visible));
      await idle(10);
    }
    // 2048-tall strips: 3000..6000 touches 2 tiles; no prefetch fits, nothing reloads.
    expect(counter.loads).toBe(2);
    expect(cache.residentCount).toBe(2);
    expect(cache.covers(visible)).toBe(true);
  });
});

describe('TileCache: levels of detail', () => {
  it('levelForScale picks the coarsest level at least as sharp as the screen', () => {
    expect(levelForScale(1, 6)).toBe(0);
    expect(levelForScale(1.5, 6)).toBe(0);
    expect(levelForScale(0.51, 6)).toBe(0);
    expect(levelForScale(0.5, 6)).toBe(1);
    expect(levelForScale(0.26, 6)).toBe(1);
    expect(levelForScale(0.25, 6)).toBe(2);
    expect(levelForScale(0.1, 6)).toBe(3);
    expect(levelForScale(0.05, 6)).toBe(4);
    expect(levelForScale(0.01, 3)).toBe(3);
  });

  it('level tiles cover the image exactly', () => {
    const image = { w: 2560, h: 118_548 };
    for (let k = 0; k <= maxLevelFor(image); k++) {
      const tiles = planLevelTiles(image, k);
      let area = 0;
      for (const t of tiles) {
        expect(t.rect.x + t.rect.w).toBeLessThanOrEqual(image.w + 1e-6);
        expect(t.rect.y + t.rect.h).toBeLessThanOrEqual(image.h + 1e-6);
        area += t.rect.w * t.rect.h;
      }
      expect(area).toBeCloseTo(image.w * image.h, -2);
    }
  });

  it('5% of a 2560×118548 page: coarse tiles, a few MB, and quiet when idle', async () => {
    const image = { w: 2560, h: 118_548 };
    const { source, counter, scales } = lodSource(image);
    const cache = new TileCache(source, () => {});
    // 5% at DPR 2 on a DPR-2 screen: zoom 0.025 CSS px per image px, device scale 0.05.
    const zoom = 0.025;
    const viewport = { w: 1280, h: 767 };
    const visible = visibleRect({ x: 0, y: 40_000, zoom }, viewport);
    const level = levelForScale(zoom * 2, cache.maxLevel);
    expect(level).toBe(4);
    for (let i = 0; i < 10; i++) {
      cache.update(visible, prefetchOf(visible), level);
      await idle(20);
    }
    const settled = counter.loads;
    for (let i = 0; i < 20; i++) {
      cache.update(visible, prefetchOf(visible), level);
      await idle(10);
    }
    expect(counter.loads).toBe(settled);
    expect(new Set(scales)).toEqual(new Set([1 / 16]));
    expect(cache.bytes).toBeLessThan(16 * 2 ** 20);
    expect(cache.covers(visible)).toBe(true);
  });

  it('keeps the previous level as a fallback, then releases it once the new one is in', async () => {
    const image = { w: 2560, h: 60_000 };
    const { source } = lodSource(image);
    const cache = new TileCache(source, () => {});
    const v0 = { x: 0, y: 10_000, w: 2560, h: 1600 };
    cache.update(v0, prefetchOf(v0), 0);
    await idle(50);
    expect(cache.covers(v0)).toBe(true);
    const v2 = { x: 0, y: 8000, w: 2560, h: 6400 };
    cache.update(v2, prefetchOf(v2), 2);
    // Before the level-2 tiles land, level-0 tiles are there to draw instead.
    expect(cache.fallbacks(v2, 2).length).toBeGreaterThan(0);
    await idle(50);
    expect(cache.covers(v2)).toBe(true);
    expect(cache.bytes).toBeLessThanOrEqual(Math.max(TILE_BUDGET_BYTES / 2, cache.wantedBytes));
  });
});
