/**
 * Direct manipulation: rotation, bent arrows, frame handles (resize / scale / wrap / rotate / bend),
 * group scaling, text wrapping, the hit-test prefilter and the v1 → v2 doc migration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  arrowControl,
  arrowGeometry,
  arrowMidpoint,
  BEND_SNAP_CSS,
  dragHandle,
  groupScale,
  hitHandle,
  hitShape,
  hitTestShapes,
  inflate,
  interactiveHandles,
  normalizeAngle,
  paintOrder,
  pointInRect,
  quadPoint,
  ROTATE_HANDLE_CSS,
  rectCenter,
  rotatePoint,
  scaleShape,
  setTextMeasurer,
  shapeBounds,
  shapeFrame,
  shapeHandles,
  shapeOutline,
  TEXT_LINE_HEIGHT,
  TEXT_OUTLINE_RATIO,
  textLayout,
  withRotation,
} from '@/editor/engine/geometry';
import {
  type AnnotationDoc,
  type ArrowShape,
  DOC_VERSION,
  type HighlightShape,
  migrateDoc,
  type PenShape,
  type RectShape,
  type Shape,
  type TextShape,
  type UnderlineShape,
} from '@/shared/annotations';
import type { Point, Rect } from '@/shared/types';

// ------------------------------------------------------------------------------- factories

let seq = 0;
const nextId = () => `d${++seq}`;
const base = { color: '#FF3B30', shadow: false };

function arrow(a: Point, b: Point, o: Partial<ArrowShape> = {}): ArrowShape {
  return { id: nextId(), kind: 'arrow', ...base, a, b, width: 12, bend: 0, heads: 'end', ...o };
}
function rect(box: Rect, o: Partial<RectShape> = {}): RectShape {
  return { id: nextId(), kind: 'rect', ...base, box, width: 10, fill: 'none', ...o };
}
function underline(a: Point, b: Point, o: Partial<UnderlineShape> = {}): UnderlineShape {
  return { id: nextId(), kind: 'underline', ...base, a, b, width: 10, ...o };
}
function highlight(a: Point, b: Point, o: Partial<HighlightShape> = {}): HighlightShape {
  return {
    id: nextId(),
    kind: 'highlight',
    ...base,
    color: '#FFCC00',
    a,
    b,
    thickness: 44,
    opacity: 0.6,
    ...o,
  };
}
function pen(pts: [number, number, number][], o: Partial<PenShape> = {}): PenShape {
  return { id: nextId(), kind: 'pen', ...base, pts, size: 12, marker: false, ...o };
}
function text(at: Point, value: string, o: Partial<TextShape> = {}): TextShape {
  return {
    id: nextId(),
    kind: 'text',
    ...base,
    at,
    text: value,
    size: 20,
    weight: 700,
    style: 'outline',
    ...o,
  };
}

const DEG = Math.PI / 180;
const TOL = 4;
const DPR = 2;

function expectPointClose(actual: Point, expected: Point, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function expectRectClose(actual: Rect, expected: Rect, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.w).toBeCloseTo(expected.w, digits);
  expect(actual.h).toBeCloseTo(expected.h, digits);
}

function boundsOf(pts: readonly Point[]): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function handle(s: Shape, id: string, zoom = 1): Point {
  const h = shapeHandles(s, zoom).find((x) => x.id === id);
  if (!h) throw new Error(`no handle ${id}`);
  return { x: h.x, y: h.y };
}

function corners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** Deterministic measurer: 10 image px per character at any size. */
const fixedMeasurer = (t: string) => t.length * 10;
/** 0.5 em per character (scales with the font size). */
const emMeasurer = (t: string, _f: string, size: number) => t.length * size * 0.5;

afterEach(() => setTextMeasurer(null));

// ------------------------------------------------------------------------------- rotation basics

describe('rotation helpers', () => {
  it('rotatePoint turns clockwise on screen (y down)', () => {
    expectPointClose(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2), { x: 0, y: 10 });
    expectPointClose(rotatePoint({ x: 5, y: 2 }, { x: 3, y: 3 }, 0), { x: 5, y: 2 });
  });

  it('normalizeAngle maps to (-π, π] and flushes float noise to 0', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAngle(2 * Math.PI)).toBe(0);
    expect(normalizeAngle(-0.5)).toBe(-0.5);
  });

  it('withRotation sets the field, and drops it at 0', () => {
    const r = rect({ x: 0, y: 0, w: 10, h: 10 });
    expect(withRotation(r, 0.5).rotation).toBe(0.5);
    const back = withRotation(withRotation(r, 0.5), 0);
    expect('rotation' in back).toBe(false);
    expect('rotation' in withRotation(r, 2 * Math.PI)).toBe(false);
  });
});

// ------------------------------------------------------------------------------- hit-testing

