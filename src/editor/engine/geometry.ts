/**
 * Pure geometry for the editor engine (owner: B): camera maths, shape bounds, hit-testing,
 * handles, snapping and shape transforms. No DOM, no canvas (text width comes from an injectable
 * measurer so this runs in Node tests, workers and pages alike).
 *
 * Units: shapes are image px. The camera's `zoom` is CSS px per image px.
 */
import type {
  ArrowShape,
  PenShape,
  RectShape,
  Shape,
  ShapeId,
  TextShape,
} from '@/shared/annotations';
import type { Point, Rect, Size } from '@/shared/types';

// ------------------------------------------------------------------------------- basics

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Normalised rect from two corners. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Distance from `p` to the segment `a`–`b`. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ------------------------------------------------------------------------------- snapping

/** Snap `p` so the direction `a`→`p` is a multiple of `stepDeg` (default 45°), keeping the length. */
export function snapAngle(a: Point, p: Point, stepDeg = 45): Point {
  const len = dist(a, p);
  if (len === 0) return { ...p };
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / step) * step;
  // Round tiny float noise so horizontal/vertical results are exact.
  const x = a.x + Math.round(Math.cos(ang) * len * 1e6) / 1e6;
  const y = a.y + Math.round(Math.sin(ang) * len * 1e6) / 1e6;
  return { x, y };
}

/** Square box from anchor `a` towards `p` (Shift on the rect tool). */
export function squareFrom(a: Point, p: Point): Point {
  const s = Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y));
  return { x: a.x + Math.sign(p.x - a.x || 1) * s, y: a.y + Math.sign(p.y - a.y || 1) * s };
}

// ------------------------------------------------------------------------------- arrow

/** Half-angle of the arrowhead triangle. */
export const ARROW_HEAD_HALF_ANGLE = (26 * Math.PI) / 180;

/**
 * Arrowhead length for a stroke `width` (image px) on an image captured at `dpr`: four stroke
 * widths, at least 18 CSS px, and never more than 60% of the arrow so short arrows stay arrows.
 */
export function arrowHeadLength(width: number, length: number, dpr: number): number {
  return Math.min(Math.max(4 * width, 18 * dpr), length * 0.6);
}

export interface ArrowGeometry {
  /** Shaft end (shortened so the round cap doesn't poke through the tip). */
  shaftEnd: Point;
  /** Head triangle: tip, left, right. */
  head: readonly [Point, Point, Point];
  headLen: number;
}

export function arrowGeometry(
  s: Pick<ArrowShape, 'a' | 'b' | 'width'>,
  dpr: number,
): ArrowGeometry {
  const len = dist(s.a, s.b);
  const headLen = arrowHeadLength(s.width, len, dpr);
  const ux = len ? (s.b.x - s.a.x) / len : 1;
  const uy = len ? (s.b.y - s.a.y) / len : 0;
  const back = { x: s.b.x - ux * headLen, y: s.b.y - uy * headLen };
  const half = Math.tan(ARROW_HEAD_HALF_ANGLE) * headLen;
  const left = { x: back.x - uy * half, y: back.y + ux * half };
  const right = { x: back.x + uy * half, y: back.y - ux * half };
  const shaft = Math.max(0, len - headLen * 0.8);
  return {
    shaftEnd: { x: s.a.x + ux * shaft, y: s.a.y + uy * shaft },
    head: [{ ...s.b }, left, right],
    headLen,
  };
}

/** Head triangles of an arrow: one at `b`, plus one at `a` for `heads: 'both'`. */
export function arrowHeads(
  s: Pick<ArrowShape, 'a' | 'b' | 'width' | 'heads'>,
  dpr: number,
): (readonly [Point, Point, Point])[] {
  const heads = [arrowGeometry(s, dpr).head];
  if (s.heads === 'both') heads.push(arrowGeometry({ a: s.b, b: s.a, width: s.width }, dpr).head);
  return heads;
}

// ------------------------------------------------------------------------------- text

/** Line height as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25;

/** White outline width for `outline` text, as a fraction of the font size (4 px at 26 px). */
export const TEXT_OUTLINE_RATIO = 4 / 26;

export const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function textFont(s: Pick<TextShape, 'size' | 'weight'>): string {
  return `${s.weight} ${s.size}px ${FONT_STACK}`;
}

export type TextMeasurer = (text: string, font: string, size: number) => number;

/** Fallback when no canvas is available (Node): ~0.6 em per character. */
export const estimateTextWidth: TextMeasurer = (text, _font, size) => text.length * size * 0.6;

let measurer: TextMeasurer = estimateTextWidth;
let measurerReady = false;

