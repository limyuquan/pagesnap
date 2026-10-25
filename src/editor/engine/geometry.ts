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

// ------------------------------------------------------------------------------- rotation

/** Rotate `p` about `c` by `ang` radians (clockwise on screen, where y points down). */
export function rotatePoint(p: Point, c: Point, ang: number): Point {
  if (!ang) return { x: p.x, y: p.y };
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** The angle normalised to (-π, π]. */
export function normalizeAngle(a: number): number {
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  if (r > Math.PI) r -= TAU;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Corners clockwise from the top-left. */
export function rectCorners(r: Rect): [Point, Point, Point, Point] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** Shapes with a `rotation` field (radians about the centre of their frame). */
export type RotatableShape = RectShape | TextShape | PenShape;

export function isRotatable(s: Shape): s is RotatableShape {
  return s.kind === 'rect' || s.kind === 'text' || s.kind === 'pen';
}

export function shapeRotation(s: Shape): number {
  return isRotatable(s) ? (s.rotation ?? 0) : 0;
}

/** `s` with `rotation` set (the field is dropped at 0, so unrotated shapes stay as before). */
export function withRotation<T extends RotatableShape>(s: T, rotation: number): T {
  const r = normalizeAngle(rotation);
  const { rotation: _old, ...rest } = s;
  return (r ? { ...rest, rotation: r } : rest) as T;
}

// ------------------------------------------------------------------------------- arrow

/** Half-angle of the arrowhead triangle (design review §3: 28°). */
export const ARROW_HEAD_HALF_ANGLE = (28 * Math.PI) / 180;
/** Arrowhead length in stroke widths, and its minimum in CSS px (design review §3). */
export const ARROW_HEAD_WIDTHS = 4.5;
export const ARROW_HEAD_MIN_CSS = 18;

/**
 * Arrowhead length for a stroke `width` (image px) on an image captured at `dpr`: 4.5 stroke
 * widths, at least 18 CSS px, and never more than 60% of the arrow so short arrows stay arrows.
 */
export function arrowHeadLength(width: number, length: number, dpr: number): number {
  return Math.min(Math.max(ARROW_HEAD_WIDTHS * width, ARROW_HEAD_MIN_CSS * dpr), length * 0.6);
}

type ArrowLike = Pick<ArrowShape, 'a' | 'b' | 'width'> & { bend?: number };

/**
 * Control point of a bent arrow's quadratic curve: the chord midpoint moved `bend` image px along
 * the chord's normal `(-uy, ux)` (to the right of a→b on screen). Straight arrows: the midpoint.
 */
export function arrowControl(s: Pick<ArrowShape, 'a' | 'b'> & { bend?: number }): Point {
  const mx = (s.a.x + s.b.x) / 2;
  const my = (s.a.y + s.b.y) / 2;
  const len = dist(s.a, s.b);
  const bend = s.bend ?? 0;
  if (!bend || !len) return { x: mx, y: my };
  return {
    x: mx - ((s.b.y - s.a.y) / len) * bend,
    y: my + ((s.b.x - s.a.x) / len) * bend,
  };
}

/** Point of a quadratic Bézier at `t`. */
export function quadPoint(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/** The curve's own midpoint (t = 0.5): where the bend handle sits. */
export function arrowMidpoint(s: Pick<ArrowShape, 'a' | 'b'> & { bend?: number }): Point {
  return quadPoint(s.a, arrowControl(s), s.b, 0.5);
}

/** Curve parameter where the curve is `d` (straight-line distance) away from its end. */
function tAtDistFromEnd(p0: Point, c: Point, p1: Point, d: number): number {
  if (d <= 0) return 1;
  if (dist(p0, p1) <= d) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (dist(quadPoint(p0, c, p1, mid), p1) > d) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ArrowGeometry {
  /** Shaft end (shortened so the round cap doesn't poke through the tip). */
  shaftEnd: Point;
  /** Head triangle: tip, left, right. */
  head: readonly [Point, Point, Point];
  headLen: number;
  /** Curve parameter of `shaftEnd` (1 = the tip). */
  tEnd: number;
}

/**
 * Head and shaft end at `b`. A bent arrow's head points along the curve's tangent at `b`
 * (`b - control`), so it follows the bend.
 */
export function arrowGeometry(s: ArrowLike, dpr: number): ArrowGeometry {
  const len = dist(s.a, s.b);
  const headLen = arrowHeadLength(s.width, len, dpr);
  const c = arrowControl(s);
  const curved = !!s.bend && len > 0;
  let ux = len ? (s.b.x - s.a.x) / len : 1;
  let uy = len ? (s.b.y - s.a.y) / len : 0;
  if (curved) {
    const tl = Math.hypot(s.b.x - c.x, s.b.y - c.y);
    if (tl > 0) {
      ux = (s.b.x - c.x) / tl;
      uy = (s.b.y - c.y) / tl;
    }
  }
  const back = { x: s.b.x - ux * headLen, y: s.b.y - uy * headLen };
  const half = Math.tan(ARROW_HEAD_HALF_ANGLE) * headLen;
  const left = { x: back.x - uy * half, y: back.y + ux * half };
  const right = { x: back.x + uy * half, y: back.y - ux * half };
  let shaftEnd: Point;
  let tEnd: number;
  if (curved) {
    tEnd = tAtDistFromEnd(s.a, c, s.b, headLen * 0.8);
    shaftEnd = quadPoint(s.a, c, s.b, tEnd);
  } else {
    const shaft = Math.max(0, len - headLen * 0.8);
    shaftEnd = { x: s.a.x + ux * shaft, y: s.a.y + uy * shaft };
    tEnd = len ? shaft / len : 0;
  }
  return { shaftEnd, head: [{ ...s.b }, left, right], headLen, tEnd };
}

/** The same arrow drawn from `b` to `a` (its curve unchanged). */
function reversed(s: ArrowLike): ArrowLike {
  return { a: s.b, b: s.a, width: s.width, bend: -(s.bend ?? 0) };
}

/** Head triangles of an arrow: one at `b`, plus one at `a` for `heads: 'both'`. */
export function arrowHeads(
  s: ArrowLike & Pick<ArrowShape, 'heads'>,
  dpr: number,
): (readonly [Point, Point, Point])[] {
  const heads = [arrowGeometry(s, dpr).head];
  if (s.heads === 'both') heads.push(arrowGeometry(reversed(s), dpr).head);
  return heads;
}

/** Visible shaft: a quadratic from `from` to `to` with control `ctrl` (straight: the midpoint). */
export interface ArrowShaft {
  from: Point;
  ctrl: Point;
  to: Point;
  curved: boolean;
}

/** Quadratic blossom f(u, v): the control point of the sub-curve on [u, v] is f(u, v). */
function blossom(p0: Point, c: Point, p1: Point, u: number, v: number): Point {
  const w0 = (1 - u) * (1 - v);
  const w1 = (1 - u) * v + u * (1 - v);
  const w2 = u * v;
  return { x: w0 * p0.x + w1 * c.x + w2 * p1.x, y: w0 * p0.y + w1 * c.y + w2 * p1.y };
}

export function arrowShaft(s: ArrowLike & Pick<ArrowShape, 'heads'>, dpr: number): ArrowShaft {
  const g = arrowGeometry(s, dpr);
  const t0 = s.heads === 'both' ? 1 - arrowGeometry(reversed(s), dpr).tEnd : 0;
  const t1 = Math.max(t0, g.tEnd);
  const c = arrowControl(s);
  const curved = !!s.bend && dist(s.a, s.b) > 0;
  if (!curved) {
    const from = s.heads === 'both' ? arrowGeometry(reversed(s), dpr).shaftEnd : s.a;
    const to = g.shaftEnd;
    return { from, to, ctrl: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, curved };
  }
  return {
    from: blossom(s.a, c, s.b, t0, t0),
    ctrl: blossom(s.a, c, s.b, t0, t1),
    to: blossom(s.a, c, s.b, t1, t1),
    curved,
  };
}

const ARROW_SAMPLES = 32;
const arrowSampleCache = new WeakMap<object, Point[]>();

/** The arrow's centre line from `a` to `b` as a polyline (2 points when straight). */
export function arrowPolyline(s: Pick<ArrowShape, 'a' | 'b' | 'bend'>): Point[] {
  if (!s.bend) return [s.a, s.b];
  const hit = arrowSampleCache.get(s);
  if (hit) return hit;
  const c = arrowControl(s);
  const out: Point[] = [];
  for (let i = 0; i <= ARROW_SAMPLES; i++) out.push(quadPoint(s.a, c, s.b, i / ARROW_SAMPLES));
  arrowSampleCache.set(s, out);
  return out;
}

/** Points that bound a quadratic: its ends and its per-axis extrema. */
function quadExtremes(p0: Point, c: Point, p1: Point): Point[] {
  const out = [p0, p1];
  const dx = p0.x - 2 * c.x + p1.x;
  const dy = p0.y - 2 * c.y + p1.y;
  if (dx !== 0) {
    const t = (p0.x - c.x) / dx;
    if (t > 0 && t < 1) out.push(quadPoint(p0, c, p1, t));
  }
  if (dy !== 0) {
    const t = (p0.y - c.y) / dy;
    if (t > 0 && t < 1) out.push(quadPoint(p0, c, p1, t));
  }
  return out;
}

// ------------------------------------------------------------------------------- text

/** Line height as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25;

/** White outline width for `outline` text, as a fraction of the font size (3 px at 26 px). */
export const TEXT_OUTLINE_RATIO = 3 / 26;

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
  /** Display lines, after wrapping to `maxW`. */
  lines: readonly string[];
  lineHeight: number;
  /** Ink box of the text (without the outline), image px. With `maxW` it is `maxW` wide. */
  box: Rect;
}

/** Narrowest wrap width, in font sizes. */
export const TEXT_MIN_WRAP_EM = 1;

/** Greedy word wrap of one paragraph; words wider than `maxW` break between characters. */
function wrapParagraph(line: string, maxW: number, width: (t: string) => number): string[] {
  if (width(line) <= maxW) return [line];
  const out: string[] = [];
  let cur = '';
  for (const tok of line.match(/\S+\s*|\s+/g) ?? [line]) {
    if (cur && width((cur + tok).trimEnd()) > maxW) {
      out.push(cur.trimEnd());
      cur = '';
    }
    if (!cur && width(tok.trimEnd()) > maxW) {
      let piece = '';
      for (const ch of tok) {
        if (piece && width((piece + ch).trimEnd()) > maxW) {
          out.push(piece);
          piece = '';
        }
        piece += ch;
      }
      cur = piece;
    } else {
      cur += tok;
    }
  }
  out.push(cur.trimEnd());
  return out;
}

const textLayoutCache = new WeakMap<TextShape, TextLayout>();

export function textLayout(s: TextShape): TextLayout {
  const hit = textLayoutCache.get(s);
  if (hit) return hit;
  const lineHeight = s.size * TEXT_LINE_HEIGHT;
  const m = getMeasurer();
  const font = textFont(s);
  const width = (t: string) => m(t, font, s.size);
  const wrap = s.maxW !== undefined ? Math.max(s.maxW, s.size * TEXT_MIN_WRAP_EM) : null;
  const lines: string[] = [];
  for (const para of s.text.split('\n')) {
    if (wrap === null) lines.push(para);
    else lines.push(...wrapParagraph(para, wrap, width));
  }
  let w = 0;
  if (wrap === null) for (const line of lines) w = Math.max(w, width(line));
  else w = wrap;
  const out: TextLayout = {
    lines,
    lineHeight,
    box: { x: s.at.x, y: s.at.y, w: Math.max(w, s.size * 0.3), h: lines.length * lineHeight },
  };
  textLayoutCache.set(s, out);
  return out;
}

/**
 * Padding of a text's frame around its ink box (proportional to the font size, so corner-scaling
 * keeps it): clear of the outline, or of the label box.
 */
function textPad(s: TextShape): { x: number; y: number } {
  return s.style === 'label'
    ? { x: s.size * 0.35, y: s.size * 0.2 }
    : { x: s.size * 0.25, y: s.size * 0.1 };
}

// ------------------------------------------------------------------------------- frames

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

const penBoundsCache = new WeakMap<PenShape, Rect>();

/** Bounds of a pen stroke's raw points (unrotated, no stroke size). */
export function penPointsBounds(s: PenShape): Rect {
  const hit = penBoundsCache.get(s);
  if (hit) return hit;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of s.pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const r = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { ...EMPTY_RECT };
  penBoundsCache.set(s, r);
  return r;
}

/**
 * Unrotated frame of a rect, text or pen, image px: the outer edge of what you see, where its
 * selection outline and handles sit, and whose centre it rotates about. Rect: the box plus half
 * the stroke. Text: the ink box plus padding. Pen: the points' bounds plus half the stroke size.
 */
export function shapeFrame(s: RotatableShape): Rect {
  switch (s.kind) {
    case 'rect':
      return inflate(s.box, s.width / 2);
    case 'text': {
      const p = textPad(s);
      const b = textLayout(s).box;
      return { x: b.x - p.x, y: b.y - p.y, w: b.w + 2 * p.x, h: b.h + 2 * p.y };
    }
    case 'pen':
      return inflate(penPointsBounds(s), s.size / 2);
  }
}

/** Rotation centre of a rect, text or pen. */
export function shapeCenter(s: RotatableShape): Point {
  return rectCenter(shapeFrame(s));
}

/** `p` in the shape's unrotated frame. */
export function toLocal(s: Shape, p: Point): Point {
  const r = shapeRotation(s);
  return r && isRotatable(s) ? rotatePoint(p, shapeCenter(s), -r) : p;
}

/** Corners of a rect rotated by `ang` about `c`, clockwise from the (local) top-left. */
export function rotatedCorners(r: Rect, c: Point, ang: number): Point[] {
  return rectCorners(r).map((p) => rotatePoint(p, c, ang));
}

// ------------------------------------------------------------------------------- bounds

const boundsCache = new WeakMap<Shape, { dpr: number; r: Rect }>();

/**
 * Visual extent of a shape in image px, including stroke width, arrowheads, the text outline,
 * rotation and the bend (not the soft shadow). Used for culling, hit-test prefiltering, the group
 * selection box and the smart copy region.
 */
export function shapeBounds(s: Shape, dpr: number): Rect {
  const hit = boundsCache.get(s);
  if (hit && hit.dpr === dpr) return hit.r;
  let r: Rect;
  switch (s.kind) {
    case 'arrow': {
      const corners = arrowHeads(s, dpr).flatMap((h) => [h[1], h[2]]);
      const line = s.bend ? quadExtremes(s.a, arrowControl(s), s.b) : [s.a, s.b];
      r = inflate(pointsBounds([...line, ...corners]), s.width / 2 + 1);
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
      // Butt caps: the band's four corners.
      const len = dist(s.a, s.b);
      if (len === 0) {
        r = inflate(pointsBounds([s.a]), s.thickness / 2);
        break;
      }
      const nx = (-(s.b.y - s.a.y) / len) * (s.thickness / 2);
      const ny = ((s.b.x - s.a.x) / len) * (s.thickness / 2);
      r = pointsBounds([
        { x: s.a.x + nx, y: s.a.y + ny },
        { x: s.a.x - nx, y: s.a.y - ny },
        { x: s.b.x + nx, y: s.b.y + ny },
        { x: s.b.x - nx, y: s.b.y - ny },
      ]);
      break;
    }
    case 'rect': {
      const rot = s.rotation ?? 0;
      const outer = inflate(s.box, s.width / 2);
      r = rot ? pointsBounds(rotatedCorners(outer, rectCenter(s.box), rot)) : outer;
      break;
    }
    case 'pen': {
      const rot = s.rotation ?? 0;
      const c = rectCenter(penPointsBounds(s));
      const pts = s.pts.map(([x, y]) => rotatePoint({ x, y }, c, rot));
      r = inflate(pointsBounds(pts), s.size / 2 + 1);
      break;
    }
    case 'text': {
      const box = textLayout(s).box;
      const ink =
        s.style === 'outline'
          ? inflate(box, s.size * TEXT_OUTLINE_RATIO * 0.5)
          : inflate(box, s.size * 0.25);
      const rot = s.rotation ?? 0;
      r = rot ? pointsBounds(rotatedCorners(ink, rectCenter(box), rot)) : ink;
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
export const HIT_TOLERANCE_CSS = 7;

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

function distToPoints(p: Point, pts: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(p, pts[i - 1] as Point, pts[i] as Point);
    if (d < best) best = d;
  }
  return pts.length === 1 ? dist(p, pts[0] as Point) : best;
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

/**
 * Does `p` (image px) hit shape `s`? `tol` is in image px. Hollow rects hit on their border only
 * (so you can draw inside a box); filled rects, text, highlight bands and pen strokes on their ink.
 * Rotated shapes are tested in their own frame; bent arrows along the curve.
 */
export function hitShape(s: Shape, p: Point, tol: number, dpr: number): boolean {
  switch (s.kind) {
    case 'arrow': {
      if (distToPoints(p, arrowPolyline(s)) <= s.width / 2 + tol) return true;
      return arrowHeads(s, dpr).some((h) => pointInTriangle(p, h));
    }
    case 'underline':
      return distToSegment(p, s.a, s.b) <= s.width / 2 + tol;
    case 'highlight': {
      // The band has butt caps: a rectangle along a→b, grown by the tolerance.
      const len = dist(s.a, s.b);
      if (len === 0) return dist(p, s.a) <= s.thickness / 2 + tol;
      const ux = (s.b.x - s.a.x) / len;
      const uy = (s.b.y - s.a.y) / len;
      const dx = p.x - s.a.x;
      const dy = p.y - s.a.y;
      const along = dx * ux + dy * uy;
      const across = Math.abs(dy * ux - dx * uy);
      return along >= -tol && along <= len + tol && across <= s.thickness / 2 + tol;
    }
    case 'rect': {
      const q = toLocal(s, p);
      if (s.fill !== 'none' && pointInRect(q, s.box)) return true;
      return rectBorderDistance(q, s.box) <= s.width / 2 + tol;
    }
    case 'pen':
      return distToPolyline(toLocal(s, p), s.pts) <= s.size / 2 + tol;
    case 'text':
      return pointInRect(toLocal(s, p), inflate(textLayout(s).box, tol));
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

/**
 * Topmost shape at `p`, or `null`. Each shape's cached bounds (inflated by `tol`) are checked
 * first, so hovering over 200 marks stays far below a millisecond.
 */
export function hitTestShapes(
  shapes: readonly Shape[],
  p: Point,
  tol: number,
  dpr: number,
): Shape | null {
  // Rotated boxes grown by `tol` reach up to tol·√2 past their axis-aligned bounds.
  const pad = tol * 1.5;
  for (let pass = 0; pass < 2; pass++) {
    // Pass 0: shapes above the underlay, topmost first; pass 1: the underlay.
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i] as Shape;
      if (isUnderlay(s) !== (pass === 1)) continue;
      const b = shapeBounds(s, dpr);
      if (p.x < b.x - pad || p.y < b.y - pad || p.x > b.x + b.w + pad || p.y > b.y + b.h + pad) {
        continue;
      }
      if (hitShape(s, p, tol, dpr)) return s;
    }
  }
  return null;
}

/** Shapes whose bounds intersect `r`. */
export function shapesInRect(shapes: readonly Shape[], r: Rect, dpr: number): ShapeId[] {
  return shapes.filter((s) => rectsIntersect(shapeBounds(s, dpr), r)).map((s) => s.id);
}

/**
 * The outline traced on hover, image px: polylines along the mark's geometry (a rect's box, a
 * text's frame, a band's edges, a stroke's centre line). `closed` paths join their ends.
 */
export function shapeOutline(s: Shape): { pts: Point[]; closed: boolean } {
  switch (s.kind) {
    case 'arrow':
      return { pts: arrowPolyline(s), closed: false };
    case 'underline':
      return { pts: [s.a, s.b], closed: false };
    case 'highlight': {
      const len = dist(s.a, s.b) || 1;
      const nx = (-(s.b.y - s.a.y) / len) * (s.thickness / 2);
      const ny = ((s.b.x - s.a.x) / len) * (s.thickness / 2);
      return {
        pts: [
          { x: s.a.x + nx, y: s.a.y + ny },
          { x: s.b.x + nx, y: s.b.y + ny },
          { x: s.b.x - nx, y: s.b.y - ny },
          { x: s.a.x - nx, y: s.a.y - ny },
        ],
        closed: true,
      };
    }
    case 'pen': {
      const rot = s.rotation ?? 0;
      const c = rectCenter(penPointsBounds(s));
      return { pts: s.pts.map(([x, y]) => rotatePoint({ x, y }, c, rot)), closed: false };
    }
    case 'rect':
    case 'text': {
      const f = shapeFrame(s);
      return { pts: rotatedCorners(f, rectCenter(f), s.rotation ?? 0), closed: true };
    }
  }
}

// ------------------------------------------------------------------------------- handles

export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** `a`/`b`: line endpoints; `mid`: an arrow's bend; `rot`: rotation. */
export type HandleId = BoxHandle | 'a' | 'b' | 'mid' | 'rot';

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
}

/** Rotation handle distance above the frame's top edge, CSS px of the screen. */
export const ROTATE_HANDLE_CSS = 22;

export const BOX_HANDLES: readonly BoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNERS: readonly BoxHandle[] = ['nw', 'ne', 'se', 'sw'];

const OPPOSITE: Readonly<Record<BoxHandle, BoxHandle>> = {
  nw: 'se',
  n: 's',
  ne: 'sw',
  e: 'w',
  se: 'nw',
  s: 'n',
  sw: 'ne',
  w: 'e',
};

/** Outward direction of a box handle in its frame, radians (0 = east, y down). */
export const BOX_HANDLE_ANGLE: Readonly<Record<BoxHandle, number>> = {
  e: 0,
  se: Math.PI / 4,
  s: Math.PI / 2,
  sw: (3 * Math.PI) / 4,
  w: Math.PI,
  nw: (-3 * Math.PI) / 4,
  n: -Math.PI / 2,
  ne: -Math.PI / 4,
};

export function isBoxHandle(h: HandleId): h is BoxHandle {
  return h in OPPOSITE;
}

export function isCorner(h: HandleId): boolean {
  return h === 'nw' || h === 'ne' || h === 'se' || h === 'sw';
}

/** Where handle `h` sits on (unrotated) rect `r`. */
export function boxPoint(r: Rect, h: BoxHandle): Point {
  return {
    x: h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2,
    y: h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2,
  };
}

/** Box handles each kind offers: rect all 8, text corners (scale) + sides (wrap), pen corners. */
function boxHandlesOf(s: RotatableShape): readonly BoxHandle[] {
  switch (s.kind) {
    case 'rect':
      return BOX_HANDLES;
    case 'text':
      return ['nw', 'ne', 'se', 'sw', 'e', 'w'];
    case 'pen':
      return CORNERS;
  }
}

/** The rotation handle: above the frame's top-centre (outside a rect's stroke), rotated. */
export function rotateHandlePoint(s: RotatableShape, zoom = 1): { at: Point; base: Point } {
  const f = shapeFrame(s);
  const c = rectCenter(f);
  const rot = s.rotation ?? 0;
  const lift = ROTATE_HANDLE_CSS / zoom;
  return {
    at: rotatePoint({ x: c.x, y: f.y - lift }, c, rot),
    base: rotatePoint({ x: c.x, y: f.y }, c, rot),
  };
}

/**
 * Edit handles of a single selected shape (image px). `zoom` (CSS px per image px) places the
 * rotation handle a fixed screen distance above the frame.
 */
export function shapeHandles(s: Shape, zoom = 1): Handle[] {
  switch (s.kind) {
    case 'arrow': {
      const m = arrowMidpoint(s);
      return [
        { id: 'a', x: s.a.x, y: s.a.y },
        { id: 'b', x: s.b.x, y: s.b.y },
        { id: 'mid', x: m.x, y: m.y },
      ];
    }
    case 'underline':
    case 'highlight':
      return [
        { id: 'a', x: s.a.x, y: s.a.y },
        { id: 'b', x: s.b.x, y: s.b.y },
      ];
    default: {
      const f = shapeFrame(s);
      const c = rectCenter(f);
      const rot = s.rotation ?? 0;
      const out: Handle[] = boxHandlesOf(s).map((id) => {
        const p = rotatePoint(boxPoint(f, id), c, rot);
        return { id, x: p.x, y: p.y };
      });
      const r = rotateHandlePoint(s, zoom).at;
      out.push({ id: 'rot', x: r.x, y: r.y });
      return out;
    }
  }
}

/** Below this on-screen chord length (CSS px) an arrow shows no bend handle. */
export const MID_HANDLE_MIN_CSS = 48;
/** Below this on-screen side length (CSS px) a frame shows no side handles. */
export const SIDE_HANDLE_MIN_CSS = 28;

/**
 * The handles shown (and grabbed) at this zoom: `shapeHandles` minus the ones that would crowd a
 * small mark: an arrow's bend handle when it's short on screen, side handles on short sides.
 */
export function interactiveHandles(s: Shape, zoom = 1): Handle[] {
  const all = shapeHandles(s, zoom);
  if (s.kind === 'arrow') {
    return dist(s.a, s.b) * zoom < MID_HANDLE_MIN_CSS ? all.filter((h) => h.id !== 'mid') : all;
  }
  if (!isRotatable(s)) return all;
  const f = shapeFrame(s);
  const shortW = f.w * zoom < SIDE_HANDLE_MIN_CSS;
  const shortH = f.h * zoom < SIDE_HANDLE_MIN_CSS;
  return all.filter((h) => {
    if (h.id === 'n' || h.id === 's') return !shortW;
    if ((h.id === 'e' || h.id === 'w') && s.kind === 'rect') return !shortH;
    return true;
  });
}

/** Handle within `tol` image px of `p`, nearest first (of the handles shown at `zoom`). */
export function hitHandle(s: Shape, p: Point, tol: number, zoom = 1): HandleId | null {
  return nearestHandle(interactiveHandles(s, zoom), p, tol);
}

function nearestHandle(hs: readonly Handle[], p: Point, tol: number): HandleId | null {
  let best: HandleId | null = null;
  let bestD = tol;
  for (const h of hs) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d <= bestD) {
      best = h.id;
      bestD = d;
    }
  }
  return best;
}

/** Corner handles of a multi-selection's group box. */
export function groupHandles(r: Rect): Handle[] {
  return CORNERS.map((id) => ({ id, ...boxPoint(r, id) }));
}

export function hitGroupHandle(r: Rect, p: Point, tol: number): BoxHandle | null {
  return nearestHandle(groupHandles(r), p, tol) as BoxHandle | null;
}

/** World-space direction of a handle (for its cursor), radians. */
export function handleAngle(s: Shape | null, h: HandleId): number {
  const rot = s ? shapeRotation(s) : 0;
  return isBoxHandle(h) ? normalizeAngle(BOX_HANDLE_ANGLE[h] + rot) : rot;
}

// ------------------------------------------------------------------------------- transforms

export interface ResizeOpts {
  /** Keep the aspect ratio (Shift). */
  aspect?: boolean;
  /** Resize about the centre (Alt). */
  center?: boolean;
}

/** Box after dragging `handle` to `p` (all in the box's own frame). */
export function resizeBox(box: Rect, handle: BoxHandle, p: Point, o: ResizeOpts = {}): Rect {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const horiz = handle.includes('w') || handle.includes('e');
  const vert = handle.includes('n') || handle.includes('s');
  let x0 = box.x;
  let x1 = box.x + box.w;
  let y0 = box.y;
  let y1 = box.y + box.h;
  if (horiz) {
    x0 = o.center ? 2 * cx - p.x : handle.includes('w') ? box.x + box.w : box.x;
    x1 = p.x;
  }
  if (vert) {
    y0 = o.center ? 2 * cy - p.y : handle.includes('n') ? box.y + box.h : box.y;
    y1 = p.y;
  }
  if (o.aspect && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    if (horiz && vert) {
      let w = Math.abs(x1 - x0);
      let h = Math.abs(y1 - y0);
      if (w / ratio >= h) h = w / ratio;
      else w = h * ratio;
      const sx = Math.sign(x1 - x0) || 1;
      const sy = Math.sign(y1 - y0) || 1;
      if (o.center) {
        x0 = cx - (sx * w) / 2;
        x1 = cx + (sx * w) / 2;
        y0 = cy - (sy * h) / 2;
        y1 = cy + (sy * h) / 2;
      } else {
        x1 = x0 + sx * w;
        y1 = y0 + sy * h;
      }
    } else if (horiz) {
      const h = Math.abs(x1 - x0) / ratio;
      y0 = cy - h / 2;
      y1 = cy + h / 2;
    } else if (vert) {
      const w = Math.abs(y1 - y0) * ratio;
      x0 = cx - w / 2;
      x1 = cx + w / 2;
    }
  }
  return rectFromPoints({ x: x0, y: y0 }, { x: x1, y: y1 });
}

export interface DragOpts {
  shift?: boolean;
  alt?: boolean;
  /** CSS px per image px (snapping thresholds, the rotation handle's offset). */
  zoom?: number;
  /** Pointer position at the press (rotation is relative to it). */
  start?: Point;
}

/** Shift snaps angles to this step (endpoints and rotation). */
export const SNAP_STEP_DEG = 15;
/** Without Shift, angles within this of horizontal/vertical (or 0°/90° rotation) snap to it. */
export const SOFT_SNAP_DEG = 2;
/** A bend handle this close (CSS px) to the chord straightens the arrow. */
export const BEND_SNAP_CSS = 6;
/** Text corner-scaling limits, image px. */
export const TEXT_MIN_SIZE = 6;
export const TEXT_MAX_SIZE = 1200;

const DEG = Math.PI / 180;

/** Drag a line endpoint to `p`, `other` fixed: Shift snaps to 15°, else soft-snaps to the axes. */
function dragEndpoint(other: Point, p: Point, shift: boolean): Point {
  if (shift) return snapAngle(other, p, SNAP_STEP_DEG);
  if (dist(other, p) === 0) return { ...p };
  const ang = Math.atan2(p.y - other.y, p.x - other.x);
  const axis = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(ang - axis) < SOFT_SNAP_DEG * DEG ? snapAngle(other, p, 90) : { ...p };
}

/** Rotation after a rotate-handle drag. */
function dragRotation(s: RotatableShape, p: Point, o: DragOpts): number {
  const c = shapeCenter(s);
  const base = s.rotation ?? 0;
  const ang = (q: Point) => Math.atan2(q.y - c.y, q.x - c.x);
  let r = o.start ? base + ang(p) - ang(o.start) : ang(p) + Math.PI / 2;
  if (o.shift) {
    r = Math.round(r / (SNAP_STEP_DEG * DEG)) * SNAP_STEP_DEG * DEG;
  } else {
    const q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(r - q) < SOFT_SNAP_DEG * DEG) r = q;
  }
  return normalizeAngle(r);
}

/**
 * `next` (built in the old shape's local frame) moved so that the point `localCenter` of that
 * frame lands where the old rotation (`rot` about `c`) puts it. Keeps an anchor corner of a
 * rotated shape still while its size, and so its rotation centre, changes.
 */
function placeLocal<T extends RotatableShape>(
  next: T,
  localCenter: Point,
  c: Point,
  rot: number,
): T {
  const want = rotatePoint(localCenter, c, rot);
  const have = shapeCenter(next);
  return translateShape(next, want.x - have.x, want.y - have.y) as T;
}

/** Scale factor from projecting `q` onto the anchor→corner diagonal (1 = unchanged). */
function projectScale(anchor: Point, corner: Point, q: Point): number {
  const dx = corner.x - anchor.x;
  const dy = corner.y - anchor.y;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) return 1;
  return ((q.x - anchor.x) * dx + (q.y - anchor.y) * dy) / d2;
}

/** Rect: the handles sit on the stroke's outer edge, which follows the pointer. */
function resizeRect(s: RectShape, h: BoxHandle, p: Point, o: DragOpts): RectShape {
  const rot = s.rotation ?? 0;
  const c = rectCenter(s.box);
  const half = s.width / 2;
  const outer = resizeBox(inflate(s.box, half), h, rotatePoint(p, c, -rot), {
    aspect: !!o.shift,
    center: !!o.alt,
  });
  const box = {
    x: outer.x + Math.min(half, outer.w / 2),
    y: outer.y + Math.min(half, outer.h / 2),
    w: Math.max(0, outer.w - 2 * half),
    h: Math.max(0, outer.h - 2 * half),
  };
  if (!rot) return { ...s, box };
  return placeLocal({ ...s, box }, rectCenter(box), c, rot);
}

/** Text: corners scale the font (and wrap width) about the opposite corner; sides set `maxW`. */
function resizeText(s: TextShape, h: BoxHandle, p: Point, o: DragOpts): TextShape {
  const rot = s.rotation ?? 0;
  const f = shapeFrame(s);
  const c = rectCenter(f);
  const q = rotatePoint(p, c, -rot);
  if (isCorner(h)) {
    const anchor = o.alt ? c : boxPoint(f, OPPOSITE[h]);
    const k = clamp(
      projectScale(anchor, boxPoint(f, h), q),
      TEXT_MIN_SIZE / s.size,
      TEXT_MAX_SIZE / s.size,
    );
    const next: TextShape = {
      ...s,
      size: s.size * k,
      ...(s.maxW !== undefined ? { maxW: s.maxW * k } : {}),
    };
    const nf = shapeFrame(next);
    const x0 = o.alt ? c.x - nf.w / 2 : h.includes('w') ? anchor.x - nf.w : anchor.x;
    const y0 = o.alt ? c.y - nf.h / 2 : h.includes('n') ? anchor.y - nf.h : anchor.y;
    return placeLocal(next, { x: x0 + nf.w / 2, y: y0 + nf.h / 2 }, c, rot);
  }
  if (h !== 'e' && h !== 'w') return s;
  const padX = textPad(s).x;
  const frameW = o.alt ? 2 * Math.abs(q.x - c.x) : h === 'e' ? q.x - f.x : f.x + f.w - q.x;
  const next: TextShape = { ...s, maxW: Math.max(s.size * TEXT_MIN_WRAP_EM, frameW - 2 * padX) };
  const nf = shapeFrame(next);
  const x0 = o.alt ? c.x - nf.w / 2 : h === 'e' ? f.x : f.x + f.w - nf.w;
  return placeLocal(next, { x: x0 + nf.w / 2, y: f.y + nf.h / 2 }, c, rot);
}

/** Pen: corners scale the points proportionally about the opposite corner (stroke size kept). */
function resizePen(s: PenShape, h: BoxHandle, p: Point, o: DragOpts): PenShape {
  if (!isCorner(h) || s.pts.length === 0) return s;
  const rot = s.rotation ?? 0;
  const b = penPointsBounds(s);
  const c = rectCenter(b);
  const q = rotatePoint(p, c, -rot);
  const half = s.size / 2;
  // The handle sits half a stroke outside the points' corner.
  const sx = h.includes('w') ? -1 : 1;
  const sy = h.includes('n') ? -1 : 1;
  const target = { x: q.x - sx * half, y: q.y - sy * half };
  const anchor = o.alt ? c : boxPoint(b, OPPOSITE[h]);
  const k = clamp(projectScale(anchor, boxPoint(b, h), target), 0.02, 50);
  const pts = s.pts.map(
    ([x, y, pr]) => [anchor.x + (x - anchor.x) * k, anchor.y + (y - anchor.y) * k, pr] as const,
  );
  const next: PenShape = { ...s, pts };
  const lc = { x: anchor.x + (c.x - anchor.x) * k, y: anchor.y + (c.y - anchor.y) * k };
  return rot ? placeLocal(next, lc, c, rot) : next;
}

/**
 * Shape after dragging its handle to `p` (image px). Modifiers:
 * - endpoints (arrow, underline, highlight): Shift snaps the angle to 15°; otherwise it settles
 *   on horizontal/vertical within 2°. The other end stays put; widths and the bend are kept.
 * - `mid` (arrow): bends the arrow through `p`; near the chord it snaps straight.
 * - rect box handles: resize in the rect's own frame (rotated rects too); Shift keeps the aspect
 *   ratio, Alt resizes about the centre.
 * - text corners scale the font size; text sides set the wrap width; pen corners scale the points.
 * - `rot`: rotate about the frame's centre, relative to `opts.start`; Shift snaps to 15°.
 */
export function dragHandle(s: Shape, handle: HandleId, p: Point, opts: DragOpts = {}): Shape {
  const shift = !!opts.shift;
  switch (s.kind) {
    case 'arrow': {
      if (handle === 'mid') {
        const len = dist(s.a, s.b);
        if (!len) return s;
        const nx = -(s.b.y - s.a.y) / len;
        const ny = (s.b.x - s.a.x) / len;
        const mx = (s.a.x + s.b.x) / 2;
        const my = (s.a.y + s.b.y) / 2;
        // The handle is on the curve, half way to the control point.
        const off = (p.x - mx) * nx + (p.y - my) * ny;
        const zoom = opts.zoom ?? 1;
        const bend = Math.abs(off) * zoom < BEND_SNAP_CSS ? 0 : 2 * off;
        return bend === s.bend ? s : { ...s, bend };
      }
      if (handle !== 'a' && handle !== 'b') return s;
      const q = dragEndpoint(handle === 'a' ? s.b : s.a, p, shift);
      return handle === 'a' ? { ...s, a: q } : { ...s, b: q };
    }
    case 'underline':
    case 'highlight': {
      if (handle !== 'a' && handle !== 'b') return s;
      const q = dragEndpoint(handle === 'a' ? s.b : s.a, p, shift);
      const r = s.kind === 'underline' ? { x: Math.round(q.x), y: Math.round(q.y) } : q;
      return handle === 'a' ? { ...s, a: r } : { ...s, b: r };
    }
    case 'rect':
    case 'text':
    case 'pen': {
      if (handle === 'rot') return withRotation(s, dragRotation(s, p, opts));
      if (!isBoxHandle(handle)) return s;
      if (s.kind === 'rect') return resizeRect(s, handle, p, opts);
      if (s.kind === 'text') return resizeText(s, handle, p, opts);
      return resizePen(s, handle, p, opts);
    }
  }
}

/**
 * Uniform scale by `k` about `anchor` (multi-selection resize). Positions, sizes, wrap widths,
 * font sizes and bends scale; stroke widths and rotation stay.
 */
export function scaleShape(s: Shape, anchor: Point, k: number): Shape {
  const sp = (p: Point): Point => ({
    x: anchor.x + (p.x - anchor.x) * k,
    y: anchor.y + (p.y - anchor.y) * k,
  });
  switch (s.kind) {
    case 'arrow':
      return { ...s, a: sp(s.a), b: sp(s.b), bend: s.bend * k };
    case 'underline': {
      const a = sp(s.a);
      const b = sp(s.b);
      return {
        ...s,
        a: { x: Math.round(a.x), y: Math.round(a.y) },
        b: { x: Math.round(b.x), y: Math.round(b.y) },
      };
    }
    case 'highlight':
      return { ...s, a: sp(s.a), b: sp(s.b) };
    case 'rect': {
      const c = sp(rectCenter(s.box));
      const w = s.box.w * k;
      const h = s.box.h * k;
      return { ...s, box: { x: c.x - w / 2, y: c.y - h / 2, w, h } };
    }
    case 'text': {
      const want = sp(shapeCenter(s));
      const next: TextShape = {
        ...s,
        size: s.size * k,
        ...(s.maxW !== undefined ? { maxW: s.maxW * k } : {}),
      };
      const have = shapeCenter(next);
      return translateShape(next, want.x - have.x, want.y - have.y);
    }
    case 'pen': {
      const c = rectCenter(penPointsBounds(s));
      const nc = sp(c);
      return {
        ...s,
        pts: s.pts.map(([x, y, pr]) => [nc.x + (x - c.x) * k, nc.y + (y - c.y) * k, pr] as const),
      };
    }
  }
}

/**
 * Group resize: the anchor and factor for dragging corner `h` of the group box `r` to `p`
 * (always proportional; Alt scales about the centre).
 */
export function groupScale(
  r: Rect,
  h: BoxHandle,
  p: Point,
  alt: boolean,
  minK = 0.05,
): { anchor: Point; k: number } {
  const anchor = alt ? rectCenter(r) : boxPoint(r, OPPOSITE[h]);
  return { anchor, k: Math.max(minK, projectScale(anchor, boxPoint(r, h), p)) };
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
