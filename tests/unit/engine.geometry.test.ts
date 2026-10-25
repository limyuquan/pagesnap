import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARROW_HEAD_HALF_ANGLE,
  arrowGeometry,
  arrowHeadLength,
  clampCamera,
  dist,
  distToSegment,
  dragHandle,
  FIT_GUTTER_CSS,
  fitWidthZoom,
  hitHandle,
  hitShape,
  hitTestShapes,
  imageToScreen,
  pointInRect,
  ROTATE_HANDLE_CSS,
  resizeBox,
  SCROLL_PAD_CSS,
  screenToImage,
  setTextMeasurer,
  shapeBounds,
  shapeHandles,
  snapAngle,
  squareFrom,
  TEXT_LINE_HEIGHT,
  TEXT_OUTLINE_RATIO,
  translateShape,
  zoomAround,
} from '@/editor/engine/geometry';
import type {
  ArrowShape,
  HighlightShape,
  PenShape,
  RectShape,
  Shape,
  TextShape,
  UnderlineShape,
} from '@/shared/annotations';
import type { Point, Rect } from '@/shared/types';

// ------------------------------------------------------------------------------- factories

let seq = 0;
const nextId = () => `s${++seq}`;
const base = { color: '#FF3B30', shadow: true };

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
    color: '#FFD60A',
    a,
    b,
    thickness: 44,
    opacity: 0.45,
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

function expectRectClose(actual: Rect, expected: Rect, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.w).toBeCloseTo(expected.w, digits);
  expect(actual.h).toBeCloseTo(expected.h, digits);
}

/** Deterministic measurer: 0.5 em per character. */
const fakeMeasurer = (t: string, _font: string, size: number) => t.length * size * 0.5;

// ------------------------------------------------------------------------------- basics

describe('distToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };

  it('is the perpendicular distance inside the segment', () => {
    expect(distToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distToSegment({ x: 5, y: -4 }, a, b)).toBe(4);
  });

  it('is the distance to the nearest endpoint beyond the ends', () => {
    expect(distToSegment({ x: -3, y: 4 }, a, b)).toBe(5);
    expect(distToSegment({ x: 13, y: 4 }, a, b)).toBe(5);
  });

  it('is 0 on the segment', () => {
    expect(distToSegment({ x: 7, y: 0 }, a, b)).toBe(0);
  });

  it('handles a degenerate segment', () => {
    expect(distToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
  });

  it('works for diagonal segments', () => {
    expect(distToSegment({ x: 0, y: 10 }, a, { x: 10, y: 10 })).toBeCloseTo(Math.SQRT2 * 5, 9);
  });
});

describe('snapAngle', () => {
  const a = { x: 100, y: 100 };

  it('snaps to 45° steps and keeps the length', () => {
    const p = { x: 200, y: 190 }; // ~42°
    const q = snapAngle(a, p);
    expect(dist(a, q)).toBeCloseTo(dist(a, p), 5);
    expect(q.x - a.x).toBeCloseTo(q.y - a.y, 5);
    expect(q.x).toBeGreaterThan(a.x);
  });

  it('gives exactly horizontal results', () => {
    const right = snapAngle(a, { x: 300, y: 110 });
    expect(right.y).toBe(100);
    expect(right.x).toBeCloseTo(100 + Math.hypot(200, 10), 5);
    const left = snapAngle(a, { x: 0, y: 95 });
    expect(left.y).toBe(100);
    expect(left.x).toBeLessThan(a.x);
  });

  it('gives exactly vertical results', () => {
    const down = snapAngle(a, { x: 104, y: 300 });
    expect(down.x).toBe(100);
    expect(down.y).toBeCloseTo(100 + Math.hypot(4, 200), 5);
    const up = snapAngle(a, { x: 97, y: -50 });
    expect(up.x).toBe(100);
    expect(up.y).toBeLessThan(a.y);
  });

  it('handles all four diagonals', () => {
    for (const [dx, dy] of [
      [50, 48],
      [-50, 48],
      [-50, -48],
      [50, -48],
    ] as const) {
      const q = snapAngle(a, { x: a.x + dx, y: a.y + dy });
      expect(Math.sign(q.x - a.x)).toBe(Math.sign(dx));
      expect(Math.sign(q.y - a.y)).toBe(Math.sign(dy));
      expect(Math.abs(q.x - a.x)).toBeCloseTo(Math.abs(q.y - a.y), 5);
    }
  });

  it('returns a copy of the point for zero length', () => {
    const q = snapAngle(a, { ...a });
    expect(q).toEqual(a);
  });
});

describe('squareFrom', () => {
  const a = { x: 10, y: 10 };

  it('uses the larger side in the drag direction', () => {
    expect(squareFrom(a, { x: 110, y: 40 })).toEqual({ x: 110, y: 110 });
    expect(squareFrom(a, { x: -20, y: 60 })).toEqual({ x: -40, y: 60 });
    expect(squareFrom(a, { x: 0, y: -90 })).toEqual({ x: -90, y: -90 });
  });

  it('treats a zero offset on one axis as positive', () => {
    expect(squareFrom(a, { x: 10, y: 50 })).toEqual({ x: 50, y: 50 });
  });
});

// ------------------------------------------------------------------------------- arrow

