/**
 * Display tile rendering (owner: A), used by the compositor worker and by the main-thread
 * fallback. Pixels always go through `compositeRegion` (shared with B's export), so display and
 * export can't disagree. Decoded slices are cached (LRU by bytes) and pinned while a tile uses
 * them, because neighbouring tiles share slices.
 */
import { compositeRegion, partsInRegion } from '@/shared/composite';
import type { BaseLayout, Rect } from '@/shared/types';

export interface TileRenderer {
  render(rect: Rect): Promise<ImageBitmap>;
  dispose(): void;
}

interface Entry {
  bitmap: Promise<ImageBitmap>;
  bytes: number;
  pins: number;
  used: number;
}

/** Decoded-slice budget. At DPR 2 a 1280 × 813 viewport slice is ~16.6 MB. */
const CACHE_BYTES = 200 * 2 ** 20;

export function createTileRenderer(
  layout: BaseLayout,
  loadBlob: (index: number) => Promise<Blob>,
  cacheBytes = CACHE_BYTES,
): TileRenderer {
  const cache = new Map<number, Entry>();
  let clock = 0;
  let disposed = false;

  const evict = () => {
    let total = 0;
    for (const e of cache.values()) total += e.bytes;
    if (total <= cacheBytes) return;
    const idle = [...cache.entries()]
      .filter(([, e]) => e.pins === 0)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [index, e] of idle) {
      if (total <= cacheBytes) break;
      cache.delete(index);
      total -= e.bytes;
      void e.bitmap.then(
        (b) => b.close(),
        () => {},
      );
    }
  };

  const pin = (index: number): Entry => {
    let e = cache.get(index);
    if (!e) {
      const entry: Entry = {
        bitmap: loadBlob(index).then((blob) => createImageBitmap(blob)),
        bytes: 0,
        pins: 0,
        used: 0,
      };
      entry.bitmap.then(
        (b) => {
          entry.bytes = b.width * b.height * 4;
          evict();
        },
        () => cache.delete(index),
      );
      cache.set(index, entry);
      e = entry;
    }
    e.pins++;
    e.used = ++clock;
    return e;
  };

  return {
    async render(rect) {
      if (disposed) throw new Error('DISPOSED');
      const indices = [...new Set(partsInRegion(layout, rect).map((p) => p.slice))];
      const entries = indices.map((i) => [i, pin(i)] as const);
      try {
        const bitmaps = new Map<number, ImageBitmap>();
        await Promise.all(entries.map(async ([i, e]) => bitmaps.set(i, await e.bitmap)));
        const canvas = new OffscreenCanvas(rect.w, rect.h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No 2D context');
        await compositeRegion(ctx, layout, rect, 1, async (i) => {
          const b = bitmaps.get(i);
          if (!b) throw new Error(`Slice ${i} not loaded`);
          return b;
        });
        return canvas.transferToImageBitmap();
      } finally {
        for (const [, e] of entries) e.pins--;
        evict();
      }
    },
    dispose() {
      disposed = true;
      for (const e of cache.values())
        void e.bitmap.then(
          (b) => b.close(),
          () => {},
        );
      cache.clear();
    },
  };
}
