/**
 * Build the final `BaseLayout` (the recipe for the base image) from the captured slices.
 * Pure, owner: A. See CONTRACTS §4.2 and 01 §3.4 / §5.7.
 *
 * - `document` target: every slice is the viewport at its output position `place` (the scroll
 *   offset, re-anchored when content above it moved; see `SliceMeta.place`), placed at
 *   `round((place - start) * scale)`. The last row/column is aligned to the image edge so rounding
 *   never leaves a 1 px gap (the 2 px overlap absorbs the shift).
 * - `element` target (inner scroller, "expand in place"): the band above and the rails beside the
 *   scroller come from slice 0, the scroller's client rect from every slice, the band below from the
 *   last slice shifted down by the extra content height. Below their original height the side rails
 *   are continued with solid fills sampled from slice 0's bottom rail row (`sideRuns`).
 */
import type { BaseLayout, FillRect, Placement, Rect, Size, SliceMeta } from '@/shared/types';

/** A horizontal run of one colour, bitmap px (x range within the sampled row). */
export interface ColorRun {
  x0: number;
  x1: number;
  color: string;
}

export interface LayoutInput {
  slices: readonly SliceMeta[];
  /** Image px per CSS px. */
  scale: number;
  background?: string;
  /** For `element` targets: colour runs of slice 0's last row beside the scroller, bitmap px. */
  sideRuns?: { left: readonly ColorRun[]; right: readonly ColorRun[] };
}

export interface LayoutResult {
  css: Size;
  image: Size;
  layout: BaseLayout;
}