describe('arrowHeadLength', () => {
  it('is 4.5 stroke widths when that beats the minimum (design §3)', () => {
    expect(arrowHeadLength(12, 1000, 1)).toBe(54);
    expect(arrowHeadLength(12, 1000, 2)).toBe(54);
  });

  it('is at least 18 CSS px × dpr', () => {
    expect(arrowHeadLength(2, 1000, 1)).toBe(18);
    expect(arrowHeadLength(2, 1000, 2)).toBe(36);
    expect(arrowHeadLength(4, 1000, 3)).toBe(54);
  });

  it('never exceeds 60% of the arrow length', () => {
    expect(arrowHeadLength(12, 40, 1)).toBe(24);
    expect(arrowHeadLength(2, 20, 2)).toBe(12);
    expect(arrowHeadLength(12, 0, 2)).toBe(0);
  });
});

describe('arrowGeometry', () => {
  const s = arrow({ x: 100, y: 100 }, { x: 300, y: 100 }); // width 12, length 200

  it('puts the tip at b and the base 1 head length back, with the head half-angle', () => {
    const g = arrowGeometry(s, 2);
    expect(g.headLen).toBe(54);
    const [tip, left, right] = g.head;
    expect(tip).toEqual({ x: 300, y: 100 });
    const half = Math.tan(ARROW_HEAD_HALF_ANGLE) * 54;
    expect(left.x).toBeCloseTo(246, 9);
    expect(right.x).toBeCloseTo(246, 9);
    expect(Math.abs(left.y - 100)).toBeCloseTo(half, 9);
    expect(Math.abs(right.y - 100)).toBeCloseTo(half, 9);
    expect(Math.sign(left.y - 100)).toBe(-Math.sign(right.y - 100));
  });

  it('shortens the shaft by 0.8 head lengths', () => {
    const g = arrowGeometry(s, 2);
    expect(g.shaftEnd.x).toBeCloseTo(300 - 0.8 * 54, 9);
    expect(g.shaftEnd.y).toBeCloseTo(100, 9);
  });

  it('works along diagonals', () => {
    const d = arrow({ x: 0, y: 0 }, { x: 300, y: 400 }, { width: 6 }); // length 500
    const g = arrowGeometry(d, 2);
    expect(g.headLen).toBe(36);
    expect(dist(d.a, g.shaftEnd)).toBeCloseTo(500 - 0.8 * 36, 9);
    // Base corners are equidistant from the tip.
    expect(dist(g.head[0], g.head[1])).toBeCloseTo(dist(g.head[0], g.head[2]), 9);
  });

  it('does not produce NaN for a zero-length arrow', () => {
    const g = arrowGeometry(arrow({ x: 5, y: 5 }, { x: 5, y: 5 }), 2);
    for (const p of [g.shaftEnd, ...g.head]) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

// ------------------------------------------------------------------------------- bounds

describe('shapeBounds', () => {
  beforeEach(() => setTextMeasurer(fakeMeasurer));
  afterEach(() => setTextMeasurer(null));

  it('arrow: endpoints and head corners, inflated by half the stroke + 1', () => {
    const s = arrow({ x: 100, y: 100 }, { x: 300, y: 100 });
    const half = Math.tan(ARROW_HEAD_HALF_ANGLE) * 54;
    expectRectClose(shapeBounds(s, 2), {
      x: 100 - 7,
      y: 100 - half - 7,
      w: 200 + 14,
      h: 2 * half + 14,
    });
  });

  it('rect: box inflated by half the stroke', () => {
    expect(shapeBounds(rect({ x: 10, y: 20, w: 100, h: 50 }), 2)).toEqual({
      x: 5,
      y: 15,
      w: 110,
      h: 60,
    });
  });

  it('underline: square caps extend half the width', () => {
    expect(shapeBounds(underline({ x: 10, y: 50 }, { x: 110, y: 50 }), 2)).toEqual({
      x: 5,
      y: 45,
      w: 110,
      h: 10,
    });
  });

  it('highlight: horizontal band has butt caps', () => {
    expect(shapeBounds(highlight({ x: 10, y: 50 }, { x: 110, y: 50 }), 2)).toEqual({
      x: 10,
      y: 28,
      w: 100,
      h: 44,
    });
  });

  it("highlight: a slanted band is bounded by its butt-capped band's four corners", () => {
    const a = { x: 10, y: 50 };
    const b = { x: 110, y: 90 };
    const len = Math.hypot(100, 40);
    const nx = (-40 / len) * 22;
    const ny = (100 / len) * 22;
    const xs = [a.x + nx, a.x - nx, b.x + nx, b.x - nx];
    const ys = [a.y + ny, a.y - ny, b.y + ny, b.y - ny];
    expectRectClose(shapeBounds(highlight(a, b), 2), {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    });
    // Tighter than the old "inflate by half the thickness", but still contains both endpoints.
    const r = shapeBounds(highlight(a, b), 2);
    expect(pointInRect(a, r)).toBe(true);
    expect(pointInRect(b, r)).toBe(true);
  });

  it('pen: points inflated by half the size + 1', () => {
    const s = pen([
      [10, 10, 0.5],
      [50, 30, 0.5],
      [20, 60, 0.5],
    ]);
    expect(shapeBounds(s, 2)).toEqual({ x: 3, y: 3, w: 54, h: 64 });
  });

  it('pen: an empty stroke gives an empty rect inflated by the size', () => {
    const r = shapeBounds(pen([]), 2);
    expect(r.w).toBe(14);
    expect(r.h).toBe(14);
  });

  it('text (outline): measured ink box plus half the outline', () => {
    const s = text({ x: 100, y: 200 }, 'hello'); // 5 chars × 20 × 0.5 = 50
    const o = 20 * TEXT_OUTLINE_RATIO * 0.5;
    expectRectClose(shapeBounds(s, 2), {
      x: 100 - o,
      y: 200 - o,
      w: 50 + 2 * o,
      h: 20 * TEXT_LINE_HEIGHT + 2 * o,
    });
  });

  it('text (label): measured box plus the label padding, widest line, all lines', () => {
    const s = text({ x: 0, y: 0 }, 'ab\nabcd\nx', { style: 'label' }); // widest 4 chars = 40
    expectRectClose(shapeBounds(s, 2), {
      x: -5,
      y: -5,
      w: 40 + 10,
      h: 3 * 20 * TEXT_LINE_HEIGHT + 10,
    });
  });

  it('text: empty text keeps a minimum width', () => {
    const s = text({ x: 0, y: 0 }, '', { style: 'label' });
    expect(shapeBounds(s, 2).w).toBeCloseTo(20 * 0.3 + 10, 9);
  });

  it('uses the injected measurer (different measurer, different width)', () => {
    setTextMeasurer((t, _f, size) => t.length * size);
    const s = text({ x: 0, y: 0 }, 'hello', { style: 'label' });
    expect(shapeBounds(s, 2).w).toBeCloseTo(100 + 10, 9);
  });
});

// ------------------------------------------------------------------------------- hit-testing

describe('hitShape', () => {
  const tol = 4;
  const dpr = 2;
  beforeEach(() => setTextMeasurer(fakeMeasurer));
  afterEach(() => setTextMeasurer(null));

  it('arrow: shaft, near the shaft, inside the head, far miss', () => {
    const s = arrow({ x: 100, y: 100 }, { x: 300, y: 100 }); // half stroke 6
    expect(hitShape(s, { x: 200, y: 100 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 200, y: 100 + 6 + tol - 0.5 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 200, y: 100 + 6 + tol + 0.5 }, tol, dpr)).toBe(false);
    // 15 px off the line, but inside the head triangle (half-width there ~19.5 px).
    expect(hitShape(s, { x: 260, y: 115 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 200, y: 150 }, tol, dpr)).toBe(false);
    expect(hitShape(s, { x: 50, y: 100 }, tol, dpr)).toBe(false);
  });

  it('underline: on, near, far', () => {
    const s = underline({ x: 0, y: 50 }, { x: 100, y: 50 }); // half width 5
    expect(hitShape(s, { x: 50, y: 50 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 50, y: 58 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 50, y: 60 }, tol, dpr)).toBe(false);
  });

  it('highlight: anywhere on the band, near its edge, far', () => {
    const s = highlight({ x: 0, y: 50 }, { x: 100, y: 50 }); // half thickness 22
    expect(hitShape(s, { x: 50, y: 30 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 50, y: 50 + 22 + 3 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 50, y: 50 + 22 + 5 }, tol, dpr)).toBe(false);
  });

  it('rect fill none: hits the border only', () => {
    const s = rect({ x: 100, y: 100, w: 200, h: 100 }); // half stroke 5
    expect(hitShape(s, { x: 100, y: 150 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 200, y: 200 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 92, y: 150 }, tol, dpr)).toBe(true); // 8 outside, ≤ 5 + 4
    expect(hitShape(s, { x: 108, y: 150 }, tol, dpr)).toBe(true); // 8 inside
    expect(hitShape(s, { x: 200, y: 150 }, tol, dpr)).toBe(false); // centre
    expect(hitShape(s, { x: 120, y: 150 }, tol, dpr)).toBe(false);
    expect(hitShape(s, { x: 80, y: 150 }, tol, dpr)).toBe(false);
    expect(hitShape(s, { x: 90, y: 90 }, tol, dpr)).toBe(false); // corner diagonal ~14
  });

  it('rect fill tint/solid: hits inside too', () => {
    for (const fill of ['tint', 'solid'] as const) {
      const s = rect({ x: 100, y: 100, w: 200, h: 100 }, { fill });
      expect(hitShape(s, { x: 200, y: 150 }, tol, dpr)).toBe(true);
      expect(hitShape(s, { x: 100, y: 150 }, tol, dpr)).toBe(true);
      expect(hitShape(s, { x: 80, y: 150 }, tol, dpr)).toBe(false);
    }
  });

  it('pen: on the polyline, near, far, and between points', () => {
    const s = pen([
      [0, 0, 0.5],
      [100, 0, 0.5],
      [100, 100, 0.5],
    ]); // half size 6
    expect(hitShape(s, { x: 50, y: 0 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 100, y: 50 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 109, y: 50 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 112, y: 50 }, tol, dpr)).toBe(false);
    expect(hitShape(s, { x: 50, y: 50 }, tol, dpr)).toBe(false);
  });

  it('pen: a single dot and an empty stroke', () => {
    expect(hitShape(pen([[10, 10, 0.5]]), { x: 14, y: 10 }, tol, dpr)).toBe(true);
    expect(hitShape(pen([[10, 10, 0.5]]), { x: 30, y: 10 }, tol, dpr)).toBe(false);
    expect(hitShape(pen([]), { x: 0, y: 0 }, tol, dpr)).toBe(false);
  });

  it('text: inside the box, within tolerance, far', () => {
    const s = text({ x: 100, y: 100 }, 'hello'); // box 100..150 × 100..125
    expect(hitShape(s, { x: 125, y: 110 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 153, y: 110 }, tol, dpr)).toBe(true);
    expect(hitShape(s, { x: 156, y: 110 }, tol, dpr)).toBe(false);
    expect(hitShape(s, { x: 125, y: 200 }, tol, dpr)).toBe(false);
  });
});

describe('hitTestShapes', () => {
  const p = { x: 150, y: 150 };

  it('returns the topmost hit in array order', () => {
    const r1 = rect({ x: 100, y: 100, w: 100, h: 100 }, { fill: 'tint' });
    const r2 = rect({ x: 120, y: 120, w: 100, h: 100 }, { fill: 'solid' });
    expect(hitTestShapes([r1, r2], p, 4, 2)).toBe(r2);
    expect(hitTestShapes([r2, r1], p, 4, 2)).toBe(r1);
  });

  it('treats highlights as an underlay: a rect over a highlight wins even if the highlight is later', () => {
    const r = rect({ x: 100, y: 100, w: 100, h: 100 }, { fill: 'tint' });
    const hl = highlight({ x: 50, y: 150 }, { x: 250, y: 150 });
    expect(hitTestShapes([r, hl], p, 4, 2)).toBe(r);
    expect(hitTestShapes([hl, r], p, 4, 2)).toBe(r);
  });

  it('treats marker pens as an underlay too', () => {
    const marker = pen(
      [
        [50, 150, 0.5],
        [250, 150, 0.5],
      ],
      { marker: true, size: 40 },
    );
    const ul = underline({ x: 100, y: 150 }, { x: 200, y: 150 });
    expect(hitTestShapes([ul, marker], p, 4, 2)).toBe(ul);
  });

  it('falls through to the highlight when nothing above is hit', () => {
    const r = rect({ x: 100, y: 100, w: 100, h: 100 }); // fill none: centre misses
    const hl = highlight({ x: 50, y: 150 }, { x: 250, y: 150 });
    expect(hitTestShapes([hl, r], p, 4, 2)).toBe(hl);
  });

  it('later highlights are above earlier highlights', () => {
    const h1 = highlight({ x: 50, y: 150 }, { x: 250, y: 150 });
    const h2 = highlight({ x: 50, y: 155 }, { x: 250, y: 155 });
    expect(hitTestShapes([h1, h2], p, 4, 2)).toBe(h2);
  });

  it('returns null for a miss and for no shapes', () => {
    expect(
      hitTestShapes([rect({ x: 0, y: 0, w: 10, h: 10 })], { x: 500, y: 500 }, 4, 2),
    ).toBeNull();
    expect(hitTestShapes([], p, 4, 2)).toBeNull();
  });
});

// ------------------------------------------------------------------------------- handles

describe('shapeHandles / hitHandle', () => {
  beforeEach(() => setTextMeasurer(fakeMeasurer));
  afterEach(() => setTextMeasurer(null));

  it('rect has 8 box handles on its outer frame, plus the rotation handle', () => {
    // Frame = the box inflated by half the stroke (10): 95..305 × 95..205.
    const hs = shapeHandles(rect({ x: 100, y: 100, w: 200, h: 100 }));
    expect(hs).toEqual([
      { id: 'nw', x: 95, y: 95 },
      { id: 'n', x: 200, y: 95 },
      { id: 'ne', x: 305, y: 95 },
      { id: 'e', x: 305, y: 150 },
      { id: 'se', x: 305, y: 205 },
      { id: 's', x: 200, y: 205 },
      { id: 'sw', x: 95, y: 205 },
      { id: 'w', x: 95, y: 150 },
      // ROTATE_HANDLE_CSS / zoom above the frame's top edge.
      { id: 'rot', x: 200, y: 95 - ROTATE_HANDLE_CSS },
    ]);
  });

  it('underline and highlight have endpoint handles; arrows add the bend handle', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 30, y: 40 };
    for (const s of [underline(a, b), highlight(a, b)]) {
      expect(shapeHandles(s)).toEqual([
        { id: 'a', ...a },
        { id: 'b', ...b },
      ]);
    }
    expect(shapeHandles(arrow(a, b))).toEqual([
      { id: 'a', ...a },
      { id: 'b', ...b },
      { id: 'mid', x: 15.5, y: 21 },
    ]);
  });

  it('pen has 4 corner handles + rot on its frame; text has corners, e, w + rot', () => {
    const p = pen([
      [0, 0, 0.5],
      [100, 50, 0.5],
    ]); // frame = points bounds inflated by size/2 = 6
    expect(shapeHandles(p).map((h) => h.id)).toEqual(['nw', 'ne', 'se', 'sw', 'rot']);
    expect(shapeHandles(p)[0]).toEqual({ id: 'nw', x: -6, y: -6 });
    expect(shapeHandles(p)[2]).toEqual({ id: 'se', x: 106, y: 56 });
    const t = text({ x: 0, y: 0 }, 'x');
    expect(shapeHandles(t).map((h) => h.id)).toEqual(['nw', 'ne', 'se', 'sw', 'e', 'w', 'rot']);
  });

  it('hitHandle finds the nearest handle within tolerance', () => {
    const s = rect({ x: 100, y: 100, w: 200, h: 100 });
    expect(hitHandle(s, { x: 98, y: 93 }, 8)).toBe('nw');
    expect(hitHandle(s, { x: 306, y: 151 }, 8)).toBe('e');
    expect(hitHandle(s, { x: 200, y: 150 }, 8)).toBeNull();
    expect(hitHandle(s, { x: 110, y: 100 }, 8)).toBeNull();
    expect(hitHandle(s, { x: 201, y: 95 - ROTATE_HANDLE_CSS }, 8)).toBe('rot');
  });

  it('hitHandle prefers the nearer of two candidates', () => {
    // Frame -1..11 (stroke 2): handles 6 image px apart; at zoom 4 the 48-CSS-px sides show
    // their side handles.
    const s = rect({ x: 0, y: 0, w: 10, h: 10 }, { width: 2 });
    expect(hitHandle(s, { x: 0, y: -1 }, 8, 4)).toBe('nw');
    expect(hitHandle(s, { x: 4, y: -1 }, 8, 4)).toBe('n');
    expect(hitHandle(s, { x: 10, y: 0 }, 8, 4)).toBe('ne');
  });

  it('hitHandle skips side handles that would crowd a small frame', () => {
    const s = rect({ x: 0, y: 0, w: 10, h: 10 }, { width: 2 }); // 12 CSS px sides at zoom 1
    expect(hitHandle(s, { x: 4, y: -1 }, 8)).toBe('nw');
    expect(hitHandle(s, { x: 11, y: 5 }, 8)).not.toBe('e');
  });

  it('hitHandle on an arrow returns the endpoint, or the bend handle mid-chord', () => {
    const s = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(hitHandle(s, { x: 98, y: 2 }, 6)).toBe('b');
    expect(hitHandle(s, { x: 2, y: -2 }, 6)).toBe('a');
    expect(hitHandle(s, { x: 50, y: 0 }, 6)).toBe('mid');
    expect(hitHandle(s, { x: 25, y: 0 }, 6)).toBeNull();
    // A short arrow (< 48 CSS px on screen) shows no bend handle.
    const short = arrow({ x: 0, y: 0 }, { x: 40, y: 0 });
    expect(hitHandle(short, { x: 20, y: 0 }, 6)).toBeNull();
    expect(hitHandle(short, { x: 20, y: 0 }, 6, 2)).toBe('mid');
  });
});

describe('resizeBox', () => {
  const box = { x: 100, y: 100, w: 200, h: 100 }; // 100..300 × 100..200

  it('moves the dragged corner or edge', () => {
    expect(resizeBox(box, 'nw', { x: 50, y: 60 })).toEqual({ x: 50, y: 60, w: 250, h: 140 });
    expect(resizeBox(box, 'n', { x: 999, y: 80 })).toEqual({
      x: 100,
      y: 80,
      w: 200,
      h: 120,
    });
    expect(resizeBox(box, 'ne', { x: 350, y: 50 })).toEqual({
      x: 100,
      y: 50,
      w: 250,
      h: 150,
    });
    expect(resizeBox(box, 'e', { x: 400, y: -5 })).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 100,
    });
    expect(resizeBox(box, 'se', { x: 320, y: 230 })).toEqual({
      x: 100,
      y: 100,
      w: 220,
      h: 130,
    });
    expect(resizeBox(box, 's', { x: 0, y: 250 })).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 150,
    });
    expect(resizeBox(box, 'sw', { x: 80, y: 220 })).toEqual({
      x: 80,
      y: 100,
      w: 220,
      h: 120,
    });
    expect(resizeBox(box, 'w', { x: 90, y: 0 })).toEqual({ x: 90, y: 100, w: 210, h: 100 });
  });

  it('normalises when dragged past the opposite edge', () => {
    expect(resizeBox(box, 'e', { x: 40, y: 0 })).toEqual({ x: 40, y: 100, w: 60, h: 100 });
    expect(resizeBox(box, 'n', { x: 0, y: 260 })).toEqual({ x: 100, y: 200, w: 200, h: 60 });
    expect(resizeBox(box, 'nw', { x: 400, y: 300 })).toEqual({
      x: 300,
      y: 200,
      w: 100,
      h: 100,
    });
    const r = resizeBox(box, 'se', { x: 0, y: 0 });
    expect(r).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(r.w).toBeGreaterThanOrEqual(0);
    expect(r.h).toBeGreaterThanOrEqual(0);
  });

  it('keeps the aspect ratio on corners, anchored at the opposite corner', () => {
    const aspect = { aspect: true };
    // 2:1 box; the larger relative pull wins.
    expect(resizeBox(box, 'se', { x: 400, y: 150 }, aspect)).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 150,
    });
    expect(resizeBox(box, 'nw', { x: 250, y: 150 }, aspect)).toEqual({
      x: 200,
      y: 150,
      w: 100,
      h: 50,
    });
    expect(resizeBox(box, 'ne', { x: 320, y: 0 }, aspect)).toEqual({
      x: 100,
      y: 0,
      w: 400,
      h: 200,
    });
    expect(resizeBox(box, 'sw', { x: 0, y: 220 }, aspect)).toEqual({
      x: 0,
      y: 100,
      w: 300,
      h: 150,
    });
  });

  it('aspect still normalises past the anchor', () => {
    expect(resizeBox(box, 'se', { x: 50, y: 80 }, { aspect: true })).toEqual({
      x: 50,
      y: 75,
      w: 50,
      h: 25,
    });
  });

  it('aspect on edge handles scales the other side about the centre line', () => {
    expect(resizeBox(box, 'e', { x: 400, y: 0 }, { aspect: true })).toEqual({
      x: 100,
      y: 75,
      w: 300,
      h: 150,
    });
    expect(resizeBox(box, 's', { x: 0, y: 250 }, { aspect: true })).toEqual({
      x: 50,
      y: 100,
      w: 300,
      h: 150,
    });
  });

  it('center resizes symmetrically about the box centre', () => {
    expect(resizeBox(box, 'se', { x: 320, y: 230 }, { center: true })).toEqual({
      x: 80,
      y: 70,
      w: 240,
      h: 160,
    });
    expect(resizeBox(box, 'e', { x: 350, y: 0 }, { center: true })).toEqual({
      x: 50,
      y: 100,
      w: 300,
      h: 100,
    });
    expect(resizeBox(box, 'se', { x: 400, y: 150 }, { aspect: true, center: true })).toEqual({
      x: 0,
      y: 50,
      w: 400,
      h: 200,
    });
  });

  it('no options behaves like an empty options object', () => {
    expect(resizeBox(box, 'se', { x: 320, y: 230 }, {})).toEqual(
      resizeBox(box, 'se', { x: 320, y: 230 }),
    );
  });
});