/** Use a real canvas `measureText` when one exists (pages and workers). Lazy, once. */
function getMeasurer(): TextMeasurer {
  if (measurerReady) return measurer;
  measurerReady = true;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      if (ctx) {
        measurer = (text, font) => {
          ctx.font = font;
          return ctx.measureText(text).width;
        };
      }
    }
  } catch {
    // keep the estimate
  }
  return measurer;
}

/** Override the text measurer (tests). */
export function setTextMeasurer(m: TextMeasurer | null): void {
  measurer = m ?? estimateTextWidth;
  measurerReady = m !== null;
}

export interface TextLayout {
  lines: readonly string[];
  lineHeight: number;
  /** Ink box of the text (without the outline), image px. */
  box: Rect;
}

const textLayoutCache = new WeakMap<TextShape, TextLayout>();

export function textLayout(s: TextShape): TextLayout {
  const hit = textLayoutCache.get(s);
  if (hit) return hit;
  const lines = s.text.split('\n');
  const lineHeight = s.size * TEXT_LINE_HEIGHT;
  const m = getMeasurer();
  const font = textFont(s);
  let w = 0;
  for (const line of lines) w = Math.max(w, m(line, font, s.size));
  const out: TextLayout = {
    lines,
    lineHeight,
    box: { x: s.at.x, y: s.at.y, w: Math.max(w, s.size * 0.3), h: lines.length * lineHeight },
  };
  textLayoutCache.set(s, out);
  return out;
}

// ------------------------------------------------------------------------------- bounds

function pointsBounds(pts: readonly Point[]): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { ...EMPTY_RECT };
}

const boundsCache = new WeakMap<Shape, { dpr: number; r: Rect }>();

/**
 * Visual extent of a shape in image px, including stroke width, arrowheads and the text outline
 * (not the soft shadow). Used for culling, selection boxes and the smart copy region.
 */
export function shapeBounds(s: Shape, dpr: number): Rect {
  const hit = boundsCache.get(s);
  if (hit && hit.dpr === dpr) return hit.r;
  let r: Rect;
  switch (s.kind) {
    case 'arrow': {
      const corners = arrowHeads(s, dpr).flatMap((h) => [h[1], h[2]]);
      r = inflate(pointsBounds([s.a, s.b, ...corners]), s.width / 2 + 1);
      break;
    }
    case 'underline':
      // Square caps extend by half the width in every direction.
      r = inflate(
        pointsBounds([s.a, s.b]),
        s.a.y === s.b.y || s.a.x === s.b.x ? s.width / 2 : (s.width / 2) * Math.SQRT2,
      );
      break;
    case 'highlight': {
      // Butt caps: a horizontal band doesn't extend past its ends.
      const b = pointsBounds([s.a, s.b]);
      r =
        b.h === 0
          ? { x: b.x, y: b.y - s.thickness / 2, w: b.w, h: s.thickness }
          : inflate(b, s.thickness / 2);
      break;
    }
    case 'rect':
      r = inflate(s.box, s.width / 2);
      break;
    case 'pen': {
      const pts = s.pts.map(([x, y]) => ({ x, y }));
      r = inflate(pointsBounds(pts), s.size / 2 + 1);
      break;
    }
    case 'text': {
      const box = textLayout(s).box;
      r =
        s.style === 'outline'
          ? inflate(box, s.size * TEXT_OUTLINE_RATIO * 0.5)
          : inflate(box, s.size * 0.25);
      break;
    }
  }
  boundsCache.set(s, { dpr, r });
  return r;
}

/** Union of all shape bounds, or `null` when there are none. */
export function shapesBounds(shapes: readonly Shape[], dpr: number): Rect | null {
  let r: Rect | null = null;
  for (const s of shapes) r = unionRect(r, shapeBounds(s, dpr));
  return r;
}

// ------------------------------------------------------------------------------- hit-testing

/** Hit-test tolerance: this many CSS px on screen. */
export const HIT_TOLERANCE_CSS = 6;

function distToPolyline(p: Point, pts: PenShape['pts']): number {
  if (pts.length === 0) return Number.POSITIVE_INFINITY;
  const first = pts[0] as readonly [number, number, number];
  if (pts.length === 1) return Math.hypot(p.x - first[0], p.y - first[1]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as readonly [number, number, number];
    const b = pts[i] as readonly [number, number, number];
    const d = distToSegment(p, { x: a[0], y: a[1] }, { x: b[0], y: b[1] });
    if (d < best) best = d;
  }
  return best;
}

function pointInTriangle(p: Point, t: readonly [Point, Point, Point]): boolean {
  const [a, b, c] = t;
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

function rectBorderDistance(p: Point, r: RectShape['box']): number {
  const inside = pointInRect(p, r);
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  if (!inside) return Math.hypot(dx, dy);
  return Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y);
}

