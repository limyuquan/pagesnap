/**
 * Display tile rendering, used by the compositor worker and by the main-thread fallback.
 *
 * - Full resolution (`scale` 1) and the half/quarter levels go through `compositeRegion` (shared
 *   with the export), so display and export can't disagree.
 * - The zoomed-out levels (`scale` ≤ 1/8) are drawn from per-slice thumbnails (1/8 of the slice,
 *   made once when a slice is first decoded, and kept), so a whole 120k-px page at 5% needs each
 *   slice decoded only once and later zoom steps cost almost nothing.
 *
 * Decoded full slices are cached (LRU by bytes) and pinned while a tile uses them, because
 * neighbouring tiles share slices. Jobs run through a small priority queue: visible tiles
 * (`high`) before prefetch (`low`), at most `CONCURRENCY` at once, and a queued job can be
 * cancelled before it starts.
 */
import { compositeRegion, intersect, partsInRegion } from '@/shared/composite';
import type { BaseLayout, Rect } from '@/shared/types';

export type RenderPriority = 'high' | 'low';

export interface RenderOptions {
  priority?: RenderPriority;
  /** Checked before the job starts and before it draws. */
  isCancelled?: () => boolean;
}

export interface TileRenderer {
  /** `rect` in image px; output is `round(rect.w * scale) × round(rect.h * scale)`. */
  render(rect: Rect, scale?: number, opts?: RenderOptions): Promise<ImageBitmap>;
  dispose(): void;
}

interface Entry {
  bitmap: Promise<ImageBitmap>;
  bytes: number;
  pins: number;
  used: number;
}

interface Thumb {
  bitmap: ImageBitmap;
  /** Thumb px per slice bitmap px, per axis. */
  fx: number;
  fy: number;
  bytes: number;
  used: number;
}