describe('dragHandle', () => {
  it('arrow: moves the endpoint freely without shift', () => {
    const s = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    const r = dragHandle(s, 'b', { x: 100, y: 90 }) as ArrowShape;
    expect(r.b).toEqual({ x: 100, y: 90 });
    expect(r.a).toEqual(s.a);
  });

  it('arrow: shift snaps to 15° around the other end', () => {
    const s = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    const r = dragHandle(s, 'b', { x: 100, y: 90 }, { shift: true }) as ArrowShape; // ~42°
    expect(r.b.x).toBeCloseTo(r.b.y, 5); // 45°
    expect(dist(r.a, r.b)).toBeCloseTo(Math.hypot(100, 90), 5);

    const r15 = dragHandle(s, 'b', { x: 100, y: 30 }, { shift: true }) as ArrowShape; // ~16.7°
    expect((Math.atan2(r15.b.y, r15.b.x) * 180) / Math.PI).toBeCloseTo(15, 6);
    expect(dist(r15.a, r15.b)).toBeCloseTo(Math.hypot(100, 30), 5);

    const r2 = dragHandle(s, 'a', { x: 10, y: 5 }, { shift: true }) as ArrowShape;
    expect(r2.a.y).toBe(0); // horizontal relative to b
    expect(r2.b).toEqual(s.b);
  });

  it('arrow: without shift soft-snaps to the axes within 2°', () => {
    const s = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    const r = dragHandle(s, 'b', { x: 200, y: 5 }) as ArrowShape; // ~1.4°
    expect(r.b.y).toBe(0);
    expect(r.b.x).toBeCloseTo(Math.hypot(200, 5), 5);
    const v = dragHandle(s, 'b', { x: 3, y: 150 }) as ArrowShape; // ~1.1° off vertical
    expect(v.b.x).toBe(0);
    const free = dragHandle(s, 'b', { x: 200, y: 12 }) as ArrowShape; // ~3.4°
    expect(free.b).toEqual({ x: 200, y: 12 });
  });

  it('arrow: endpoint drags keep the bend', () => {
    const s = arrow({ x: 0, y: 0 }, { x: 100, y: 0 }, { bend: 40 });
    expect((dragHandle(s, 'b', { x: 150, y: 70 }) as ArrowShape).bend).toBe(40);
  });

  it('underline: free and pixel-rounded; soft-snaps near horizontal; shift snaps to 15°', () => {
    const s = underline({ x: 0, y: 50 }, { x: 100, y: 50 });
    // ~11.5°: no longer locked horizontal.
    const r = dragHandle(s, 'b', { x: 150.4, y: 80.6 }) as UnderlineShape;
    expect(r.b).toEqual({ x: 150, y: 81 });
    // ~0.8° off horizontal: soft-snaps flat (and rounds).
    const flat = dragHandle(s, 'b', { x: 150.4, y: 52 }) as UnderlineShape;
    expect(flat.b).toEqual({ x: 150, y: 50 });
    const r2 = dragHandle(s, 'a', { x: -20.6, y: 49 }) as UnderlineShape;
    expect(r2.a).toEqual({ x: -21, y: 50 });
    // Shift: 15° steps, then rounded.
    const r3 = dragHandle(s, 'b', { x: 150.4, y: 80.6 }, { shift: true }) as UnderlineShape;
    const len = Math.hypot(150.4, 30.6);
    const ang = (15 * Math.PI) / 180;
    expect(r3.b).toEqual({
      x: Math.round(len * Math.cos(ang)),
      y: Math.round(50 + len * Math.sin(ang)),
    });
  });

  it('underline: a slanted one stays free', () => {
    const s = underline({ x: 0, y: 50 }, { x: 100, y: 80 });
    const r = dragHandle(s, 'b', { x: 120, y: 90 }) as UnderlineShape;
    expect(r.b).toEqual({ x: 120, y: 90 });
  });

  it('highlight: free endpoints, not rounded, soft-snap near horizontal', () => {
    const s = highlight({ x: 0, y: 50 }, { x: 100, y: 50 });
    const r = dragHandle(s, 'b', { x: 150.5, y: 70 }) as HighlightShape;
    expect(r.b).toEqual({ x: 150.5, y: 70 });
    const flat = dragHandle(s, 'b', { x: 150.5, y: 51 }) as HighlightShape;
    expect(flat.b.y).toBe(50);
    expect(flat.b.x).toBeCloseTo(Math.hypot(150.5, 1), 5);
    expect(Number.isInteger(flat.b.x)).toBe(false);
  });

  it('rect: box handles resize, endpoint ids are ignored', () => {
    const s = rect({ x: 100, y: 100, w: 200, h: 100 });
    // The handle drags the outer frame edge; the box ends up half a stroke (5) inside it.
    const r = dragHandle(s, 'se', { x: 320, y: 230 }) as RectShape;
    expect(r.box).toEqual({ x: 100, y: 100, w: 215, h: 125 });
    expect(r.id).toBe(s.id);
    expect(dragHandle(s, 'a', { x: 0, y: 0 })).toBe(s);
    expect(dragHandle(s, 'mid', { x: 0, y: 0 })).toBe(s);
  });

  it('pen and text ignore handles they do not have', () => {
    const p = pen([
      [0, 0, 0.5],
      [10, 10, 0.5],
    ]);
    const t = text({ x: 0, y: 0 }, 'x');
    expect(dragHandle(p, 'a', { x: 5, y: 5 })).toBe(p);
    expect(dragHandle(p, 'e', { x: 50, y: 5 })).toBe(p); // pens only scale from corners
    expect(dragHandle(t, 'b', { x: 5, y: 5 })).toBe(t);
    expect(dragHandle(t, 'n', { x: 5, y: -50 })).toBe(t); // text has no n/s handles
  });

  it('does not mutate the input shape', () => {
    for (const s of [
      arrow({ x: 0, y: 0 }, { x: 100, y: 0 }),
      rect({ x: 0, y: 0, w: 50, h: 50 }, { rotation: 0.3 }),
      text({ x: 0, y: 0 }, 'hi'),
      pen([
        [0, 0, 0.5],
        [10, 10, 0.5],
      ]),
    ]) {
      const snap = structuredClone(s);
      const h = s.kind === 'arrow' ? 'b' : 'se';
      dragHandle(s, h, { x: 50, y: 70 }, { shift: true });
      dragHandle(
        s,
        s.kind === 'arrow' ? 'mid' : 'rot',
        { x: 50, y: 70 },
        { start: { x: 0, y: 0 } },
      );
      expect(s).toEqual(snap);
    }
  });
});