/** Does `p` (image px) hit shape `s`? `tol` is in image px. */
export function hitShape(s: Shape, p: Point, tol: number, dpr: number): boolean {
  switch (s.kind) {
    case 'arrow': {
      if (distToSegment(p, s.a, s.b) <= s.width / 2 + tol) return true;
      return arrowHeads(s, dpr).some((h) => pointInTriangle(p, h));
    }
    case 'underline':
      return distToSegment(p, s.a, s.b) <= s.width / 2 + tol;
    case 'highlight':
      return distToSegment(p, s.a, s.b) <= s.thickness / 2 + tol;
    case 'rect':
      if (s.fill !== 'none' && pointInRect(p, s.box)) return true;
      return rectBorderDistance(p, s.box) <= s.width / 2 + tol;
    case 'pen':
      return distToPolyline(p, s.pts) <= s.size / 2 + tol;
    case 'text':
      return pointInRect(p, inflate(textLayout(s).box, tol));
  }
}

/** Highlights and marker strokes are drawn in the pass underneath everything else. */
export function isUnderlay(s: Shape): boolean {
  return s.kind === 'highlight' || (s.kind === 'pen' && s.marker);
}

/**
 * Shapes in on-screen stacking order, bottom first: the underlay pass (highlights, markers) then
 * the rest, each in array order. Hit-testing walks this backwards.
 */
export function paintOrder(shapes: readonly Shape[]): Shape[] {
  const under: Shape[] = [];
  const over: Shape[] = [];
  for (const s of shapes) (isUnderlay(s) ? under : over).push(s);
  return under.concat(over);
}

/** Topmost shape at `p`, or `null`. */
export function hitTestShapes(
  shapes: readonly Shape[],
  p: Point,
  tol: number,
  dpr: number,
): Shape | null {
  const order = paintOrder(shapes);
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i] as Shape;
    if (hitShape(s, p, tol, dpr)) return s;
  }
  return null;
}

/** Shapes whose bounds intersect `r`. */
export function shapesInRect(shapes: readonly Shape[], r: Rect, dpr: number): ShapeId[] {
  return shapes.filter((s) => rectsIntersect(shapeBounds(s, dpr), r)).map((s) => s.id);
}

// ------------------------------------------------------------------------------- handles

export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type HandleId = BoxHandle | 'a' | 'b';

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
}

/** Edit handles of a single selected shape (image px). Pens and text have none (move only). */
export function shapeHandles(s: Shape): Handle[] {
  switch (s.kind) {
    case 'arrow':
    case 'underline':
    case 'highlight':
      return [
        { id: 'a', x: s.a.x, y: s.a.y },
        { id: 'b', x: s.b.x, y: s.b.y },
      ];
    case 'rect': {
      const { x, y, w, h } = s.box;
      return [
        { id: 'nw', x, y },
        { id: 'n', x: x + w / 2, y },
        { id: 'ne', x: x + w, y },
        { id: 'e', x: x + w, y: y + h / 2 },
        { id: 'se', x: x + w, y: y + h },
        { id: 's', x: x + w / 2, y: y + h },
        { id: 'sw', x, y: y + h },
        { id: 'w', x, y: y + h / 2 },
      ];
    }
    default:
      return [];
  }
}

/** Handle within `tol` image px of `p`, nearest first. */
export function hitHandle(s: Shape, p: Point, tol: number): HandleId | null {
  let best: HandleId | null = null;
  let bestD = tol;
  for (const h of shapeHandles(s)) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d <= bestD) {
      best = h.id;
      bestD = d;
    }
  }
  return best;
}

/** Rect box after dragging `handle` to `p`. `square` keeps it square (Shift). */
export function resizeBox(box: Rect, handle: BoxHandle, p: Point, square: boolean): Rect {
  let x0 = box.x;
  let y0 = box.y;
  let x1 = box.x + box.w;
  let y1 = box.y + box.h;
  if (handle.includes('w')) x0 = p.x;
  if (handle.includes('e')) x1 = p.x;
  if (handle.includes('n')) y0 = p.y;
  if (handle.includes('s')) y1 = p.y;
  if (square && handle.length === 2) {
    // Corner drag: the opposite corner is the anchor.
    const ax = handle.includes('w') ? x1 : x0;
    const ay = handle.includes('n') ? y1 : y0;
    const q = squareFrom({ x: ax, y: ay }, p);
    return rectFromPoints({ x: ax, y: ay }, q);
  }
  return rectFromPoints({ x: x0, y: y0 }, { x: x1, y: y1 });
}

/**
 * Shape after dragging its handle to `p`. `shift` constrains: 45° for arrows, free angle for
 * underlines/highlights (otherwise locked horizontal), square for rects.
 */
