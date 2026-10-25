/**
 * `drawDoc`: the one renderer for annotations (owner: B). The on-screen viewport and the export
 * worker both call it, so the copied image looks exactly like the screen (03 §2).
 *
 * Worker-safe: no DOM, no `browser`. Needs a 2D context and `Path2D`.
 *
 * Draw order: base (optional callback) → underlay pass (highlights and marker strokes, multiply)
 * → everything else in array order.
 */
import getStroke from 'perfect-freehand';
import type {
  AnnotationDoc,
  ArrowShape,
  HighlightShape,
  PenShape,
  RectShape,
  Shape,
  ShapeId,
  TextShape,
  UnderlineShape,
} from '@/shared/annotations';
import { DEFAULT_HIGHLIGHT_OPACITY } from '@/shared/annotations';
import type { Ctx2D } from '@/shared/composite';
import type { Rect } from '@/shared/types';
import {
  arrowGeometry,
  inflate,
  isUnderlay,
  rectsIntersect,
  shapeBounds,
  TEXT_OUTLINE_RATIO,
  textFont,
  textLayout,
} from './geometry';

/**
 * Where image px land in the output: output = (image - (x, y)) * scale. For the screen,
 * `scale = zoom * devicePixelRatio`; for an export, output px per image px.
 */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface DrawOptions {
  /** Paint the base image first (screen: tiles; export does its own compositing beforehand). */
  drawBase?: (ctx: Ctx2D, view: View) => void;
  /** Shapes not to draw (the text being edited in the overlay). */
  hidden?: ReadonlySet<ShapeId> | null;
  /** Image-px rect that is visible; shapes outside it are skipped. Default: no culling. */
  cull?: Rect | null;
}

/** Contrast shadow (design review §3): blur 2 CSS px, 22% black, 1 CSS px down. */
export const SHADOW_BLUR_CSS = 2;
export const SHADOW_OFFSET_CSS = 1;
export const SHADOW_COLOR = 'rgba(0,0,0,0.22)';

/** Rect corner radius, CSS px. */
export const RECT_RADIUS_CSS = 4;

export function drawDoc(ctx: Ctx2D, doc: AnnotationDoc, view: View, opts: DrawOptions = {}): void {
  ctx.save();
  ctx.setTransform(view.scale, 0, 0, view.scale, -view.x * view.scale, -view.y * view.scale);
  if (opts.drawBase) {
    ctx.save();
    opts.drawBase(ctx, view);
    ctx.restore();
    ctx.setTransform(view.scale, 0, 0, view.scale, -view.x * view.scale, -view.y * view.scale);
  }
  const dpr = doc.image.dpr;
  const visible = (s: Shape) =>
    !opts.hidden?.has(s.id) &&
    (!opts.cull || rectsIntersect(inflate(shapeBounds(s, dpr), 8 * dpr), opts.cull));

  for (const s of doc.shapes) if (isUnderlay(s) && visible(s)) drawShape(ctx, s, dpr, view.scale);
  for (const s of doc.shapes) if (!isUnderlay(s) && visible(s)) drawShape(ctx, s, dpr, view.scale);
  ctx.restore();
}

/** Draw one shape. The context transform maps image px to output px with `scale`. */
export function drawShape(ctx: Ctx2D, s: Shape, dpr: number, scale: number): void {
  ctx.save();
  switch (s.kind) {
    case 'highlight':
      drawHighlight(ctx, s);
      break;
    case 'pen':
      if (s.marker) drawMarker(ctx, s);
      else {
        applyShadow(ctx, s.shadow, dpr, scale);
        drawPen(ctx, s);
      }
      break;
    case 'arrow':
      applyShadow(ctx, s.shadow, dpr, scale);
      drawArrow(ctx, s, dpr);
      break;
    case 'rect':
      applyShadow(ctx, s.shadow, dpr, scale);
      drawRect(ctx, s, dpr);
      break;
    case 'underline':
      applyShadow(ctx, s.shadow, dpr, scale);
      drawUnderline(ctx, s);
      break;
    case 'text':
      drawText(ctx, s, dpr, scale);
      break;
  }
  ctx.restore();
}

/** Shadow params are in output px (canvas shadows ignore the transform). */
function applyShadow(ctx: Ctx2D, on: boolean, dpr: number, scale: number): void {
  if (!on) return;
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = SHADOW_BLUR_CSS * dpr * scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = SHADOW_OFFSET_CSS * dpr * scale;
}