describe('translateShape', () => {
  const shapes: Shape[] = [
    arrow({ x: 0, y: 0 }, { x: 100, y: 0 }),
    rect({ x: 10, y: 20, w: 30, h: 40 }),
    underline({ x: 0, y: 5 }, { x: 50, y: 5 }),
    highlight({ x: 0, y: 5 }, { x: 50, y: 5 }),
    pen([
      [0, 0, 0.3],
      [10, 10, 0.7],
    ]),
    text({ x: 7, y: 8 }, 'hi'),
  ];

  it('moves every kind by (dx, dy) and leaves the original unchanged', () => {
    for (const s of shapes) {
      const before = structuredClone(s);
      const t = translateShape(s, 5, -3);
      expect(t).not.toBe(s);
      expect(s).toEqual(before);
      expect(t.id).toBe(s.id);
      expect(t.kind).toBe(s.kind);
      switch (t.kind) {
        case 'arrow':
        case 'underline':
        case 'highlight': {
          const o = s as typeof t;
          expect(t.a).toEqual({ x: o.a.x + 5, y: o.a.y - 3 });
          expect(t.b).toEqual({ x: o.b.x + 5, y: o.b.y - 3 });
          break;
        }
        case 'rect':
          expect(t.box).toEqual({ x: 15, y: 17, w: 30, h: 40 });
          break;
        case 'pen':
          expect(t.pts).toEqual([
            [5, -3, 0.3],
            [15, 7, 0.7],
          ]);
          break;
        case 'text':
          expect(t.at).toEqual({ x: 12, y: 5 });
          expect(t.text).toBe('hi');
          break;
      }
    }
  });

  it('returns the same shape for a zero move', () => {
    for (const s of shapes) expect(translateShape(s, 0, 0)).toBe(s);
  });
});