describe('rotated hit-testing', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));

  it('rect at 30°: hits the rotated border, misses the unrotated corner and the hollow inside', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    const s = rect(box, { rotation: 30 * DEG }); // half stroke 5
    const c = rectCenter(box);
    const w = (p: Point) => rotatePoint(p, c, 30 * DEG);
    // Points on each local edge, mapped to world.
    for (const local of [
      { x: 300, y: 150 },
      { x: 100, y: 150 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 300, y: 200 },
    ]) {
      expect(hitShape(s, w(local), TOL, DPR)).toBe(true);
    }
    // Just outside / inside the border band in the local frame.
    expect(hitShape(s, w({ x: 300 + 5 + TOL - 0.5, y: 150 }), TOL, DPR)).toBe(true);
    expect(hitShape(s, w({ x: 300 + 5 + TOL + 0.5, y: 150 }), TOL, DPR)).toBe(false);
    expect(hitShape(s, w({ x: 300 - 5 - TOL - 0.5, y: 150 }), TOL, DPR)).toBe(false);
    // The unrotated top-right corner is far outside the rotated box.
    expect(hitShape(s, { x: 300, y: 100 }, TOL, DPR)).toBe(false);
    // Hollow: the centre and a point well inside miss.
    expect(hitShape(s, c, TOL, DPR)).toBe(false);
    expect(hitShape(s, w({ x: 150, y: 150 }), TOL, DPR)).toBe(false);
    // Filled: the inside hits.
    expect(hitShape({ ...s, fill: 'tint' }, c, TOL, DPR)).toBe(true);
    expect(hitShape({ ...s, fill: 'solid' }, w({ x: 150, y: 150 }), TOL, DPR)).toBe(true);
  });

  it('rect at 90°: the box stands on end about its centre', () => {
    const s = rect({ x: 100, y: 100, w: 200, h: 100 }, { rotation: Math.PI / 2 });
    // World extent: x 150..250, y 50..250.
    expect(hitShape(s, { x: 150, y: 150 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 250, y: 120 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 200, y: 50 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 200, y: 250 }, TOL, DPR)).toBe(true);
    // The unrotated left/right edges are now empty space.
    expect(hitShape(s, { x: 100, y: 150 }, TOL, DPR)).toBe(false);
    expect(hitShape(s, { x: 300, y: 150 }, TOL, DPR)).toBe(false);
    expect(hitShape(s, { x: 200, y: 150 }, TOL, DPR)).toBe(false);
  });

  it('text: hits inside the rotated box, not the unrotated one', () => {
    // 'hello' at 20 px: box 100..150 × 100..125, centre (125, 112.5).
    const s = text({ x: 100, y: 100 }, 'hello', { rotation: Math.PI / 2 });
    // Rotated box: x 112.5..137.5, y 87.5..137.5.
    expect(hitShape(s, { x: 125, y: 112.5 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 125, y: 90 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 125, y: 135 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 105, y: 112.5 }, TOL, DPR)).toBe(false);
    expect(hitShape(s, { x: 148, y: 105 }, TOL, DPR)).toBe(false);
    // Unrotated, the same points flip.
    const flat = text({ x: 100, y: 100 }, 'hello');
    expect(hitShape(flat, { x: 125, y: 90 }, TOL, DPR)).toBe(false);
    expect(hitShape(flat, { x: 105, y: 112.5 }, TOL, DPR)).toBe(true);
  });

  it('pen: tests the polyline in its own frame', () => {
    const s = pen(
      [
        [0, 0, 0.5],
        [100, 0, 0.5],
      ],
      { rotation: Math.PI / 2 },
    ); // rotates about (50, 0): now x = 50, y -50..50
    expect(hitShape(s, { x: 50, y: 40 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 50, y: -45 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 59, y: 0 }, TOL, DPR)).toBe(true); // 9 ≤ 6 + 4
    expect(hitShape(s, { x: 62, y: 0 }, TOL, DPR)).toBe(false);
    expect(hitShape(s, { x: 90, y: 0 }, TOL, DPR)).toBe(false); // the old line
    expect(hitShape(s, { x: 5, y: 0 }, TOL, DPR)).toBe(false);
  });
});

// ------------------------------------------------------------------------------- bounds

describe('rotated bounds', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));

  it('rect at 45°: bounds of the rotated outer corners (stroke included)', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    const s = rect(box, { rotation: 45 * DEG });
    const c = rectCenter(box);
    const outer = { x: 95, y: 95, w: 210, h: 110 };
    const expected = boundsOf(corners(outer).map((p) => rotatePoint(p, c, 45 * DEG)));
    expectRectClose(shapeBounds(s, DPR), expected);
    // Half-extent of a 210 × 110 box at 45°: (105 + 55) / √2.
    const he = 160 / Math.SQRT2;
    expectRectClose(shapeBounds(s, DPR), { x: 200 - he, y: 150 - he, w: 2 * he, h: 2 * he });
  });

  it('rect at 90° swaps the extents; 0 matches the unrotated bounds', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    expectRectClose(shapeBounds(rect(box, { rotation: Math.PI / 2 }), DPR), {
      x: 145,
      y: 45,
      w: 110,
      h: 210,
    });
    expect(shapeBounds(rect(box, { rotation: 0 }), DPR)).toEqual(shapeBounds(rect(box), DPR));
  });

  it('text at 90°: the outlined ink box turns about its centre', () => {
    const s = text({ x: 100, y: 100 }, 'hello', { rotation: Math.PI / 2 });
    const o = 20 * TEXT_OUTLINE_RATIO * 0.5;
    const w = 50 + 2 * o;
    const h = 20 * TEXT_LINE_HEIGHT + 2 * o;
    expectRectClose(shapeBounds(s, DPR), { x: 125 - h / 2, y: 112.5 - w / 2, w: h, h: w });
  });

  it('pen at 90°: rotated points inflated by half the size + 1', () => {
    const s = pen(
      [
        [0, 0, 0.5],
        [100, 0, 0.5],
      ],
      { rotation: Math.PI / 2 },
    );
    expectRectClose(shapeBounds(s, DPR), { x: 43, y: -57, w: 14, h: 114 });
  });

  it('rotated bounds contain the rotated ink: rect frame, text glyph box + outline, pen stroke', () => {
    const inside = (p: Point, b: Rect) => {
      expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-9);
      expect(p.x).toBeLessThanOrEqual(b.x + b.w + 1e-9);
      expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1e-9);
    };
    for (const rot of [10, 30, 45, 77, 135, -60].map((d) => d * DEG)) {
      // A rect's frame is the outer edge of its stroke.
      const r = rect({ x: 10, y: 20, w: 120, h: 40 }, { rotation: rot });
      const rf = shapeFrame(r);
      for (const p of corners(rf)) inside(rotatePoint(p, rectCenter(rf), rot), shapeBounds(r, DPR));
      // Text: the glyph box plus the outline (outline style) or the drawn label box.
      for (const t of [
        text({ x: 0, y: 0 }, 'rotate me\nplease', { rotation: rot }),
        text({ x: 0, y: 0 }, 'label', { rotation: rot, style: 'label' }),
      ]) {
        const box = textLayout(t).box;
        const ink =
          t.style === 'outline'
            ? inflate(box, t.size * TEXT_OUTLINE_RATIO * 0.5)
            : { x: box.x - 5, y: box.y - 2.5, w: box.w + 10, h: box.h + 5 }; // draw.ts label pad
        for (const p of corners(ink))
          inside(rotatePoint(p, rectCenter(box), rot), shapeBounds(t, DPR));
        // The rotation centre is the frame's centre, which is the glyph box's centre.
        expectPointClose(rectCenter(shapeFrame(t)), rectCenter(box), 9);
      }
      // Pens: the bounds follow the stroke, not its (looser) rotated frame box.
      const p = pen(
        [
          [0, 0, 0.5],
          [80, 30, 0.5],
          [40, 90, 0.5],
        ],
        { rotation: rot },
      );
      const b = shapeBounds(p, DPR);
      const c = rectCenter(shapeFrame(p));
      for (const [x, y] of p.pts) {
        const q = rotatePoint({ x, y }, c, rot);
        inside({ x: q.x - 6, y: q.y - 6 }, b);
        inside({ x: q.x + 6, y: q.y + 6 }, b);
      }
    }
  });

  it('shapeOutline traces the rotated frame of rects and texts', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    const s = rect(box, { rotation: 30 * DEG });
    const out = shapeOutline(s);
    expect(out.closed).toBe(true);
    const f = shapeFrame(s);
    const want = corners(f).map((p) => rotatePoint(p, rectCenter(box), 30 * DEG));
    out.pts.forEach((p, i) => {
      expectPointClose(p, want[i] as Point);
    });
  });
});

