/**
 * Pixel checks for direct-manipulation output: rotated rects and text turn about their frame
 * centre, bent arrows follow their curve, and the output matches at a different view scale.
 */
import { describe, expect, it } from 'vitest';
import { drawDoc, type View } from '@/editor/engine/draw';
import {
  arrowControl,
  arrowGeometry,
  arrowMidpoint,
  rectCenter,
  rotatePoint,
  shapeFrame,
  textLayout,
} from '@/editor/engine/geometry';
import {
  type AnnotationDoc,
  type ArrowShape,
  emptyDoc,
  type RectShape,
  type Shape,
  type TextShape,
} from '@/shared/annotations';
import type { Point } from '@/shared/types';

const RED: [number, number, number] = [0xff, 0x3b, 0x30];
const WHITE: [number, number, number] = [255, 255, 255];
const DPR = 2;

function doc(shapes: Shape[]): AnnotationDoc {
  return { ...emptyDoc('s', { w: 1000, h: 1000, dpr: DPR }), shapes };
}

function canvas(w = 1000, h = 1000) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no ctx');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return ctx;
}

function render(shapes: Shape[], view: View = { x: 0, y: 0, scale: 1 }, w = 1000, h = 1000) {
  const ctx = canvas(w, h);
  drawDoc(ctx, doc(shapes), view);
  return ctx;
}

function px(ctx: OffscreenCanvasRenderingContext2D, p: Point): [number, number, number] {
  const d = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

function expectPointClose(a: Point, b: Point): void {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
}

const near = (a: readonly number[], b: readonly number[], tol = 8) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

/** Image px → output px for a view. */
const out = (v: View, p: Point): Point => ({ x: (p.x - v.x) * v.scale, y: (p.y - v.y) * v.scale });

/** Pixels in an output-px region that are close to `color`, and the region's pixel count. */
function count(
  ctx: OffscreenCanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pred: (p: [number, number, number]) => boolean,
): { hits: number; total: number } {
  const x = Math.round(x0);
  const y = Math.round(y0);
  const w = Math.max(1, Math.round(x1) - x);
  const h = Math.max(1, Math.round(y1) - y);
  const d = ctx.getImageData(x, y, w, h).data;
  let hits = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (pred([d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0])) hits++;
  }
  return { hits, total: w * h };
}

const isRed = (p: [number, number, number]) => near(p, RED, 12);
const isNotWhite = (p: [number, number, number]) => !near(p, WHITE, 4);

const base = { color: '#FF3B30', shadow: false } as const;

describe('rotated rect', () => {
  const box = { x: 300, y: 400, w: 400, h: 200 }; // centre (500, 500)
  const rot = Math.PI / 4;
  const s: RectShape = {
    ...base,
    id: 'r',
    kind: 'rect',
    box,
    width: 12,
    fill: 'none',
    rotation: rot,
  };
  const c = rectCenter(box);
  const w = (p: Point) => rotatePoint(p, c, rot);

  it('draws its border rotated about the centre, hollow inside', () => {
    const ctx = render([s]);
    // Mid-points of each local edge, in world space.
    for (const local of [
      { x: 700, y: 500 },
      { x: 300, y: 500 },
      { x: 500, y: 400 },
      { x: 500, y: 600 },
    ]) {
      expect(px(ctx, w(local))).toEqual(RED);
    }
    // Unrotated corners and edge mid-points are background now.
    for (const p of [
      { x: 300, y: 400 },
      { x: 700, y: 400 },
      { x: 700, y: 600 },
      { x: 300, y: 600 },
      { x: 700, y: 500 },
    ]) {
      expect(px(ctx, p)).toEqual(WHITE);
    }
    expect(px(ctx, c)).toEqual(WHITE);
    expect(px(ctx, w({ x: 400, y: 480 }))).toEqual(WHITE);
  });

  it('30°: same checks at a different angle', () => {
    const r30 = { ...s, rotation: Math.PI / 6 };
    const ctx = render([r30]);
    const w30 = (p: Point) => rotatePoint(p, c, Math.PI / 6);
    expect(px(ctx, w30({ x: 700, y: 500 }))).toEqual(RED);
    expect(px(ctx, w30({ x: 500, y: 400 }))).toEqual(RED);
    expect(px(ctx, { x: 300, y: 400 })).toEqual(WHITE);
    expect(px(ctx, c)).toEqual(WHITE);
  });

  it('matches at view scale 0.5 with an offset (WYSIWYG)', () => {
    const v: View = { x: 100, y: 100, scale: 0.5 };
    const ctx = render([s], v, 500, 500);
    // The 12-px stroke is 6 output px wide; sample its centre line.
    for (const local of [
      { x: 700, y: 500 },
      { x: 500, y: 400 },
    ]) {
      expect(near(px(ctx, out(v, w(local))), RED)).toBe(true);
    }
    expect(px(ctx, out(v, { x: 300, y: 400 }))).toEqual(WHITE);
    expect(px(ctx, out(v, c))).toEqual(WHITE);
  });
});