// ------------------------------------------------------------------------------- camera

describe('camera', () => {
  const viewport = { w: 1280, h: 800 };

  describe('fitWidthZoom', () => {
    it('fits a wide image inside the gutters', () => {
      const image = { w: 2800, h: 60000 }; // 1400 CSS at dpr 2
      const z = fitWidthZoom(image, viewport, 2);
      expect(z).toBeCloseTo((1280 - 2 * FIT_GUTTER_CSS) / 2800, 9);
      expect(image.w * z).toBeLessThanOrEqual(viewport.w - 2 * FIT_GUTTER_CSS + 1e-9);
    });

    it('never goes above 100% (1/dpr)', () => {
      expect(fitWidthZoom({ w: 1000, h: 4000 }, viewport, 2)).toBe(0.5);
      expect(fitWidthZoom({ w: 500, h: 4000 }, viewport, 1)).toBe(1);
      expect(fitWidthZoom({ w: 2400, h: 4000 }, viewport, 2)).toBe(0.5); // 1200 CSS fits
    });

    it('is ≤ 1/dpr for a range of sizes', () => {
      for (const dpr of [1, 1.5, 2, 3]) {
        for (const w of [10, 800, 1232 * dpr, 5000, 30000]) {
          const z = fitWidthZoom({ w, h: 1000 }, viewport, dpr);
          expect(z).toBeLessThanOrEqual(1 / dpr);
          expect(z).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('clampCamera', () => {
    it('centres a narrow image horizontally', () => {
      const image = { w: 1000, h: 60000 };
      const cam = clampCamera({ x: 123, y: 0, zoom: 0.5 }, image, viewport);
      const left = imageToScreen(cam, { x: 0, y: 0 }).x;
      const right = imageToScreen(cam, { x: image.w, y: 0 }).x;
      expect(left).toBeCloseTo(viewport.w - right, 9);
      expect(left).toBeGreaterThan(0);
    });

    it('clamps a wide image horizontally to the gutter', () => {
      const image = { w: 8000, h: 60000 };
      const zoom = 0.5;
      const g = FIT_GUTTER_CSS / zoom;
      expect(clampCamera({ x: -5000, y: 0, zoom }, image, viewport).x).toBe(-g);
      expect(clampCamera({ x: 99999, y: 0, zoom }, image, viewport).x).toBe(
        image.w + g - viewport.w / zoom,
      );
      expect(clampCamera({ x: 1000, y: 0, zoom }, image, viewport).x).toBe(1000);
    });

    it('clamps vertical scroll to a little above the top and past the bottom', () => {
      const image = { w: 2800, h: 60000 };
      const zoom = 0.44;
      const pad = SCROLL_PAD_CSS / zoom;
      expect(clampCamera({ x: 0, y: -10000, zoom }, image, viewport).y).toBeCloseTo(-pad, 9);
      expect(clampCamera({ x: 0, y: 1e9, zoom }, image, viewport).y).toBeCloseTo(
        image.h + pad - viewport.h / zoom,
        9,
      );
      expect(clampCamera({ x: 0, y: 30000, zoom }, image, viewport).y).toBe(30000);
    });

    it('centres a short image vertically', () => {
      const image = { w: 1000, h: 400 };
      const cam = clampCamera({ x: 0, y: 500, zoom: 0.5 }, image, viewport);
      const top = imageToScreen(cam, { x: 0, y: 0 }).y;
      const bottom = imageToScreen(cam, { x: 0, y: image.h }).y;
      expect(top).toBeCloseTo(viewport.h - bottom, 9);
    });

    it('keeps the zoom', () => {
      expect(clampCamera({ x: 0, y: 0, zoom: 0.37 }, { w: 3000, h: 9000 }, viewport).zoom).toBe(
        0.37,
      );
    });
  });

  describe('zoomAround', () => {
    it("keeps the anchor's image point fixed", () => {
      const cam = { x: 120, y: 4000, zoom: 0.44 };
      for (const anchor of [
        { x: 0, y: 0 },
        { x: 640, y: 400 },
        { x: 1100, y: 731 },
      ]) {
        for (const zoom of [0.05, 0.25, 1, 4]) {
          const before = screenToImage(cam, anchor);
          const next = zoomAround(cam, zoom, anchor);
          expect(next.zoom).toBe(zoom);
          const after = screenToImage(next, anchor);
          expect(after.x).toBeCloseTo(before.x, 6);
          expect(after.y).toBeCloseTo(before.y, 6);
        }
      }
    });
  });

  describe('screenToImage / imageToScreen', () => {
    it('round-trip', () => {
      const cam = { x: -54.5, y: 12345, zoom: 0.4321 };
      for (const p of [
        { x: 0, y: 0 },
        { x: 640.25, y: 399.75 },
        { x: -10, y: 2000 },
      ]) {
        const back = imageToScreen(cam, screenToImage(cam, p));
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    });

    it('maps the camera origin to the screen origin and scales by zoom', () => {
      const cam = { x: 100, y: 200, zoom: 0.5 };
      expect(imageToScreen(cam, { x: 100, y: 200 })).toEqual({ x: 0, y: 0 });
      expect(imageToScreen(cam, { x: 300, y: 400 })).toEqual({ x: 100, y: 100 });
      expect(screenToImage(cam, { x: 100, y: 100 })).toEqual({ x: 300, y: 400 });
    });
  });
});

// ------------------------------------------------------------------------------- known bugs

describe('regression: double-headed arrows ignore the head at `a`', () => {
  // draw.ts renders a second head at `a` when heads === 'both', but shapeBounds and hitShape only
  // consider the head at `b`.
  it('shapeBounds contains the back head triangle', () => {
    const s = arrow({ x: 100, y: 100 }, { x: 300, y: 160 }, { heads: 'both' });
    const back = arrowGeometry({ a: s.b, b: s.a, width: s.width }, 2);
    const r = shapeBounds(s, 2);
    for (const p of back.head) expect(pointInRect(p, r)).toBe(true);
  });

  it('hitShape hits inside the back head', () => {
    const s = arrow({ x: 100, y: 100 }, { x: 300, y: 100 }, { heads: 'both' });
    // 15 px off the line, 40 px from the `a` tip: inside the back head (half-width ~19.5 px).
    expect(hitShape(s, { x: 140, y: 115 }, 4, 2)).toBe(true);
  });
});