/** The scroller rect in bitmap px of a slice (rounded edges, clamped to the bitmap). */
export function scrollerBitmapRect(clientRect: Rect, scale: number, bitmap: Size): Rect {
  const x0 = clamp(Math.round(clientRect.x * scale), 0, bitmap.w);
  const y0 = clamp(Math.round(clientRect.y * scale), 0, bitmap.h);
  const x1 = clamp(Math.round((clientRect.x + clientRect.w) * scale), x0, bitmap.w);
  const y1 = clamp(Math.round((clientRect.y + clientRect.h) * scale), y0, bitmap.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function buildLayout(input: LayoutInput): LayoutResult {
  const first = input.slices[0];
  const background = input.background ?? '#ffffff';
  if (!first) {
    const size = { w: 0, h: 0 };
    return { css: size, image: size, layout: { size, background, fills: [], parts: [] } };
  }
  return first.target.kind === 'element'
    ? elementLayout(input, first, background)
    : documentLayout(input, first, background);
}

/** Output position of a slice, CSS px in scroll space. */
export function placeOf(s: SliceMeta): { x: number; y: number } {
  return s.place ?? s.scroll;
}

function documentLayout(input: LayoutInput, first: SliceMeta, background: string): LayoutResult {
  const { slices, scale } = input;
  const { clientRect, range } = first.target;
  let maxX = range.x0;
  let maxY = range.y0;
  for (const s of slices) {
    const p = placeOf(s);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const css = { w: maxX - range.x0 + clientRect.w, h: maxY - range.y0 + clientRect.h };
  const image = { w: Math.round(css.w * scale), h: Math.round(css.h * scale) };
  const parts: Placement[] = [];
  for (const s of slices) {
    const src = scrollerBitmapRect(s.target.clientRect, scale, s.bitmap);
    const p = placeOf(s);
    let x = Math.round((p.x - range.x0) * scale);
    let y = Math.round((p.y - range.y0) * scale);
    // Align the last row/column with the image edge (rounding can leave it 1 px short or long).
    if (p.x === maxX) x = image.w - src.w;
    if (p.y === maxY) y = image.h - src.h;
    pushClipped(parts, s.index, src, { x: Math.max(0, x), y: Math.max(0, y) }, image);
  }
  return { css, image, layout: { size: image, background, fills: [], parts } };
}

function elementLayout(input: LayoutInput, first: SliceMeta, background: string): LayoutResult {
  const { slices, scale } = input;
  const { clientRect, range } = first.target;
  let maxY = range.y0;
  let last = first;
  for (const s of slices) {
    if (placeOf(s).y >= maxY) {
      maxY = placeOf(s).y;
      last = s;
    }
  }
  const extraCss = maxY - range.y0;
  const bitmap = first.bitmap;
  const viewCss = { w: bitmap.w / scale, h: bitmap.h / scale };
  const css = { w: viewCss.w, h: viewCss.h + extraCss };
  const extra = Math.round(extraCss * scale);
  const image = { w: bitmap.w, h: bitmap.h + extra };
  const r = scrollerBitmapRect(clientRect, scale, bitmap);
  const parts: Placement[] = [];

  // 1. Slice 0 down to the scroller's bottom edge: top band, side rails, first scroller view.
  pushClipped(parts, first.index, { x: 0, y: 0, w: bitmap.w, h: r.y + r.h }, { x: 0, y: 0 }, image);
  // 2. The scroller's client rect from every later slice, in capture order.
  for (const s of slices) {
    if (s === first) continue;
    const sr = scrollerBitmapRect(s.target.clientRect, scale, s.bitmap);
    const dy = s === last ? extra : Math.round((placeOf(s).y - range.y0) * scale);
    pushClipped(parts, s.index, sr, { x: sr.x, y: sr.y + dy }, image);
  }
  // 3. The band below the scroller from the last slice, shifted down.
  const below = bitmap.h - (r.y + r.h);
  if (below > 0) {
    pushClipped(
      parts,
      last.index,
      { x: 0, y: r.y + r.h, w: last.bitmap.w, h: below },
      { x: 0, y: r.y + r.h + extra },
      image,
    );
  }
  // 4. Side rails continued below their original height.
  const fills: FillRect[] = [];
  if (extra > 0 && input.sideRuns) {
    const y = r.y + r.h;
    for (const run of [...input.sideRuns.left, ...input.sideRuns.right]) {
      if (run.x1 <= run.x0) continue;
      fills.push({ rect: { x: run.x0, y, w: run.x1 - run.x0, h: extra }, color: run.color });
    }
  }
  return { css, image, layout: { size: image, background, fills, parts } };
}

function pushClipped(
  parts: Placement[],
  slice: number,
  src: Rect,
  dest: { x: number; y: number },
  image: Size,
): void {
  const w = Math.min(src.w, image.w - dest.x);
  const h = Math.min(src.h, image.h - dest.y);
  if (w <= 0 || h <= 0) return;
  parts.push({ slice, src: { x: src.x, y: src.y, w, h }, dest: { x: dest.x, y: dest.y } });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------------------------
// Side rail colour runs

/**
 * Split one RGBA pixel row into runs of (nearly) one colour. Runs narrower than `minRun` px are
 * merged into their left neighbour, so text or icons in the row don't fragment the fill.
 */
export function colorRuns(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  offsetX = 0,
  tolerance = 12,
  minRun = 4,
): ColorRun[] {
  const raw: { x0: number; x1: number; rgb: [number, number, number] }[] = [];
  for (let x = 0; x < width; x++) {
    const i = x * 4;
    const rgb: [number, number, number] = [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0];
    const prev = raw[raw.length - 1];
    if (prev && near(prev.rgb, rgb, tolerance)) prev.x1 = x + 1;
    else raw.push({ x0: x, x1: x + 1, rgb });
  }
  const merged: typeof raw = [];
  for (const run of raw) {
    const prev = merged[merged.length - 1];
    if (prev && run.x1 - run.x0 < minRun) prev.x1 = run.x1;
    else if (prev && prev.x1 - prev.x0 < minRun) {
      prev.x1 = run.x1;
      prev.rgb = run.rgb;
    } else merged.push({ ...run });
  }
  // Neighbours may now be the same colour.
  const out: ColorRun[] = [];
  for (const run of merged) {
    const color = hex(run.rgb);
    const prev = out[out.length - 1];
    if (prev && prev.color === color) prev.x1 = run.x1 + offsetX;
    else out.push({ x0: run.x0 + offsetX, x1: run.x1 + offsetX, color });
  }
  return out;
}

function near(a: readonly number[], b: readonly number[], tol: number): boolean {
  return (
    Math.abs((a[0] ?? 0) - (b[0] ?? 0)) <= tol &&
    Math.abs((a[1] ?? 0) - (b[1] ?? 0)) <= tol &&
    Math.abs((a[2] ?? 0) - (b[2] ?? 0)) <= tol
  );
}

function hex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