export function dragHandle(s: Shape, handle: HandleId, p: Point, shift: boolean): Shape {
  switch (s.kind) {
    case 'arrow': {
      const other = handle === 'a' ? s.b : s.a;
      const q = shift ? snapAngle(other, p) : p;
      return handle === 'a' ? { ...s, a: q } : { ...s, b: q };
    }
    case 'underline':
    case 'highlight': {
      const other = handle === 'a' ? s.b : s.a;
      const horizontal = s.a.y === s.b.y;
      const q = horizontal && !shift ? { x: p.x, y: other.y } : p;
      const r = s.kind === 'underline' ? { x: Math.round(q.x), y: Math.round(q.y) } : q;
      return handle === 'a' ? { ...s, a: r } : { ...s, b: r };
    }
    case 'rect':
      if (handle === 'a' || handle === 'b') return s;
      return { ...s, box: resizeBox(s.box, handle, p, shift) };
    default:
      return s;
  }
}

export function translateShape(s: Shape, dx: number, dy: number): Shape {
  if (dx === 0 && dy === 0) return s;
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (s.kind) {
    case 'arrow':
    case 'underline':
    case 'highlight':
      return { ...s, a: mv(s.a), b: mv(s.b) };
    case 'rect':
      return { ...s, box: { ...s.box, x: s.box.x + dx, y: s.box.y + dy } };
    case 'pen':
      return { ...s, pts: s.pts.map(([x, y, pr]) => [x + dx, y + dy, pr] as const) };
    case 'text':
      return { ...s, at: mv(s.at) };
  }
}

// ------------------------------------------------------------------------------- camera

export interface CameraLike {
  x: number;
  y: number;
  zoom: number;
}

/** Fit-width gutter on each side, CSS px. */
export const FIT_GUTTER_CSS = 24;
/** Zoom limits as a percentage of the page's natural size (100% = 1/dpr). */
export const MIN_ZOOM_PCT = 5;
export const MAX_ZOOM_PCT = 800;

export function zoomLimits(dpr: number): { min: number; max: number } {
  return { min: MIN_ZOOM_PCT / 100 / dpr, max: MAX_ZOOM_PCT / 100 / dpr };
}

/** Fit-width zoom: never above 100% (`1/dpr`). */
export function fitWidthZoom(image: Size, viewport: Size, dpr: number): number {
  const avail = Math.max(1, viewport.w - 2 * FIT_GUTTER_CSS);
  const z = Math.min(1 / dpr, avail / Math.max(1, image.w));
  const { min } = zoomLimits(dpr);
  return Math.max(min, z);
}

/** Top padding above the page and below it when scrolled to the end, CSS px. */
export const SCROLL_PAD_CSS = 24;

/**
 * Keep the page reachable: centred horizontally when it fits, otherwise clamped with a small
 * gutter; vertically from a little above the top to a little past the bottom.
 */
export function clampCamera(cam: CameraLike, image: Size, viewport: Size): CameraLike {
  const visW = viewport.w / cam.zoom;
  const visH = viewport.h / cam.zoom;
  const pad = SCROLL_PAD_CSS / cam.zoom;
  const gutter = FIT_GUTTER_CSS / cam.zoom;
  let x: number;
  if (image.w + 2 * gutter <= visW) x = (image.w - visW) / 2;
  else x = clamp(cam.x, -gutter, image.w + gutter - visW);
  let y: number;
  if (image.h + 2 * pad <= visH) y = (image.h - visH) / 2;
  else y = clamp(cam.y, -pad, image.h + pad - visH);
  return { x, y, zoom: cam.zoom };
}

/** Fit-width camera scrolled to the top. */
export function fitWidthCamera(image: Size, viewport: Size, dpr: number): CameraLike {
  const zoom = fitWidthZoom(image, viewport, dpr);
  return clampCamera({ x: 0, y: -SCROLL_PAD_CSS / zoom, zoom }, image, viewport);
}

/** New camera after zooming to `zoom`, keeping the screen point `anchor` (CSS px) fixed. */
export function zoomAround(cam: CameraLike, zoom: number, anchor: Point): CameraLike {
  const ix = cam.x + anchor.x / cam.zoom;
  const iy = cam.y + anchor.y / cam.zoom;
  return { x: ix - anchor.x / zoom, y: iy - anchor.y / zoom, zoom };
}

export function screenToImage(cam: CameraLike, p: Point): Point {
  return { x: cam.x + p.x / cam.zoom, y: cam.y + p.y / cam.zoom };
}

export function imageToScreen(cam: CameraLike, p: Point): Point {
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}

/** Image-px rect visible in a viewport (CSS px). */
export function visibleRect(cam: CameraLike, viewport: Size): Rect {
  return { x: cam.x, y: cam.y, w: viewport.w / cam.zoom, h: viewport.h / cam.zoom };
}