describe('rotated text', () => {
  // A label (filled box) long enough that the rotated and unrotated boxes barely overlap.
  const t: TextShape = {
    ...base,
    id: 't',
    kind: 'text',
    at: { x: 250, y: 470 },
    text: 'HHHHHHHHHHHH',
    size: 40,
    weight: 700,
    style: 'label',
    rotation: Math.PI / 2,
  };

  /** Regions (image px) only the rotated / only the unrotated label covers. */
  function regions(s: TextShape) {
    // The glyph box: always inside the drawn label / outline ink. The rotation centre is its centre.
    const g = textLayout(s).box;
    const c = rectCenter(g);
    expectPointClose(c, rectCenter(shapeFrame(s)));
    const mIn = 3; // stay inside the glyph box (antialiasing, rounded label corners)
    const mOut = s.size * 0.5; // stay clear of the other orientation's padding/outline
    expect(g.w).toBeGreaterThan(g.h * 3); // the test relies on a long, thin label
    return {
      c,
      // Above the overlap square, inside the upright (rotated) glyph box.
      rotatedOnly: [
        c.x - g.h / 2 + mIn,
        c.y - g.w / 2 + mIn,
        c.x + g.h / 2 - mIn,
        c.y - g.h / 2 - mOut,
      ],
      // Right of the overlap square, where the unrotated glyph box would be.
      unrotatedOnly: [
        c.x + g.h / 2 + mOut,
        c.y - g.h / 2 + mIn,
        c.x + g.w / 2 - mIn,
        c.y + g.h / 2 - mIn,
      ],
    } as const;
  }

  it('fills the rotated region, not the unrotated one', () => {
    const ctx = render([t]);
    const { rotatedOnly: a, unrotatedOnly: b } = regions(t);
    const inRot = count(ctx, a[0], a[1], a[2], a[3], isRed);
    expect(inRot.hits / inRot.total).toBeGreaterThan(0.5);
    expect(count(ctx, b[0], b[1], b[2], b[3], isNotWhite).hits).toBe(0);

    // Control: unrotated, the same regions flip.
    const { rotation: _r, ...unrotated } = t;
    const flat = render([unrotated]);
    expect(count(flat, a[0], a[1], a[2], a[3], isNotWhite).hits).toBe(0);
    const inFlat = count(flat, b[0], b[1], b[2], b[3], isRed);
    expect(inFlat.hits / inFlat.total).toBeGreaterThan(0.5);
  });

  it('outline text: glyph ink lands in the rotated region only', () => {
    const o: TextShape = { ...t, style: 'outline', size: 60 };
    const ctx = render([o]);
    const { rotatedOnly: a, unrotatedOnly: b } = regions(o);
    expect(count(ctx, a[0], a[1], a[2], a[3], isRed).hits).toBeGreaterThan(500);
    expect(count(ctx, b[0], b[1], b[2], b[3], isNotWhite).hits).toBe(0);
  });

  it('matches at view scale 0.5 (WYSIWYG)', () => {
    const v: View = { x: 0, y: 0, scale: 0.5 };
    const ctx = render([t], v, 500, 500);
    const { rotatedOnly: a, unrotatedOnly: b } = regions(t);
    const inRot = count(ctx, a[0] * 0.5, a[1] * 0.5, a[2] * 0.5, a[3] * 0.5, isRed);
    expect(inRot.hits / inRot.total).toBeGreaterThan(0.5);
    expect(count(ctx, b[0] * 0.5, b[1] * 0.5, b[2] * 0.5, b[3] * 0.5, isNotWhite).hits).toBe(0);
  });
});

describe('bent arrow', () => {
  // Horizontal chord; bend -400 bulges up: control (500, 200), curve apex (500, 400).
  const s: ArrowShape = {
    ...base,
    id: 'a',
    kind: 'arrow',
    a: { x: 150, y: 600 },
    b: { x: 850, y: 600 },
    width: 12,
    bend: -400,
    heads: 'end',
  };
  const apex = arrowMidpoint(s);
  const chordMid = { x: 500, y: 600 };
  const head = arrowGeometry(s, DPR).head;
  const headCentroid = {
    x: (head[0].x + head[1].x + head[2].x) / 3,
    y: (head[0].y + head[1].y + head[2].y) / 3,
  };

  it('follows the curve: the apex is ink, the chord midpoint is background', () => {
    expect(apex.x).toBeCloseTo(500, 9);
    expect(apex.y).toBeCloseTo(400, 9);
    const ctx = render([s]);
    expect(px(ctx, apex)).toEqual(RED);
    expect(px(ctx, chordMid)).toEqual(WHITE);
    // 12 px stroke: 10 px above/below the apex is clear.
    expect(px(ctx, { x: 500, y: 389 })).toEqual(WHITE);
    expect(px(ctx, { x: 500, y: 411 })).toEqual(WHITE);
  });

  it('draws the head at b, along the tangent', () => {
    const ctx = render([s]);
    expect(px(ctx, headCentroid)).toEqual(RED);
    // Ink near the tip region.
    const r = count(ctx, s.b.x - 30, s.b.y - 30, s.b.x + 2, s.b.y + 30, isRed);
    expect(r.hits).toBeGreaterThan(200);
    // Nothing past the tip.
    expect(px(ctx, { x: s.b.x + 12, y: s.b.y })).toEqual(WHITE);
    // The tangent at b (b − control) points steeply down-right, so the head reaches up-left
    // along it; a straight arrow's head (pointing right) doesn't cover that spot.
    const c = arrowControl(s);
    const tl = Math.hypot(s.b.x - c.x, s.b.y - c.y);
    const alongTangent = {
      x: s.b.x - ((s.b.x - c.x) / tl) * 30,
      y: s.b.y - ((s.b.y - c.y) / tl) * 30,
    };
    expect(px(ctx, alongTangent)).toEqual(RED);
    const straight = render([{ ...s, bend: 0 }]);
    expect(px(straight, alongTangent)).toEqual(WHITE);
    expect(px(straight, apex)).toEqual(WHITE);
  });

  it('matches at view scale 0.5 (WYSIWYG)', () => {
    const v: View = { x: 0, y: 0, scale: 0.5 };
    const ctx = render([s], v, 500, 500);
    expect(near(px(ctx, out(v, apex)), RED)).toBe(true);
    expect(px(ctx, out(v, chordMid))).toEqual(WHITE);
    expect(near(px(ctx, out(v, headCentroid)), RED)).toBe(true);
  });
});