function clearShadow(ctx: Ctx2D): void {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawArrow(ctx: Ctx2D, s: ArrowShape, dpr: number): void {
  const g = arrowGeometry(s, dpr);
  const back = s.heads === 'both' ? arrowGeometry({ a: s.b, b: s.a, width: s.width }, dpr) : null;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Shaft (stopping inside each head), then the filled heads; a final shadowless stroke of the
  // heads rounds their corners.
  const shaft = new Path2D();
  const start = back ? back.shaftEnd : s.a;
  shaft.moveTo(start.x, start.y);
  shaft.lineTo(g.shaftEnd.x, g.shaftEnd.y);
  const heads = new Path2D();
  for (const h of back ? [g.head, back.head] : [g.head]) {
    heads.moveTo(h[0].x, h[0].y);
    heads.lineTo(h[1].x, h[1].y);
    heads.lineTo(h[2].x, h[2].y);
    heads.closePath();
  }
  ctx.lineWidth = s.width;
  ctx.stroke(shaft);
  ctx.lineWidth = Math.max(1, s.width * 0.35);
  ctx.fill(heads);
  clearShadow(ctx);
  ctx.stroke(heads);
}

function drawRect(ctx: Ctx2D, s: RectShape, dpr: number): void {
  const { x, y, w, h } = s.box;
  const r = Math.min(RECT_RADIUS_CSS * dpr, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (s.fill !== 'none') {
    ctx.save();
    clearShadow(ctx);
    ctx.globalAlpha = s.fill === 'tint' ? 0.15 : 1;
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawUnderline(ctx: Ctx2D, s: UnderlineShape): void {
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  ctx.lineTo(s.b.x, s.b.y);
  ctx.stroke();
}

function drawHighlight(ctx: Ctx2D, s: HighlightShape): void {
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = s.opacity;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.thickness;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  ctx.lineTo(s.b.x, s.b.y);
  ctx.stroke();
}

const penPathCache = new WeakMap<PenShape, Path2D>();

/** perfect-freehand options per pen mode (03 §6). */
export function penStrokeOptions(s: PenShape) {
  const hasPressure = s.pts.some((p) => p[2] !== 0.5);
  return s.marker
    ? {
        size: s.size,
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: false,
        last: true,
      }
    : {
        size: s.size,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: !hasPressure,
        last: true,
      };
}

/** Filled outline polygon of a pen stroke, cached per (immutable) shape. */
export function penPath(s: PenShape): Path2D {
  const hit = penPathCache.get(s);
  if (hit) return hit;
  const outline = getStroke(s.pts as unknown as number[][], penStrokeOptions(s));
  const path = new Path2D();
  if (outline.length > 0) {
    const [fx, fy] = outline[0] as [number, number];
    path.moveTo(fx, fy);
    // Quadratic midpoints give a smooth outline (perfect-freehand's recommended rendering).
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i - 1] as [number, number];
      const [x1, y1] = outline[i] as [number, number];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    path.closePath();
  }
  penPathCache.set(s, path);
  return path;
}

function drawPen(ctx: Ctx2D, s: PenShape): void {
  ctx.fillStyle = s.color;
  ctx.fill(penPath(s));
}

function drawMarker(ctx: Ctx2D, s: PenShape): void {
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = DEFAULT_HIGHLIGHT_OPACITY;
  ctx.fillStyle = s.color;
  ctx.fill(penPath(s));
}

function drawText(ctx: Ctx2D, s: TextShape, dpr: number, scale: number): void {
  const layout = textLayout(s);
  ctx.font = textFont(s);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lineY = (i: number) => s.at.y + layout.lineHeight * (i + 0.5);
  if (s.style === 'label') {
    const pad = s.size * 0.25;
    ctx.save();
    applyShadow(ctx, s.shadow, dpr, scale);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    const b = layout.box;
    ctx.roundRect(b.x - pad, b.y - pad / 2, b.w + 2 * pad, b.h + pad, pad);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#FFFFFF';
    layout.lines.forEach((line, i) => {
      ctx.fillText(line, s.at.x, lineY(i));
    });
    return;
  }
  // Outline style: white stroke (with the contrast shadow) under a coloured fill.
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = s.size * TEXT_OUTLINE_RATIO;
  ctx.strokeStyle = '#FFFFFF';
  ctx.save();
  applyShadow(ctx, s.shadow, dpr, scale);
  layout.lines.forEach((line, i) => {
    ctx.strokeText(line, s.at.x, lineY(i));
  });
  ctx.restore();
  ctx.fillStyle = s.color;
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, s.at.x, lineY(i));
  });
}