// ------------------------------------------------------------------------------- frames

describe('shapeFrame', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));

  it("rect: the stroke's outer edge (same centre as the box); pen: points bounds + size/2", () => {
    const r = rect({ x: 10, y: 20, w: 30, h: 40 }, { width: 6 });
    expect(shapeFrame(r)).toEqual({ x: 7, y: 17, w: 36, h: 46 });
    expectPointClose(rectCenter(shapeFrame(r)), rectCenter(r.box));
    expect(
      shapeFrame(
        pen([
          [10, 20, 0.5],
          [50, 0, 0.5],
        ]),
      ),
    ).toEqual({ x: 4, y: -6, w: 52, h: 32 });
  });

  it('text: the glyph box padded symmetrically, in proportion to the size', () => {
    for (const style of ['outline', 'label'] as const) {
      const small = text({ x: 100, y: 100 }, 'hello', { style });
      const big = text({ x: 100, y: 100 }, 'hello', { style, size: 40 });
      const pads = (t: TextShape) => {
        const f = shapeFrame(t);
        const b = textLayout(t).box;
        expect(f.x + f.w - (b.x + b.w)).toBeCloseTo(b.x - f.x, 9); // symmetric
        expect(f.y + f.h - (b.y + b.h)).toBeCloseTo(b.y - f.y, 9);
        return { x: b.x - f.x, y: b.y - f.y };
      };
      const ps = pads(small);
      const pb = pads(big);
      expect(ps.x).toBeGreaterThan(0);
      expect(ps.y).toBeGreaterThan(0);
      expect(pb.x).toBeCloseTo(2 * ps.x, 9);
      expect(pb.y).toBeCloseTo(2 * ps.y, 9);
      // The frame covers the drawn ink (outline or label box).
      const f = shapeFrame(small);
      const ink = style === 'outline' ? 20 * TEXT_OUTLINE_RATIO * 0.5 : 5;
      expect(ps.x).toBeGreaterThanOrEqual(ink - 1e-9);
      expect(f.w).toBeGreaterThan(50);
    }
  });
});

// ------------------------------------------------------------------------------- bent arrows

describe('bent arrows', () => {
  // Horizontal chord; normal (-uy, ux) = (0, 1) points down, so a negative bend bulges upward.
  const a = { x: 100, y: 300 };
  const b = { x: 500, y: 300 };

  it('arrowControl = chord midpoint + bend × normal; arrowMidpoint = midpoint + normal × bend/2', () => {
    const s = arrow(a, b, { bend: -200 });
    expectPointClose(arrowControl(s), { x: 300, y: 100 });
    expectPointClose(arrowMidpoint(s), { x: 300, y: 200 });
    // Diagonal chord: u = (0.6, 0.8), n = (-0.8, 0.6).
    const d = arrow({ x: 0, y: 0 }, { x: 300, y: 400 }, { bend: 100 });
    expectPointClose(arrowControl(d), { x: 150 - 80, y: 200 + 60 });
    expectPointClose(arrowMidpoint(d), { x: 150 - 40, y: 200 + 30 });
    expectPointClose(arrowMidpoint(d), quadPoint(d.a, arrowControl(d), d.b, 0.5));
    // Straight: both are the chord midpoint.
    expectPointClose(arrowControl(arrow(a, b)), { x: 300, y: 300 });
    expectPointClose(arrowMidpoint(arrow(a, b)), { x: 300, y: 300 });
  });

  it('bounds contain the curve apex (with the stroke)', () => {
    const s = arrow(a, b, { bend: -200 });
    const r = shapeBounds(s, DPR);
    expect(r.y).toBeLessThanOrEqual(200 - s.width / 2);
    expect(pointInRect({ x: 300, y: 200 }, r)).toBe(true);
    // Every curve sample is inside.
    for (let i = 0; i <= 20; i++) {
      expect(pointInRect(quadPoint(s.a, arrowControl(s), s.b, i / 20), r)).toBe(true);
    }
    // Straight arrows' bounds don't reach that high.
    expect(shapeBounds(arrow(a, b), DPR).y).toBeGreaterThan(250);
  });

  it('the head points along the tangent at b (b − control)', () => {
    for (const bend of [-200, -60, 35, 150]) {
      const s = arrow(a, b, { bend });
      const g = arrowGeometry(s, DPR);
      const [tip, left, right] = g.head;
      expectPointClose(tip, b, 9);
      const back = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
      const hl = Math.hypot(tip.x - back.x, tip.y - back.y);
      const c = arrowControl(s);
      const tl = Math.hypot(b.x - c.x, b.y - c.y);
      expect(Math.abs((tip.x - back.x) / hl - (b.x - c.x) / tl)).toBeLessThan(1e-9);
      expect(Math.abs((tip.y - back.y) / hl - (b.y - c.y) / tl)).toBeLessThan(1e-9);
    }
  });

  it('hitShape hits the curve apex and misses the chord midpoint when bent far', () => {
    const s = arrow(a, b, { bend: -200 });
    expect(hitShape(s, { x: 300, y: 200 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 300, y: 300 }, TOL, DPR)).toBe(false);
    expect(hitShape(s, { x: 300, y: 200 - 6 - TOL + 1 }, TOL, DPR)).toBe(true);
    expect(hitShape(s, { x: 300, y: 200 - 6 - TOL - 1.5 }, TOL, DPR)).toBe(false);
    // The straight version is the other way round.
    expect(hitShape(arrow(a, b), { x: 300, y: 300 }, TOL, DPR)).toBe(true);
    expect(hitShape(arrow(a, b), { x: 300, y: 200 }, TOL, DPR)).toBe(false);
  });

  it('a double-headed bent arrow has both heads in its bounds and hit area', () => {
    const s = arrow(a, b, { bend: -200, heads: 'both' });
    const r = shapeBounds(s, DPR);
    const back = arrowGeometry({ a: s.b, b: s.a, width: s.width, bend: 200 }, DPR);
    for (const p of back.head) expect(pointInRect(p, r)).toBe(true);
    const [tip, l, rr] = back.head;
    const inside = { x: (tip.x + l.x + rr.x) / 3, y: (tip.y + l.y + rr.y) / 3 };
    expect(hitShape(s, inside, 0, DPR)).toBe(true);
  });
});