/** Decoded-slice budget. At DPR 2 a 1280 × 813 viewport slice is ~16.6 MB. */
const CACHE_BYTES = 200 * 2 ** 20;
/** Thumbnails: 1/8 of a slice per side (1/64 of its bytes); the whole WW2 page is ~19 MB. */
export const THUMB_SCALE = 1 / 8;
const THUMB_BYTES = 64 * 2 ** 20;
/** Parallel tile jobs (slice decodes are the cost; two keep the worker busy without hogging). */
const CONCURRENCY = 2;

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export function createTileRenderer(
  layout: BaseLayout,
  loadBlob: (index: number) => Promise<Blob>,
  cacheBytes = CACHE_BYTES,
): TileRenderer {
  const cache = new Map<number, Entry>();
  const thumbs = new Map<number, Thumb>();
  const thumbJobs = new Map<number, Promise<Thumb>>();
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

  const evictThumbs = () => {
    let total = 0;
    for (const t of thumbs.values()) total += t.bytes;
    if (total <= THUMB_BYTES) return;
    for (const [i, t] of [...thumbs.entries()].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= THUMB_BYTES) break;
      thumbs.delete(i);
      total -= t.bytes;
      t.bitmap.close();
    }
  };

  const makeThumb = async (index: number, full: ImageBitmap): Promise<Thumb> => {
    const w = Math.max(1, Math.round(full.width * THUMB_SCALE));
    const h = Math.max(1, Math.round(full.height * THUMB_SCALE));
    const bitmap = await createImageBitmap(full, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'medium',
    });
    const t: Thumb = {
      bitmap,
      fx: w / full.width,
      fy: h / full.height,
      bytes: w * h * 4,
      used: ++clock,
    };
    if (disposed) {
      bitmap.close();
      return t;
    }
    thumbs.get(index)?.bitmap.close();
    thumbs.set(index, t);
    evictThumbs();
    return t;
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
          // Every first decode leaves a thumbnail behind for the zoomed-out levels.
          if (!thumbs.has(index) && !thumbJobs.has(index)) {
            const job = makeThumb(index, b);
            thumbJobs.set(index, job);
            job.then(
              () => thumbJobs.delete(index),
              () => thumbJobs.delete(index),
            );
          }
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

  /** Thumbnail of slice `index`, decoding the slice if needed. */
  const thumbOf = async (index: number): Promise<Thumb> => {
    const have = thumbs.get(index);
    if (have) {
      have.used = ++clock;
      return have;
    }
    const pending = thumbJobs.get(index);
    if (pending) return pending;
    const e = pin(index);
    try {
      const full = await e.bitmap;
      const after = thumbs.get(index) ?? (await (thumbJobs.get(index) ?? makeThumb(index, full)));
      return after;
    } finally {
      e.pins--;
      evict();
    }
  };

  const renderFull = async (rect: Rect, scale: number, cancelled: () => boolean) => {
    const indices = [...new Set(partsInRegion(layout, rect).map((p) => p.slice))];
    const entries = indices.map((i) => [i, pin(i)] as const);
    try {
      const bitmaps = new Map<number, ImageBitmap>();
      await Promise.all(entries.map(async ([i, e]) => bitmaps.set(i, await e.bitmap)));
      if (cancelled()) throw abortError();
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(rect.w * scale)),
        Math.max(1, Math.round(rect.h * scale)),
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D context');
      await compositeRegion(ctx, layout, rect, scale, async (i) => {
        const b = bitmaps.get(i);
        if (!b) throw new Error(`Slice ${i} not loaded`);
        return b;
      });
      return canvas.transferToImageBitmap();
    } finally {
      for (const [, e] of entries) e.pins--;
      evict();
    }
  };

  /** Same placement rules as `compositeRegion`, drawn from the slice thumbnails. */
  const renderFromThumbs = async (rect: Rect, scale: number, cancelled: () => boolean) => {
    const parts = partsInRegion(layout, rect);
    const indices = [...new Set(parts.map((p) => p.slice))];
    const got = new Map<number, Thumb>();
    // One slice at a time keeps peak memory at one decoded slice per job.
    for (const i of indices) {
      if (cancelled()) throw abortError();
      got.set(i, await thumbOf(i));
    }
    if (cancelled()) throw abortError();
    const W = Math.max(1, Math.round(rect.w * scale));
    const H = Math.max(1, Math.round(rect.h * scale));
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D context');
    const toOut = (r: Rect) => {
      const x0 = Math.round((r.x - rect.x) * scale);
      const y0 = Math.round((r.y - rect.y) * scale);
      const x1 = Math.round((r.x + r.w - rect.x) * scale);
      const y1 = Math.round((r.y + r.h - rect.y) * scale);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.fillStyle = layout.background;
    ctx.fillRect(0, 0, W, H);
    for (const f of layout.fills) {
      const hit = intersect(f.rect, rect);
      if (!hit) continue;
      const o = toOut(hit);
      ctx.fillStyle = f.color;
      ctx.fillRect(o.x, o.y, o.w, o.h);
    }
    for (const p of parts) {
      const o = toOut(p.dest);
      if (o.w <= 0 || o.h <= 0) continue;
      const t = got.get(p.slice);
      if (!t) continue;
      ctx.drawImage(
        t.bitmap,
        p.src.x * t.fx,
        p.src.y * t.fy,
        Math.max(0.01, p.src.w * t.fx),
        Math.max(0.01, p.src.h * t.fy),
        o.x,
        o.y,
        o.w,
        o.h,
      );
    }
    return canvas.transferToImageBitmap();
  };

  // ---- priority queue
  interface Job {
    run: () => Promise<void>;
    priority: RenderPriority;
  }
  const queue: Job[] = [];
  let running = 0;
  const pump = () => {
    while (running < CONCURRENCY && queue.length > 0) {
      const at = queue.findIndex((j) => j.priority === 'high');
      const [job] = queue.splice(Math.max(at, 0), 1);
      if (!job) return;
      running++;
      void job.run().finally(() => {
        running--;
        pump();
      });
    }
  };

  return {
    render(rect, scale = 1, opts = {}) {
      if (disposed) return Promise.reject(new Error('DISPOSED'));
      const cancelled = () => disposed || (opts.isCancelled?.() ?? false);
      return new Promise<ImageBitmap>((resolve, reject) => {
        queue.push({
          priority: opts.priority ?? 'high',
          run: async () => {
            try {
              if (cancelled()) throw abortError();
              const bmp =
                scale <= THUMB_SCALE + 1e-9
                  ? await renderFromThumbs(rect, scale, cancelled)
                  : await renderFull(rect, scale, cancelled);
              resolve(bmp);
            } catch (err) {
              reject(err);
            }
          },
        });
        pump();
      });
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      for (const e of cache.values())
        void e.bitmap.then(
          (b) => b.close(),
          () => {},
        );
      cache.clear();
      for (const t of thumbs.values()) t.bitmap.close();
      thumbs.clear();
    },
  };
}
