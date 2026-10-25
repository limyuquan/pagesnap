/**
 * Pure planning maths for the capture (owner: A). No DOM, no `browser`: unit-tested in Node and
 * used by the page agent.
 *
 * All values are CSS px unless stated otherwise.
 */
import type { Rect, Size } from '@/shared/types';

/** Consecutive slices overlap by this much so fractional scales never leave 1 px seams. */
export const OVERLAP_CSS = 2;

/** Horizontal overflow smaller than this is noise (zoom rounding, a stray 1 px), not columns. */
export const MIN_X_OVERFLOW = 16;

/** Vertical overflow of a candidate inner scroller must be at least this. */
export const MIN_SCROLLER_OVERFLOW = 50;

/** Next scroll offset after `prev` along an axis whose last offset is `end`. */
export function nextOffset(prev: number, end: number, view: number, overlap = OVERLAP_CSS): number {
  const step = Math.max(1, view - overlap);
  return Math.min(prev + step, end);
}

/**
 * Scroll offsets covering `[start, end]` (`end` is the last scroll offset, i.e. scrollMax), stepping
 * by `view - overlap` with the last position aligned to `end`.
 */
export function planAxis(
  start: number,
  end: number,
  view: number,
  overlap = OVERLAP_CSS,
): number[] {
  const out = [start];
  if (end <= start) return out;
  let at = start;
  while (at < end) {
    at = nextOffset(at, end, view, overlap);
    out.push(at);
  }
  return out;
}

/**
 * Cap a vertical scroll range so the output (`y1 - y0 + view`) is at most `maxCss` tall and at most
 * `maxSlices` rows are needed (for `columns` slices per row).
 */
export function capRange(
  y0: number,
  y1: number,
  view: number,
  maxCss: number,
  maxSlices = Number.POSITIVE_INFINITY,
  columns = 1,
  overlap = OVERLAP_CSS,
): { y1: number; truncated: boolean } {
  let end = Math.min(y1, y0 + Math.max(0, maxCss - view));
  const maxRows = Math.max(1, Math.floor(maxSlices / Math.max(1, columns)));
  const rowLimitEnd = y0 + (maxRows - 1) * Math.max(1, view - overlap);
  end = Math.min(end, rowLimitEnd);
  end = Math.max(end, y0);
  return { y1: end, truncated: end < y1 };
}

/** Number of slices for a range, rows × columns. */
export function estimateSlices(
  range: { x0: number; x1: number; y0: number; y1: number },
  view: Size,
): number {
  return planAxis(range.y0, range.y1, view.h).length * planAxis(range.x0, range.x1, view.w).length;
}

// ---------------------------------------------------------------------------------------------
// Scroll target choice (01 §3.4)

export interface ScrollerCandidate<T = unknown> {
  ref: T;
  /** Visible box clipped to the viewport. */
  visible: Rect;
  /** scrollHeight - clientHeight. */
  overflow: number;
  /** Contains the element at the viewport centre. */
  containsCenter: boolean;
}

export function scrollerScore(c: ScrollerCandidate, view: Size): number {
  const area = (c.visible.w * c.visible.h) / Math.max(1, view.w * view.h);
  const score = area * Math.log2(2 + c.overflow / Math.max(1, view.h));
  return c.containsCenter ? score * 1.5 : score;
}

/**
 * Pick the scroll target: the document (`null`) or one inner scroller.
 * - Candidates need ≥ `MIN_SCROLLER_OVERFLOW` overflow and ≥ 20% of the viewport visible.
 * - The document wins if it has ≥ 25% of a viewport of overflow, unless the best inner candidate
 *   covers ≥ 50% of the viewport and overflows more than the document does.
 */