// ------------------------------------------------------------------------------- handles

describe('handles', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));

  it("rotation handle sits ROTATE_HANDLE_CSS/zoom above the frame's top centre", () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    for (const zoom of [0.5, 1, 2]) {
      // A rect's frame top is the stroke's outer edge: 100 - width/2.
      expectPointClose(handle(rect(box), 'rot', zoom), {
        x: 200,
        y: 100 - 5 - ROTATE_HANDLE_CSS / zoom,
      });
    }
    const t = text({ x: 100, y: 100 }, 'hello');
    const f = shapeFrame(t);
    expectPointClose(handle(t, 'rot', 2), { x: f.x + f.w / 2, y: f.y - ROTATE_HANDLE_CSS / 2 });
    const p = pen([
      [0, 0, 0.5],
      [100, 40, 0.5],
    ]);
    expectPointClose(handle(p, 'rot'), { x: 50, y: -6 - ROTATE_HANDLE_CSS });
  });

  it('handles rotate with the shape', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    const c = rectCenter(box);
    const rot = 30 * DEG;
    const s = rect(box, { rotation: rot });
    const flat = rect(box);
    for (const h of shapeHandles(flat, 2)) {
      expectPointClose(handle(s, h.id, 2), rotatePoint(h, c, rot));
    }
    // 90°: the rotation handle is to the right of the centre.
    expectPointClose(handle(rect(box, { rotation: Math.PI / 2 }), 'rot', 2), {
      x: 200 + 50 + 11 + 5,
      y: 150,
    });
    // And hitHandle finds the rotated corner.
    const se = handle(s, 'se');
    expect(hitHandle(s, { x: se.x + 1, y: se.y - 1 }, 6)).toBe('se');
  });

  it('interactiveHandles drops crowded side handles and the short-arrow bend handle', () => {
    const small = rect({ x: 0, y: 0, w: 20, h: 100 }, { width: 2 }); // frame 22 × 102
    const ids = interactiveHandles(small, 1).map((h) => h.id);
    expect(ids).not.toContain('n');
    expect(ids).not.toContain('s');
    expect(ids).toContain('e');
    expect(ids).toContain('rot');
    expect(interactiveHandles(small, 2).map((h) => h.id)).toContain('n');
    expect(interactiveHandles(arrow({ x: 0, y: 0 }, { x: 30, y: 0 })).map((h) => h.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

// ------------------------------------------------------------------------------- resize: rect

describe('dragHandle: rect resize', () => {
  // Stroke 10: the frame (outer stroke edge) is 95..305 × 95..205; handles sit on it.
  const box = { x: 100, y: 100, w: 200, h: 100 };
  const c = rectCenter(box);
  const rot = 30 * DEG;
  const toWorld = (p: Point) => rotatePoint(p, c, rot);

  it("resizing a 30°-rotated rect by 'se' keeps the 'nw' corner fixed in world space", () => {
    const s = rect(box, { rotation: rot });
    const nwBefore = handle(s, 'nw');
    // Pointer at local (350, 250): the frame becomes 95..350 × 95..250.
    const r = dragHandle(s, 'se', toWorld({ x: 350, y: 250 })) as RectShape;
    expect(r.rotation).toBeCloseTo(rot, 12);
    expect(shapeFrame(r).w).toBeCloseTo(350 - 95, 9);
    expect(shapeFrame(r).h).toBeCloseTo(250 - 95, 9);
    // The box is half a stroke inside the frame.
    expect(r.box.w).toBeCloseTo(350 - 95 - 10, 9);
    expect(r.box.h).toBeCloseTo(250 - 95 - 10, 9);
    expectPointClose(handle(r, 'nw'), nwBefore, 9);
    // The new 'se' handle is under the pointer.
    expectPointClose(handle(r, 'se'), toWorld({ x: 350, y: 250 }), 9);
  });

  it('an edge handle of a rotated rect keeps the opposite edge fixed', () => {
    const s = rect(box, { rotation: rot });
    const wBefore = handle(s, 'w');
    const r = dragHandle(s, 'e', toWorld({ x: 380, y: 170 })) as RectShape;
    expect(shapeFrame(r).w).toBeCloseTo(380 - 95, 9);
    expect(r.box.h).toBeCloseTo(100, 9);
    expectPointClose(handle(r, 'w'), wBefore, 9);
    expectPointClose(handle(r, 'e'), toWorld({ x: 380, y: 150 }), 9);
  });

  it("Shift keeps the frame's aspect ratio (rotated too)", () => {
    const s = rect(box, { rotation: rot });
    const f0 = shapeFrame(s);
    const nwBefore = handle(s, 'nw');
    const r = dragHandle(s, 'se', toWorld({ x: 400, y: 160 }), { shift: true }) as RectShape;
    const f = shapeFrame(r);
    expect(f.w / f.h).toBeCloseTo(f0.w / f0.h, 9);
    expect(f.w).toBeCloseTo(400 - 95, 9); // the larger relative pull wins
    expectPointClose(handle(r, 'nw'), nwBefore, 9);
    const flat = dragHandle(rect(box), 'se', { x: 400, y: 160 }, { shift: true }) as RectShape;
    const ff = shapeFrame(flat);
    expect(ff.x).toBe(95);
    expect(ff.y).toBe(95);
    expect(ff.w).toBeCloseTo(305, 9);
    expect(ff.w / ff.h).toBeCloseTo(f0.w / f0.h, 9);
  });

  it('Alt resizes about the centre', () => {
    const flat = dragHandle(rect(box), 'se', { x: 350, y: 250 }, { alt: true }) as RectShape;
    expect(shapeFrame(flat)).toEqual({ x: 50, y: 50, w: 300, h: 200 });
    const s = rect(box, { rotation: rot });
    const r = dragHandle(s, 'se', toWorld({ x: 350, y: 250 }), { alt: true }) as RectShape;
    expectPointClose(rectCenter(r.box), c, 9);
    expect(shapeFrame(r).w).toBeCloseTo(300, 9);
    expect(shapeFrame(r).h).toBeCloseTo(200, 9);
  });

  it('shrinking past the stroke leaves a zero-size box, never negative', () => {
    const r = dragHandle(rect(box), 'se', { x: 97, y: 97 }) as RectShape;
    expect(r.box.w).toBeGreaterThanOrEqual(0);
    expect(r.box.h).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------------------------------------- resize: text

describe('dragHandle: text', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));

  it('a corner scales the size proportionally with the opposite frame corner fixed', () => {
    const s = text({ x: 100, y: 100 }, 'hello');
    const f = shapeFrame(s);
    // Drag 'se' to twice the diagonal from 'nw'.
    const r = dragHandle(s, 'se', { x: f.x + 2 * f.w, y: f.y + 2 * f.h }) as TextShape;
    expect(r.size).toBeCloseTo(40, 9);
    expectRectClose(shapeFrame(r), { x: f.x, y: f.y, w: 2 * f.w, h: 2 * f.h });
    // 'nw' shrinks with 'se' fixed.
    const small = dragHandle(s, 'nw', { x: f.x + f.w / 2, y: f.y + f.h / 2 }) as TextShape;
    expect(small.size).toBeCloseTo(10, 9);
    const sf = shapeFrame(small);
    expect(sf.x + sf.w).toBeCloseTo(f.x + f.w, 9);
    expect(sf.y + sf.h).toBeCloseTo(f.y + f.h, 9);
  });

  it('a corner scales maxW too, and keeps the anchor fixed when rotated', () => {
    const s = text({ x: 100, y: 100 }, 'hello world', { maxW: 80, rotation: 30 * DEG });
    const nwBefore = handle(s, 'nw');
    const f = shapeFrame(s);
    const c = rectCenter(f);
    const target = rotatePoint({ x: f.x + 1.5 * f.w, y: f.y + 1.5 * f.h }, c, 30 * DEG);
    const r = dragHandle(s, 'se', target) as TextShape;
    expect(r.size).toBeCloseTo(30, 9);
    expect(r.maxW).toBeCloseTo(120, 9);
    expect(r.rotation).toBeCloseTo(30 * DEG, 12);
    expectPointClose(handle(r, 'nw'), nwBefore, 9);
  });

  it("'e' sets maxW (frame width minus padding) and wraps lines; 'w' keeps the right edge", () => {
    const s = text({ x: 100, y: 100 }, 'hello world'); // 10 px per char at 20 px
    const f = shapeFrame(s);
    const b = textLayout(s).box;
    const pad = b.x - f.x;
    const padY = b.y - f.y;
    const r = dragHandle(s, 'e', { x: f.x + 60 + 2 * pad, y: 999 }) as TextShape;
    expect(r.maxW).toBeCloseTo(60, 9);
    expect(r.size).toBe(20);
    expect(textLayout(r).lines).toEqual(['hello', 'world']);
    expect(shapeFrame(r).x).toBeCloseTo(f.x, 9);
    expect(shapeFrame(r).y).toBeCloseTo(f.y, 9);
    expect(shapeFrame(r).w).toBeCloseTo(60 + 2 * pad, 9);
    expect(shapeFrame(r).h).toBeCloseTo(2 * 20 * TEXT_LINE_HEIGHT + 2 * padY, 9);

    const l = dragHandle(s, 'w', { x: f.x + f.w - 60 - 2 * pad, y: 0 }) as TextShape;
    expect(l.maxW).toBeCloseTo(60, 9);
    const lf = shapeFrame(l);
    expect(lf.x + lf.w).toBeCloseTo(f.x + f.w, 9);
  });

  it("'e' never goes below one em", () => {
    const s = text({ x: 100, y: 100 }, 'hello world');
    const r = dragHandle(s, 'e', { x: 0, y: 0 }) as TextShape;
    expect(r.maxW).toBeCloseTo(20, 9);
  });
});

// ------------------------------------------------------------------------------- resize: pen

describe('dragHandle: pen', () => {
  const pts: [number, number, number][] = [
    [0, 0, 0.5],
    [100, 0, 0.3],
    [100, 100, 0.7],
  ];

  it('a corner scales the points about the opposite points-bounds corner, keeping the size', () => {
    const s = pen(pts); // frame -6..106; 'se' handle at (106, 106)
    expectPointClose(handle(s, 'se'), { x: 106, y: 106 });
    const r = dragHandle(s, 'se', { x: 206, y: 206 }) as PenShape;
    expect(r.size).toBe(12);
    expect(r.pts).toEqual([
      [0, 0, 0.5],
      [200, 0, 0.3],
      [200, 200, 0.7],
    ]);
    // 'nw' shrinks about (100, 100).
    const n = dragHandle(s, 'nw', { x: 44, y: 44 }) as PenShape;
    n.pts.forEach((p, i) => {
      const o = pts[i] as [number, number, number];
      expect(p[0]).toBeCloseTo(100 + (o[0] - 100) * 0.5, 9);
      expect(p[1]).toBeCloseTo(100 + (o[1] - 100) * 0.5, 9);
    });
  });

  it('a rotated pen keeps the opposite frame corner fixed in world space', () => {
    const s = pen(pts, { rotation: 40 * DEG });
    const nwBefore = handle(s, 'nw');
    const se = handle(s, 'se');
    // Pull the corner 1.5× along the diagonal from nw.
    const r = dragHandle(s, 'se', {
      x: nwBefore.x + (se.x - nwBefore.x) * 1.5,
      y: nwBefore.y + (se.y - nwBefore.y) * 1.5,
    }) as PenShape;
    expect(r.rotation).toBeCloseTo(40 * DEG, 12);
    expectPointClose(handle(r, 'nw'), nwBefore, 9);
  });
});

// ------------------------------------------------------------------------------- rotate

describe("dragHandle: 'rot'", () => {
  const box = { x: 100, y: 100, w: 200, h: 100 }; // centre (200, 150)

  it('rotates relative to opts.start', () => {
    const s = rect(box);
    const r = dragHandle(s, 'rot', { x: 300, y: 150 }, { start: { x: 200, y: 50 } }) as RectShape;
    expect(r.rotation).toBeCloseTo(Math.PI / 2, 12);
    // Adds to an existing rotation.
    const s2 = rect(box, { rotation: 0.2 });
    const p = rotatePoint({ x: 300, y: 150 }, { x: 200, y: 150 }, 0.5);
    const r2 = dragHandle(s2, 'rot', p, { start: { x: 300, y: 150 } }) as RectShape;
    expect(r2.rotation).toBeCloseTo(0.7, 12);
    // Without start: the pointer's angle, measured from straight up.
    const r3 = dragHandle(s, 'rot', { x: 300, y: 150 }) as RectShape;
    expect(r3.rotation).toBeCloseTo(Math.PI / 2, 12);
  });

  it('Shift snaps to 15° steps', () => {
    const s = rect(box);
    const start = { x: 300, y: 150 };
    const at = (deg: number) => rotatePoint(start, { x: 200, y: 150 }, deg * DEG);
    expect(
      (dragHandle(s, 'rot', at(20), { start, shift: true }) as RectShape).rotation,
    ).toBeCloseTo(15 * DEG, 12);
    expect(
      (dragHandle(s, 'rot', at(23), { start, shift: true }) as RectShape).rotation,
    ).toBeCloseTo(30 * DEG, 12);
    expect(
      (dragHandle(s, 'rot', at(-52), { start, shift: true }) as RectShape).rotation,
    ).toBeCloseTo(-45 * DEG, 12);
    // Snapping to 0 drops the field.
    expect('rotation' in dragHandle(s, 'rot', at(5), { start, shift: true })).toBe(false);
  });

  it('soft-snaps to multiples of 90° within 2°', () => {
    const s = rect(box);
    const start = { x: 300, y: 150 };
    const at = (deg: number) => rotatePoint(start, { x: 200, y: 150 }, deg * DEG);
    expect((dragHandle(s, 'rot', at(91.5), { start }) as RectShape).rotation).toBeCloseTo(
      Math.PI / 2,
      12,
    );
    expect((dragHandle(s, 'rot', at(178.5), { start }) as RectShape).rotation).toBeCloseTo(
      Math.PI,
      12,
    );
    expect('rotation' in dragHandle(s, 'rot', at(1.5), { start })).toBe(false);
    expect((dragHandle(s, 'rot', at(3), { start }) as RectShape).rotation).toBeCloseTo(3 * DEG, 12);
    expect((dragHandle(s, 'rot', at(47), { start }) as RectShape).rotation).toBeCloseTo(
      47 * DEG,
      12,
    );
  });

  it('rotates text and pens about their frame centre', () => {
    setTextMeasurer(emMeasurer);
    const t = text({ x: 100, y: 100 }, 'hello');
    const c = rectCenter(shapeFrame(t));
    const start = { x: c.x, y: c.y - 50 };
    const r = dragHandle(t, 'rot', { x: c.x + 50, y: c.y }, { start }) as TextShape;
    expect(r.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(r.at).toEqual(t.at);
    const p = pen([
      [0, 0, 0.5],
      [100, 0, 0.5],
    ]);
    const rp = dragHandle(p, 'rot', { x: 50, y: 100 }, { start: { x: 100, y: 0 } }) as PenShape;
    expect(rp.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(rp.pts).toEqual(p.pts);
  });
});

// ------------------------------------------------------------------------------- bend

describe("dragHandle: arrow 'mid'", () => {
  const a = { x: 100, y: 300 };
  const b = { x: 500, y: 300 };

  it('sets bend = 2 × the offset along the normal, so the curve passes under the pointer', () => {
    const s = arrow(a, b);
    const r = dragHandle(s, 'mid', { x: 300, y: 200 }) as ArrowShape;
    expect(r.bend).toBeCloseTo(-200, 9);
    expectPointClose(arrowMidpoint(r), { x: 300, y: 200 });
    // Only the normal component counts.
    const r2 = dragHandle(s, 'mid', { x: 340, y: 350 }) as ArrowShape;
    expect(r2.bend).toBeCloseTo(100, 9);
    expect(r2.a).toEqual(a);
    expect(r2.b).toEqual(b);
  });

  it('works on a diagonal chord', () => {
    const s = arrow({ x: 0, y: 0 }, { x: 300, y: 400 });
    const r = dragHandle(s, 'mid', { x: 110, y: 230 }) as ArrowShape;
    expect(r.bend).toBeCloseTo(100, 9);
    expectPointClose(arrowMidpoint(r), { x: 110, y: 230 });
  });

  it('snaps straight when the handle is within BEND_SNAP_CSS of the chord (on screen)', () => {
    const bent = arrow(a, b, { bend: -200 });
    const off = BEND_SNAP_CSS - 1;
    expect((dragHandle(bent, 'mid', { x: 300, y: 300 - off }) as ArrowShape).bend).toBe(0);
    // At zoom 2 the same image offset is 10 CSS px: no snap.
    expect(
      (dragHandle(bent, 'mid', { x: 300, y: 300 - off }, { zoom: 2 }) as ArrowShape).bend,
    ).toBeCloseTo(-2 * off, 9);
    // At zoom 0.5, 10 image px is 5 CSS px: snaps.
    expect((dragHandle(bent, 'mid', { x: 300, y: 290 }, { zoom: 0.5 }) as ArrowShape).bend).toBe(0);
    // Already straight and snapping straight: the same object back.
    const s = arrow(a, b);
    expect(dragHandle(s, 'mid', { x: 300, y: 302 })).toBe(s);
  });

  it('a zero-length arrow ignores the bend handle', () => {
    const s = arrow(a, a);
    expect(dragHandle(s, 'mid', { x: 0, y: 0 })).toBe(s);
  });
});

// ------------------------------------------------------------------------------- group scale

describe('scaleShape / groupScale', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));
  const o = { x: 0, y: 0 };

  it('arrow: endpoints and bend scale, the width stays', () => {
    const s = arrow({ x: 10, y: 20 }, { x: 110, y: 20 }, { bend: 30 });
    const r = scaleShape(s, o, 2) as ArrowShape;
    expect(r.a).toEqual({ x: 20, y: 40 });
    expect(r.b).toEqual({ x: 220, y: 40 });
    expect(r.bend).toBe(60);
    expect(r.width).toBe(12);
  });

  it('rect: centre and size scale; stroke width and rotation stay', () => {
    const s = rect({ x: 10, y: 20, w: 100, h: 40 }, { rotation: 0.4 });
    const r = scaleShape(s, { x: 10, y: 20 }, 1.5) as RectShape;
    expectRectClose(r.box, { x: 10, y: 20, w: 150, h: 60 });
    expect(r.width).toBe(10);
    expect(r.rotation).toBe(0.4);
  });

  it('underline: rounded endpoints; highlight: exact', () => {
    const u = scaleShape(underline({ x: 3, y: 5 }, { x: 13, y: 5 }), o, 1.25) as UnderlineShape;
    expect(u.a).toEqual({ x: 4, y: 6 });
    expect(u.b).toEqual({ x: 16, y: 6 });
    const h = scaleShape(highlight({ x: 3, y: 5 }, { x: 13, y: 5 }), o, 1.25) as HighlightShape;
    expect(h.a).toEqual({ x: 3.75, y: 6.25 });
    expect(h.thickness).toBe(44);
  });

  it('text: size and maxW scale, its frame centre scales about the anchor', () => {
    const s = text({ x: 100, y: 100 }, 'hello', { maxW: 80 });
    const c = rectCenter(shapeFrame(s));
    const r = scaleShape(s, o, 2) as TextShape;
    expect(r.size).toBe(40);
    expect(r.maxW).toBe(160);
    expectPointClose(rectCenter(shapeFrame(r)), { x: 2 * c.x, y: 2 * c.y });
    expect('maxW' in (scaleShape(text(o, 'x'), o, 2) as TextShape)).toBe(false);
  });

  it('pen: points scale about the anchor, size stays', () => {
    const s = pen([
      [10, 10, 0.2],
      [20, 30, 0.8],
    ]);
    const r = scaleShape(s, o, 2) as PenShape;
    r.pts.forEach((p, i) => {
      const q = s.pts[i] as readonly [number, number, number];
      expect(p[0]).toBeCloseTo(q[0] * 2, 9);
      expect(p[1]).toBeCloseTo(q[1] * 2, 9);
      expect(p[2]).toBe(q[2]);
    });
    expect(r.size).toBe(12);
  });

  it('groupScale: opposite-corner anchor, or the centre with Alt; clamped by minK', () => {
    const r = { x: 0, y: 0, w: 100, h: 100 };
    expect(groupScale(r, 'se', { x: 200, y: 200 }, false)).toEqual({
      anchor: { x: 0, y: 0 },
      k: 2,
    });
    expect(groupScale(r, 'nw', { x: 50, y: 50 }, false)).toEqual({
      anchor: { x: 100, y: 100 },
      k: 0.5,
    });
    expect(groupScale(r, 'se', { x: 200, y: 200 }, true)).toEqual({
      anchor: { x: 50, y: 50 },
      k: 3,
    });
    // Projection onto the diagonal: an off-diagonal pointer scales by its projection.
    expect(groupScale(r, 'se', { x: 200, y: 0 }, false).k).toBeCloseTo(1, 12);
    expect(groupScale(r, 'se', { x: -50, y: -50 }, false).k).toBe(0.05);
    expect(groupScale(r, 'se', { x: -50, y: -50 }, false, 0.2).k).toBe(0.2);
  });

  it('groupScale + scaleShape keeps the anchor corner of the group bounds fixed', () => {
    const shapes = [
      rect({ x: 0, y: 0, w: 50, h: 50 }),
      arrow({ x: 60, y: 60 }, { x: 160, y: 120 }),
    ];
    const g = { x: 0, y: 0, w: 160, h: 120 };
    const { anchor, k } = groupScale(g, 'se', { x: 320, y: 240 }, false);
    expect(k).toBeCloseTo(2, 12);
    const scaled = shapes.map((s) => scaleShape(s, anchor, k));
    expect((scaled[0] as RectShape).box).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect((scaled[1] as ArrowShape).b).toEqual({ x: 320, y: 240 });
  });
});

// ------------------------------------------------------------------------------- text layout

describe('textLayout wrapping (fixed 10 px/char measurer)', () => {
  beforeEach(() => setTextMeasurer(fixedMeasurer));

  it('without maxW: one line per paragraph, widest line wins', () => {
    const l = textLayout(text({ x: 5, y: 7 }, 'hello world\nab'));
    expect(l.lines).toEqual(['hello world', 'ab']);
    expect(l.lineHeight).toBe(20 * TEXT_LINE_HEIGHT);
    expect(l.box).toEqual({ x: 5, y: 7, w: 110, h: 2 * 25 });
  });

  it('greedy word wrap at maxW; the box is maxW wide', () => {
    const l = textLayout(text({ x: 0, y: 0 }, 'hello world foo bar', { maxW: 75 }));
    expect(l.lines).toEqual(['hello', 'world', 'foo bar']);
    expect(l.box.w).toBe(75);
    expect(l.box.h).toBe(3 * 25);
    const wide = textLayout(text({ x: 0, y: 0 }, 'hello world foo bar', { maxW: 115 }));
    expect(wide.lines).toEqual(['hello world', 'foo bar']);
  });

  it('a line that fits is untouched; paragraphs wrap independently', () => {
    expect(textLayout(text({ x: 0, y: 0 }, 'short', { maxW: 200 })).lines).toEqual(['short']);
    expect(textLayout(text({ x: 0, y: 0 }, 'aa bb cc\ndd', { maxW: 50 })).lines).toEqual([
      'aa bb',
      'cc',
      'dd',
    ]);
    expect(textLayout(text({ x: 0, y: 0 }, 'a\n\nb', { maxW: 50 })).lines).toEqual(['a', '', 'b']);
  });

  it('breaks words longer than maxW between characters', () => {
    expect(textLayout(text({ x: 0, y: 0 }, 'abcdefghij', { maxW: 35 })).lines).toEqual([
      'abc',
      'def',
      'ghi',
      'j',
    ]);
    expect(textLayout(text({ x: 0, y: 0 }, 'xy abcdefgh z', { maxW: 40 })).lines).toEqual([
      'xy',
      'abcd',
      'efgh',
      'z',
    ]);
  });

  it('clamps the wrap width to at least one em', () => {
    const l = textLayout(text({ x: 0, y: 0 }, 'abcd', { maxW: 5 })); // size 20 → wrap at 20
    expect(l.lines).toEqual(['ab', 'cd']);
    expect(l.box.w).toBe(20);
  });
});

// ------------------------------------------------------------------------------- prefilter

describe('hitTestShapes prefilter', () => {
  beforeEach(() => setTextMeasurer(emMeasurer));

  /** Deterministic PRNG (mulberry32). */
  function rng(seed: number) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeShapes(n: number, rand: () => number): Shape[] {
    const out: Shape[] = [];
    for (let i = 0; i < n; i++) {
      const x = rand() * 1800;
      const y = rand() * 1800;
      const rot = rand() < 0.5 ? (rand() - 0.5) * 2 * Math.PI : 0;
      const p = (dx: number, dy: number) => ({ x: x + dx, y: y + dy });
      switch (i % 6) {
        case 0:
          out.push(
            arrow(p(0, 0), p(40 + rand() * 200, rand() * 200 - 100), {
              bend: rand() < 0.5 ? (rand() - 0.5) * 300 : 0,
              heads: rand() < 0.3 ? 'both' : 'end',
              width: 4 + rand() * 10,
            }),
          );
          break;
        case 1:
          out.push(
            rect(
              { x, y, w: 20 + rand() * 200, h: 20 + rand() * 200 },
              { ...(rot ? { rotation: rot } : {}), fill: rand() < 0.3 ? 'tint' : 'none' },
            ),
          );
          break;
        case 2:
          out.push(underline(p(0, 0), p(rand() * 200, rand() * 40)));
          break;
        case 3:
          out.push(
            pen(
              Array.from(
                { length: 8 },
                (_, k) => [x + k * 15, y + rand() * 60, 0.5] as [number, number, number],
              ),
              { ...(rot ? { rotation: rot } : {}), marker: rand() < 0.2 },
            ),
          );
          break;
        case 4:
          // Label text: its bounds' padding covers the rotated hit box.
          out.push(
            text(p(0, 0), 'note here', {
              ...(rot ? { rotation: rot } : {}),
              style: 'label',
              size: 16 + rand() * 30,
            }),
          );
          break;
        default:
          out.push(text(p(0, 0), 'plain text', { size: 16 + rand() * 30 }));
      }
    }
    return out;
  }

  /** Reference: walk the paint order top-down with no prefilter. */
  function bruteForce(shapes: readonly Shape[], p: Point, tol: number): Shape | null {
    const order = paintOrder(shapes);
    for (let i = order.length - 1; i >= 0; i--) {
      const s = order[i] as Shape;
      if (hitShape(s, p, tol, DPR)) return s;
    }
    return null;
  }

  it('agrees with an unfiltered top-down walk on 200 shapes', () => {
    const rand = rng(1234);
    const shapes = makeShapes(200, rand);
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const p = { x: rand() * 2000, y: rand() * 2000 };
      const want = bruteForce(shapes, p, TOL);
      expect(hitTestShapes(shapes, p, TOL, DPR)).toBe(want);
      if (want) hits++;
    }
    // Sanity: the sample actually exercises hits.
    expect(hits).toBeGreaterThan(100);
  });

  it('agrees near shape edges (points sampled around every shape)', () => {
    const rand = rng(99);
    const shapes = makeShapes(200, rand);
    for (const s of shapes) {
      const b = shapeBounds(s, DPR);
      for (let k = 0; k < 10; k++) {
        const p = { x: b.x - 6 + rand() * (b.w + 12), y: b.y - 6 + rand() * (b.h + 12) };
        expect(hitTestShapes(shapes, p, TOL, DPR)).toBe(bruteForce(shapes, p, TOL));
      }
    }
  });

  it('stays fast: 1000 hover tests over 200 shapes', () => {
    const rand = rng(7);
    const shapes = makeShapes(200, rand);
    hitTestShapes(shapes, { x: 0, y: 0 }, TOL, DPR); // warm the bounds cache
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      hitTestShapes(shapes, { x: rand() * 2000, y: rand() * 2000 }, TOL, DPR);
    }
    // ~µs per call in practice; very generous so CI noise can't flake it.
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

// ------------------------------------------------------------------------------- migration

describe('migrateDoc', () => {
  const v1 = {
    v: 1,
    sessionId: 'sess-1',
    rev: 7,
    image: { w: 1000, h: 4000, dpr: 2 },
    shapes: [
      {
        id: 'r1',
        kind: 'rect',
        color: '#FF3B30',
        shadow: true,
        box: { x: 1, y: 2, w: 3, h: 4 },
        width: 10,
        fill: 'none',
      },
      {
        id: 'a1',
        kind: 'arrow',
        color: '#FF3B30',
        shadow: true,
        a: { x: 0, y: 0 },
        b: { x: 10, y: 0 },
        width: 6,
        bend: 0,
        heads: 'end',
      },
    ],
    crop: null,
    updatedAt: 123456,
  };

  it('v1 → v2: re-stamps v and preserves every field', () => {
    const before = structuredClone(v1);
    const doc = migrateDoc(v1) as AnnotationDoc;
    expect(doc).not.toBeNull();
    expect(DOC_VERSION).toBe(2);
    expect(doc.v).toBe(DOC_VERSION);
    const { v: _v, ...rest } = doc;
    const { v: _v1, ...restV1 } = v1;
    expect(rest).toEqual(restV1);
    expect(v1).toEqual(before); // input untouched
    // Old shapes have no rotation: they behave as unrotated.
    expect('rotation' in (doc.shapes[0] as RectShape)).toBe(false);
  });

  it('v2 passes through', () => {
    const v2 = { ...v1, v: 2 };
    expect(migrateDoc(v2)).toEqual(v2);
  });

  it('unknown versions and garbage give null', () => {
    expect(migrateDoc({ ...v1, v: 3 })).toBeNull();
    expect(migrateDoc({ ...v1, v: 0 })).toBeNull();
    expect(migrateDoc({ ...v1, v: '2' })).toBeNull();
    expect(migrateDoc({ ...v1, v: undefined })).toBeNull();
    expect(migrateDoc({ ...v1, shapes: 'nope' })).toBeNull();
    expect(migrateDoc({ ...v1, sessionId: 42 })).toBeNull();
    expect(migrateDoc(null)).toBeNull();
    expect(migrateDoc(undefined)).toBeNull();
    expect(migrateDoc('doc')).toBeNull();
    expect(migrateDoc(2)).toBeNull();
    expect(migrateDoc([])).toBeNull();
  });
});
