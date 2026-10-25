/**
 * The one way to turn stored slices into base-image pixels. Used by the compositor (A) to build
 * display tiles and by the export worker (B) to render the full-resolution base under the
 * annotations, so screen and export can never disagree.
 *
 * Worker-safe: no DOM, no `browser`. Needs `createImageBitmap` and a 2D context.
 */
import type { BaseLayout, Rect } from './types';

/** A part of the layout clipped to a region. Both rects are 1:1 (same w/h). */
export interface ClippedPart {
  slice: number;
  /** Crop in slice bitmap px. */
  src: Rect;
  /** Where it lands, image px. */
  dest: Rect;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

/** Layout parts that touch `region` (image px), clipped to it, in draw order. Pure. */
export function partsInRegion(layout: BaseLayout, region: Rect): ClippedPart[] {
  const out: ClippedPart[] = [];
  for (const p of layout.parts) {
    const placed = { x: p.dest.x, y: p.dest.y, w: p.src.w, h: p.src.h };
    const hit = intersect(placed, region);
    if (!hit) continue;
    out.push({
      slice: p.slice,
      src: { x: p.src.x + (hit.x - p.dest.x), y: p.src.y + (hit.y - p.dest.y), w: hit.w, h: hit.h },
      dest: hit,
    });
  }
  return out;
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Provides slice pixels. Return a `Blob` (decoded and closed here) or an `ImageBitmap` of the
 * whole slice (the caller owns it and is responsible for closing it, e.g. an LRU cache).
 */
export type SliceLoader = (index: number) => Promise<Blob | ImageBitmap>;

/**
 * Draw `region` (image px) of the base image into `ctx` at output origin (0, 0), scaled by `scale`
 * (output px per image px). Output edges are rounded to whole pixels so adjacent parts never leave
 * seams. Leaves the context transform untouched.
 */
export async function compositeRegion(
  ctx: Ctx2D,
  layout: BaseLayout,
  region: Rect,
  scale: number,
  loadSlice: SliceLoader,
): Promise<void> {
  const toOut = (r: Rect) => {
    const x0 = Math.round((r.x - region.x) * scale);
    const y0 = Math.round((r.y - region.y) * scale);
    const x1 = Math.round((r.x + r.w - region.x) * scale);
    const y1 = Math.round((r.y + r.h - region.y) * scale);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = scale !== 1;
  ctx.imageSmoothingQuality = 'high';

  const all = toOut(region);
  ctx.fillStyle = layout.background;
  ctx.fillRect(all.x, all.y, all.w, all.h);
  for (const f of layout.fills) {
    const hit = intersect(f.rect, region);
    if (!hit) continue;
    const o = toOut(hit);
    ctx.fillStyle = f.color;
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }

  for (const part of partsInRegion(layout, region)) {
    const o = toOut(part.dest);
    if (o.w <= 0 || o.h <= 0) continue;
    const pixels = await loadSlice(part.slice);
    const { x, y, w, h } = part.src;
    if (pixels instanceof Blob) {
      const bmp = await createImageBitmap(pixels, x, y, w, h);
      ctx.drawImage(bmp, 0, 0, w, h, o.x, o.y, o.w, o.h);
      bmp.close();
    } else {
      ctx.drawImage(pixels, x, y, w, h, o.x, o.y, o.w, o.h);
    }
  }
  ctx.restore();
}