export function chooseScrollTarget<T>(
  docOverflow: number,
  candidates: readonly ScrollerCandidate<T>[],
  view: Size,
): ScrollerCandidate<T> | null {
  const viewArea = Math.max(1, view.w * view.h);
  let best: ScrollerCandidate<T> | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.overflow < MIN_SCROLLER_OVERFLOW) continue;
    if ((c.visible.w * c.visible.h) / viewArea < 0.2) continue;
    const s = scrollerScore(c, view);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (!best) return null;
  if (docOverflow >= 0.25 * view.h) {
    const area = (best.visible.w * best.visible.h) / viewArea;
    if (area >= 0.5 && best.overflow > docOverflow) return best;
    return null;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Floating (fixed) elements (01 §3.1)

export type FloatKind = 'shell' | 'side' | 'top' | 'bottom' | 'skip';

/** A `side` float spans at least this share of the scroll area's height... */
export const SIDE_MIN_HEIGHT = 0.6;
/** ...reaches the area's bottom edge within this many CSS px... */
export const SIDE_BOTTOM_TOLERANCE = 8;
/** ...and is at most this share of the viewport wide. */
export const SIDE_MAX_WIDTH = 0.4;

/**
 * Classify a `position: fixed` element by its visible extent in the viewport (the union of its own
 * box and its visible descendants' boxes, see `visibleExtent` in `agent/dom.ts`).
 * - `skip`: invisible, or (for inner scrollers) not overlapping the scroller, so it can't repeat.
 * - `shell`: covers ≥ 50% of the viewport or contains the scroll target. Kept in every slice.
 * - `side`: a sidebar or rail docked beside the content: ≥ `SIDE_MIN_HEIGHT` of the scroll area
 *   tall, reaching its bottom edge (within `SIDE_BOTTOM_TOLERANCE`), at most `SIDE_MAX_WIDTH` of
 *   the viewport wide, and entirely on one side of the scroll area's vertical centre line. Kept in
 *   every slice, in place, so it runs down the side of the stitched image.
 * - `top` / `bottom`: by vertical centre relative to the scroll area. `top` floats are only shown
 *   in the first slice, `bottom` ones only in the last.
 */
export function classifyFloat(
  rect: Rect,
  view: Size,
  scrollArea: Rect,
  opts: { containsTarget?: boolean; elementTarget?: boolean } = {},
): FloatKind {
  if (rect.w < 1 || rect.h < 1) return 'skip';
  const vx0 = Math.max(0, rect.x);
  const vy0 = Math.max(0, rect.y);
  const vx1 = Math.min(view.w, rect.x + rect.w);
  const vy1 = Math.min(view.h, rect.y + rect.h);
  if (vx1 <= vx0 || vy1 <= vy0) return 'skip';
  if (opts.containsTarget) return 'shell';
  if ((vx1 - vx0) * (vy1 - vy0) >= 0.5 * view.w * view.h) return 'shell';
  const ax1 = scrollArea.x + scrollArea.w;
  const ay1 = scrollArea.y + scrollArea.h;
  if (opts.elementTarget) {
    const overlaps = vx0 < ax1 && vx1 > scrollArea.x && vy0 < ay1 && vy1 > scrollArea.y;
    if (!overlaps) return 'skip';
  }
  const areaBottom = Math.min(view.h, ay1);
  const tallInArea = Math.min(vy1, ay1) - Math.max(vy0, scrollArea.y);
  const midX = scrollArea.x + scrollArea.w / 2;
  if (
    tallInArea >= SIDE_MIN_HEIGHT * scrollArea.h &&
    vy1 >= areaBottom - SIDE_BOTTOM_TOLERANCE &&
    vx1 - vx0 <= SIDE_MAX_WIDTH * view.w &&
    (vx1 <= midX || vx0 >= midX)
  ) {
    return 'side';
  }
  const centre = (vy0 + vy1) / 2;
  return centre < scrollArea.y + scrollArea.h / 2 ? 'top' : 'bottom';
}

/** The floats the agent shows or hides per slice (`shell` and `skip` are never touched). */
export type SliceFloatKind = 'top' | 'bottom' | 'side';

/**
 * Which floats are visible in slice `index` (`last` = final slice).
 * - `keep`: all of them, everywhere.
 * - `remove`: `top` and `bottom` floats nowhere. `side` floats stay in every slice: like a `shell`
 *   they are layout (the page reserves their column), never cover content, and removing them would
 *   leave a blank strip down the image.
 * - `smart`: `top` in the first slice only, `bottom` in the last only, `side` in every slice.
 */
export function floatVisible(
  kind: SliceFloatKind,
  mode: 'smart' | 'remove' | 'keep',
  index: number,
  last: boolean,
): boolean {
  if (mode === 'keep' || kind === 'side') return true;
  if (mode === 'remove') return false;
  return kind === 'top' ? index === 0 : last;
}
