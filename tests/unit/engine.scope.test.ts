import { describe, expect, it } from 'vitest';
import { shapesBounds } from '@/editor/engine/geometry';
import {
  COPY_MAX_AREA,
  type CopyPlanInput,
  type ExportPlan,
  fitScale,
  nativePlan,
  outputSize,
  planCopy,
  planDownload,
  planKey,
} from '@/editor/engine/scope';
import type { RectShape, Shape } from '@/shared/annotations';
import {
  AI_MAX_LONG_EDGE_CSS,
  CANVAS_MAX_AREA,
  CANVAS_MAX_SIDE,
  SMART_REGION_PAD_CSS,
} from '@/shared/limits';
import type { Rect, Size } from '@/shared/types';

// ------------------------------------------------------------------------------- factories

let seq = 0;
/** Rect shape with a 10 image-px stroke, so its bounds are the box inflated by 5. */
function rect(box: Rect, width = 10): RectShape {
  return {
    id: `r${++seq}`,
    kind: 'rect',
    color: '#FF3B30',
    shadow: true,
    box,
    width,
    fill: 'none',
  };
}

/** A CSS-sized page at `dpr`, as image px. */
const page = (cssW: number, cssH: number, dpr: number): Size => ({ w: cssW * dpr, h: cssH * dpr });

function plan(o: Partial<CopyPlanInput> & Pick<CopyPlanInput, 'image' | 'dpr'>): ExportPlan {
  return planCopy({
    request: 'default',
    shapes: [],
    view: { x: 0, y: 0, w: o.image.w, h: Math.min(o.image.h, 1600) },
    fullMaxCssHeight: AI_MAX_LONG_EDGE_CSS,
    resolution: 'css',
    // The v0.1 crop is the `tight` mode now; `fill` (the default) has its own tests below.
    scope: 'tight',
    ...o,
  });
}

function expectSaneRegion(p: ExportPlan, image: Size): void {
  const r = p.region;
  for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
  expect(r.x).toBe(0);
  expect(r.w).toBe(image.w);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.h).toBeGreaterThan(0);
  expect(r.y + r.h).toBeLessThanOrEqual(image.h);
  expect(p.size).toEqual(outputSize(r, p.scale));
  expect(p.size.w).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
  expect(p.size.h).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
  expect(p.size.w * p.size.h).toBeLessThanOrEqual(COPY_MAX_AREA);
}

// Realistic pages.
const TALL = page(1400, 30000, 2); // 2800 × 60000
const SHORT = page(1280, 2000, 2); // 2560 × 4000
const HUGE = page(1280, 70000, 2); // 2560 × 140000
const CAP2 = AI_MAX_LONG_EDGE_CSS * 2; // 5152
const PAD2 = SMART_REGION_PAD_CSS * 2; // 320

// ------------------------------------------------------------------------------- full

describe('planCopy: full', () => {
  it('copies the whole image when the page is ≤ fullMaxCssHeight CSS px tall', () => {
    const p = plan({ image: SHORT, dpr: 2, shapes: [rect({ x: 10, y: 10, w: 10, h: 10 })] });
    expect(p.outcome).toBe('full');
    expect(p.region).toEqual({ x: 0, y: 0, ...SHORT });
    expect(p.scale).toBe(0.5);
    expect(p.size).toEqual({ w: 1280, h: 2000 });
    expect(p.tall).toBe(false);
  });

  it('treats exactly 2576 CSS px as full and 2577 as tall', () => {
    expect(plan({ image: page(1280, 2576, 2), dpr: 2 }).outcome).toBe('full');
    expect(plan({ image: page(1280, 2577, 2), dpr: 2 }).outcome).toBe('viewport');
    expect(plan({ image: page(1280, 2576, 1), dpr: 1 }).outcome).toBe('full');
    expect(plan({ image: page(1280, 2577, 1), dpr: 1 }).outcome).toBe('viewport');
  });

  it('follows the fullMaxCssHeight setting', () => {
    const image = page(1280, 3000, 2);
    expect(plan({ image, dpr: 2, fullMaxCssHeight: 4000 }).outcome).toBe('full');
    expect(plan({ image, dpr: 2, fullMaxCssHeight: 2000 }).outcome).toBe('viewport');
  });

  it("request 'full' is always full, and tall when the long edge is > 2576 CSS px", () => {
    const shapes = [rect({ x: 100, y: 20000, w: 400, h: 200 })];
    const p = plan({ image: TALL, dpr: 2, request: 'full', shapes });
    expect(p.outcome).toBe('full');
    expect(p.region).toEqual({ x: 0, y: 0, ...TALL });
    expect(p.tall).toBe(true);
    expect(p.scale).toBe(0.5);
    expect(p.size).toEqual({ w: 1400, h: 30000 });

    const short = plan({ image: SHORT, dpr: 2, request: 'full' });
    expect(short.outcome).toBe('full');
    expect(short.tall).toBe(false);
  });

  it('flags a very wide page as tall too (long edge)', () => {
    const p = plan({ image: page(3000, 1000, 1), dpr: 1 });
    expect(p.outcome).toBe('full');
    expect(p.tall).toBe(true);
  });

  it("resolution 'native' copies at scale 1", () => {
    const p = plan({ image: SHORT, dpr: 2, resolution: 'native' });
    expect(p.scale).toBe(1);
    expect(p.size).toEqual(SHORT);
  });

  it('dpr 1: css and native are the same', () => {
    const image = page(1280, 2000, 1);
    expect(plan({ image, dpr: 1, resolution: 'css' }).scale).toBe(1);
    expect(plan({ image, dpr: 1, resolution: 'native' }).scale).toBe(1);
    expect(plan({ image, dpr: 1 }).size).toEqual(image);
  });

  it('downscales a native full copy of a tall page to fit the area guard', () => {
    const p = plan({ image: TALL, dpr: 2, request: 'full', resolution: 'native' });
    expect(p.scale).toBeLessThan(1);
    expect(p.scale).toBeCloseTo(Math.sqrt(COPY_MAX_AREA / (TALL.w * TALL.h)), 3);
    expect(p.region).toEqual({ x: 0, y: 0, ...TALL });
    expect(p.size).toEqual(outputSize(p.region, p.scale));
    // Within rounding of the guard (exact bound: see KNOWN BUG below).
    expect(p.size.w * p.size.h).toBeLessThanOrEqual(COPY_MAX_AREA * 1.001);
  });

  it('downscales a 1280×70000 page to fit CANVAS_MAX_SIDE', () => {
    for (const resolution of ['css', 'native'] as const) {
      const p = plan({ image: HUGE, dpr: 2, request: 'full', resolution });
      expect(p.outcome).toBe('full');
      expect(p.tall).toBe(true);
      expect(p.scale).toBeLessThan(0.5);
      expect(p.scale).toBeCloseTo(CANVAS_MAX_SIDE / HUGE.h, 5);
      expect(p.size.h).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
      expect(p.size.h).toBeGreaterThan(CANVAS_MAX_SIDE - 2);
      expectSaneRegion(p, HUGE);
    }
  });

  it('honours a custom maxArea', () => {
    const p = plan({ image: SHORT, dpr: 2, maxArea: 1_000_000 });
    expect(p.scale).toBeCloseTo(0.3125, 6);
    expect(p.size).toEqual({ w: 800, h: 1250 });
  });
});

// ------------------------------------------------------------------------------- smart

describe('planCopy: tight (tall page with shapes)', () => {
  it('pads the bbox by 160 CSS × dpr at full width', () => {
    // Bounds 19995..20205 (h 210): 10% is 21, so the 320 image-px pad wins.
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 200, y: 20000, w: 400, h: 200 })] });
    expect(p.outcome).toBe('smart');
    expect(p.region).toEqual({ x: 0, y: 19995 - PAD2, w: 2800, h: 210 + 2 * PAD2 });
    expect(p.tall).toBe(false);
    expect(p.scale).toBe(0.5);
    expect(p.size).toEqual({ w: 1400, h: 425 });
  });

  it('pads by 10% of the bbox height when that is larger', () => {
    // Bounds 9995..14005 (h 4010): 10% = 401 > 320.
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 0, y: 10000, w: 100, h: 4000 })] });
    expect(p.outcome).toBe('smart');
    expect(p.region).toEqual({ x: 0, y: 9995 - 401, w: 2800, h: 4010 + 802 });
    expect(p.region.h).toBeLessThanOrEqual(CAP2);
  });

  it('uses the union bbox of all shapes, including the stroke', () => {
    const shapes: Shape[] = [
      rect({ x: 0, y: 20000, w: 100, h: 100 }, 20),
      rect({ x: 2000, y: 21000, w: 100, h: 100 }, 20),
    ];
    const bbox = shapesBounds(shapes, 2);
    expect(bbox).toEqual({ x: -10, y: 19990, w: 2120, h: 1120 });
    const p = plan({ image: TALL, dpr: 2, shapes });
    expect(p.region).toEqual({ x: 0, y: 19990 - PAD2, w: 2800, h: 1120 + 2 * PAD2 });
  });

  it('clamps the padding at the top edge', () => {
    // Bounds 95..305: pad would start at -225.
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 0, y: 100, w: 100, h: 200 })] });
    expect(p.region).toEqual({ x: 0, y: 0, w: 2800, h: 305 + PAD2 });
    expectSaneRegion(p, TALL);
  });

  it('clamps the padding at the bottom edge', () => {
    // Bounds 59695..59905: pad would end at 60225.
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 0, y: 59700, w: 100, h: 200 })] });
    expect(p.region).toEqual({ x: 0, y: 59695 - PAD2, w: 2800, h: 60000 - (59695 - PAD2) });
    expectSaneRegion(p, TALL);
  });

  it('clamps shapes that stick out of the image', () => {
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 0, y: -500, w: 100, h: 600 })] });
    expect(p.region.y).toBe(0);
    expectSaneRegion(p, TALL);
  });

  it('caps the height at 2576 CSS × dpr, centred on the bbox', () => {
    // Bounds 9995..15005 (h 5010 ≤ 5152): padded it would be 6012 tall.
    const shapes = [
      rect({ x: 100, y: 10000, w: 100, h: 100 }),
      rect({ x: 100, y: 14900, w: 100, h: 100 }),
    ];
    const p = plan({ image: TALL, dpr: 2, shapes });
    expect(p.outcome).toBe('smart');
    expect(p.tall).toBe(false);
    expect(p.region.h).toBe(CAP2);
    expect(p.region.y + p.region.h / 2).toBe((9995 + 15005) / 2);
    expect(p.region.y).toBeLessThanOrEqual(9995);
    expect(p.region.y + p.region.h).toBeGreaterThanOrEqual(15005);
    expect(p.size).toEqual({ w: 1400, h: AI_MAX_LONG_EDGE_CSS });
  });

  it('a capped region near an edge shifts to stay inside the image at full height', () => {
    // Bounds 54995..59905: the capped window (54874..62026) would hang past the bottom.
    const shapes = [
      rect({ x: 0, y: 55000, w: 100, h: 100 }),
      rect({ x: 0, y: 59800, w: 100, h: 100 }),
    ];
    const p = plan({ image: TALL, dpr: 2, shapes });
    expect(p.region.h).toBe(CAP2);
    expect(p.region.y + p.region.h).toBe(TALL.h);
    expectSaneRegion(p, TALL);
  });

  it('copies the whole bbox and sets tall when the bbox alone exceeds the cap', () => {
    // Bounds 9995..18005 (h 8010 > 5152).
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 0, y: 10000, w: 100, h: 8000 })] });
    expect(p.outcome).toBe('smart');
    expect(p.tall).toBe(true);
    expect(p.region).toEqual({ x: 0, y: 9995, w: 2800, h: 8010 });
    expect(p.scale).toBe(0.5);
    expect(p.size).toEqual({ w: 1400, h: 4005 });
  });

  it('native resolution keeps scale 1 for a smart region', () => {
    const p = plan({
      image: TALL,
      dpr: 2,
      resolution: 'native',
      shapes: [rect({ x: 200, y: 20000, w: 400, h: 200 })],
    });
    expect(p.scale).toBe(1);
    expect(p.size).toEqual({ w: 2800, h: 850 });
  });

  it('dpr 1: pad is 160 and the cap is 2576', () => {
    const image = page(1280, 30000, 1);
    // Bounds 14997.5..15102.5 (stroke 5): padded 14837.5..15262.5 → whole px 14837..15263.
    const p = plan({ image, dpr: 1, shapes: [rect({ x: 0, y: 15000, w: 100, h: 100 }, 5)] });
    expect(p.outcome).toBe('smart');
    expect(p.region).toEqual({ x: 0, y: 14837, w: 1280, h: 426 });
    expect(p.scale).toBe(1);
    expect(p.size).toEqual({ w: 1280, h: 426 });

    const big = plan({
      image,
      dpr: 1,
      shapes: [rect({ x: 0, y: 10000, w: 10, h: 10 }), rect({ x: 0, y: 12300, w: 10, h: 10 })],
    });
    expect(big.region.h).toBe(AI_MAX_LONG_EDGE_CSS);
    expect(big.tall).toBe(false);
  });

  it('region values are integers inside the image for fractional shapes', () => {
    const offsets = [0.3, 17.77, 1234.5, 29_000.25, 59_990.9];
    for (const dpr of [1, 1.5, 2]) {
      const image = { w: Math.round(1400 * dpr), h: Math.round(30000 * dpr) };
      for (const y of offsets) {
        for (const h of [0.5, 333.3, 3000.7, 9000.1]) {
          const shapes = [rect({ x: 10.2, y: y * (dpr / 2), w: 50.5, h }, 7.3)];
          const p = plan({ image, dpr, shapes });
          expect(p.outcome).toBe('smart');
          expectSaneRegion(p, image);
        }
      }
    }
  });
});

// ------------------------------------------------------------------------------- from here

describe('planCopy: from here down (tall page, no shapes)', () => {
  it('copies from the top of the view down to the budget, at full width', () => {
    const view = { x: 400, y: 20000, w: 1000, h: 1600 };
    for (const scope of ['fill', 'tight'] as const) {
      const p = plan({ image: TALL, dpr: 2, view, scope });
      expect(p.outcome).toBe('viewport');
      expect(p.kind).toBe('fromHere');
      expect(p.region).toEqual({ x: 0, y: 20000, w: 2800, h: CAP2 });
      expect(p.tall).toBe(false);
      expect(p.size).toEqual({ w: 1400, h: AI_MAX_LONG_EDGE_CSS });
    }
  });

  it('starts at a whole px', () => {
    const p = plan({ image: TALL, dpr: 2, view: { x: 0, y: 20000.4, w: 2800, h: 1600 } });
    expect(p.region.y).toBe(20000);
    expectSaneRegion(p, TALL);
  });

  it('a view above the top starts at 0; near the bottom it shifts up to stay budget-tall', () => {
    const top = plan({ image: TALL, dpr: 2, view: { x: 0, y: -48, w: 2800, h: 1600 } });
    expect(top.region).toEqual({ x: 0, y: 0, w: 2800, h: CAP2 });
    const bottom = plan({ image: TALL, dpr: 2, view: { x: 0, y: 59000, w: 2800, h: 1600 } });
    expect(bottom.region).toEqual({ x: 0, y: 60000 - CAP2, w: 2800, h: CAP2 });
  });

  it('treats marks dragged wholly off the image as no marks (never a 1-px copy)', () => {
    for (const box of [
      { x: 0, y: -900, w: 100, h: 200 },
      { x: 0, y: 61000, w: 100, h: 200 },
      { x: 3200, y: 5000, w: 100, h: 200 },
    ]) {
      const p = plan({
        image: TALL,
        dpr: 2,
        shapes: [rect(box)],
        view: { x: 0, y: 1000, w: 2800, h: 1600 },
      });
      expect(p.kind).toBe('fromHere');
      expect(p.region.h).toBe(CAP2);
      expectSaneRegion(p, TALL);
    }
  });

  it('works on a 1280×70000 page and at dpr 1', () => {
    const p = plan({ image: HUGE, dpr: 2, view: { x: 0, y: 100000, w: 2560, h: 1626 } });
    expect(p.region).toEqual({ x: 0, y: 100000, w: 2560, h: CAP2 });
    expect(p.scale).toBe(0.5);
    expect(p.size).toEqual({ w: 1280, h: AI_MAX_LONG_EDGE_CSS });

    const d1 = plan({
      image: page(1280, 30000, 1),
      dpr: 1,
      view: { x: 0, y: 500, w: 1280, h: 813 },
    });
    expect(d1.region).toEqual({ x: 0, y: 500, w: 1280, h: AI_MAX_LONG_EDGE_CSS });
    expect(d1.scale).toBe(1);
  });

  it('may snap both edges by up to 48 CSS px', () => {
    const p = plan({ image: TALL, dpr: 2, view: { x: 0, y: 20000, w: 2800, h: 1600 } });
    expect(p.snap).toEqual({ top: 96, bottom: 96 });
    const top = plan({ image: TALL, dpr: 2, view: { x: 0, y: 0, w: 2800, h: 1600 } });
    expect(top.snap).toEqual({ top: 0, bottom: 96 });
  });
});

// ------------------------------------------------------------------------------- fill

describe('planCopy: fill (design §5, the default)', () => {
  const fill = (o: Partial<CopyPlanInput>) =>
    plan({ image: page(1440, 4348, 2), dpr: 2, scope: 'fill', ...o });
  const LMS = page(1440, 4348, 2); // 2880 × 8696

  it('takes the page from the top when the marks plus padding fit in the budget', () => {
    // Marks at CSS 260..420 → bounds 515..845 image px; + 320 pad = 1165 ≤ 5152.
    const p = fill({ shapes: [rect({ x: 100, y: 520, w: 400, h: 320 })] });
    expect(p.outcome).toBe('smart');
    expect(p.kind).toBe('fromTop');
    expect(p.region).toEqual({ x: 0, y: 0, w: 2880, h: CAP2 });
    expect(p.size).toEqual({ w: 1440, h: AI_MAX_LONG_EDGE_CSS });
    expect(p.tall).toBe(false);
    // Only the bottom edge may snap (the top is the page top), never into the marks.
    expect(p.snap).toEqual({ top: 0, bottom: 96 });
    expectSaneRegion(p, LMS);
  });

  it('otherwise a budget-tall window with 55% of the spare room above the marks', () => {
    // Bounds 6995..7305 (h 310), pad 320 → need 950; spare 4202 → 2311 above.
    const p = fill({ shapes: [rect({ x: 0, y: 7000, w: 100, h: 300 })] });
    expect(p.kind).toBe('aroundMarks');
    const top = 6995 - 320 - Math.round(0.55 * (CAP2 - 950));
    // That would end past the page (8696), so it shifts up to stay budget-tall.
    expect(top + CAP2).toBeGreaterThan(8696);
    expect(p.region).toEqual({ x: 0, y: 8696 - CAP2, w: 2880, h: CAP2 });

    const mid = plan({
      image: TALL,
      dpr: 2,
      scope: 'fill',
      shapes: [rect({ x: 0, y: 30000, w: 100, h: 300 })],
    });
    const want = 29995 - 320 - Math.round(0.55 * (CAP2 - 950));
    expect(mid.region).toEqual({ x: 0, y: want, w: 2800, h: CAP2 });
    expect(mid.kind).toBe('aroundMarks');
    // Both edges may snap by 48 CSS px; the marks are far from both.
    expect(mid.snap).toEqual({ top: 96, bottom: 96 });
    expectSaneRegion(mid, TALL);
  });

  it('marks taller than the budget: just the marks, tall, no snapping', () => {
    const p = fill({
      image: TALL,
      shapes: [rect({ x: 0, y: 1000, w: 100, h: 100 }), rect({ x: 0, y: 9000, w: 100, h: 100 })],
    });
    expect(p.tall).toBe(true);
    expect(p.kind).toBe('aroundMarks');
    expect(p.region).toEqual({ x: 0, y: 995, w: 2800, h: 9105 - 995 });
    expect(p.snap).toBeUndefined();
  });

  it('clamps marks partly off the image before planning', () => {
    const p = fill({ image: TALL, shapes: [rect({ x: 0, y: -400, w: 100, h: 500 })] });
    expect(p.kind).toBe('fromTop');
    expect(p.region).toEqual({ x: 0, y: 0, w: 2800, h: CAP2 });
  });

  it('a short page is still copied whole', () => {
    const p = fill({ image: SHORT, shapes: [rect({ x: 0, y: 100, w: 100, h: 100 })] });
    expect(p.kind).toBe('full');
    expect(p.region).toEqual({ x: 0, y: 0, w: 2560, h: 4000 });
    expect(p.snap).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------- scale

const ROUNDING_REGIONS: readonly Size[] = [
  { w: 2800, h: 60000 },
  { w: 2560, h: 140000 },
  { w: 3333, h: 77777 },
  { w: 65_536, h: 3 },
];

describe('fitScale / outputSize', () => {
  it('keeps the requested scale when within limits', () => {
    expect(fitScale({ w: 2800, h: 5152 }, 0.5, COPY_MAX_AREA)).toBe(0.5);
    expect(fitScale({ w: 2800, h: 5152 }, 1, COPY_MAX_AREA)).toBe(1);
  });

  it('shrinks to fit CANVAS_MAX_SIDE on either axis', () => {
    expect(fitScale({ w: 100_000, h: 10 }, 1, Number.POSITIVE_INFINITY)).toBeCloseTo(0.65535, 6);
    const s = fitScale({ w: 10, h: 140_000 }, 1, Number.POSITIVE_INFINITY);
    expect(Math.round(140_000 * s)).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
  });

  it('shrinks to fit the area guard', () => {
    const region = { w: 20_000, h: 20_000 };
    const s = fitScale(region, 1, CANVAS_MAX_AREA);
    const size = outputSize(region, s);
    expect(size.w * size.h).toBeLessThanOrEqual(CANVAS_MAX_AREA);
    expect(s).toBeCloseTo(Math.sqrt(CANVAS_MAX_AREA) / 20_000, 5);
  });

  it('never increases the scale', () => {
    for (const scale of [0.1, 0.5, 1]) {
      expect(fitScale({ w: 100, h: 100 }, scale, COPY_MAX_AREA)).toBeLessThanOrEqual(scale);
    }
  });

  it('rounded output never breaks the side limit', () => {
    for (const region of ROUNDING_REGIONS) {
      for (const maxArea of [COPY_MAX_AREA, CANVAS_MAX_AREA, 1_000_003]) {
        const size = outputSize(region, fitScale(region, 1, maxArea));
        expect(size.w).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
        expect(size.h).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
        expect(size.w * size.h).toBeLessThanOrEqual(maxArea * 1.001);
      }
    }
  });

  it('outputSize rounds and is at least 1×1', () => {
    expect(outputSize({ w: 2801, h: 851 }, 0.5)).toEqual({ w: 1401, h: 426 });
    expect(outputSize({ w: 1, h: 1 }, 0.01)).toEqual({ w: 1, h: 1 });
  });
});

// ------------------------------------------------------------------------------- download / key

describe('planDownload', () => {
  it('is always the full image at scale 1', () => {
    for (const [image, dpr] of [
      [TALL, 2],
      [SHORT, 2],
      [HUGE, 2],
      [page(1280, 3000, 1), 1],
    ] as const) {
      const p = planDownload(image, dpr);
      expect(p.outcome).toBe('full');
      expect(p.region).toEqual({ x: 0, y: 0, ...image });
      expect(p.scale).toBe(1);
      expect(p.size).toEqual(image);
    }
  });

  it('flags tall images', () => {
    expect(planDownload(TALL, 2).tall).toBe(true);
    expect(planDownload(SHORT, 2).tall).toBe(false);
  });
});

describe('nativePlan', () => {
  it('keeps the scope, switches to scale 1', () => {
    const p = plan({ image: TALL, dpr: 2, shapes: [rect({ x: 0, y: 20000, w: 400, h: 200 })] });
    const n = nativePlan(p);
    expect(n.region).toEqual(p.region);
    expect(n.outcome).toBe(p.outcome);
    expect(n.scale).toBe(1);
    expect(n.size).toEqual({ w: p.region.w, h: p.region.h });
  });
});

describe('planKey', () => {
  const region = { x: 0, y: 100, w: 2800, h: 850 };

  it('is stable for the same inputs', () => {
    expect(planKey(3, { region, scale: 0.5 })).toBe(
      planKey(3, { region: { ...region }, scale: 0.5 }),
    );
  });

  it('differs per rev, region and scale', () => {
    const k = planKey(3, { region, scale: 0.5 });
    expect(planKey(4, { region, scale: 0.5 })).not.toBe(k);
    expect(planKey(3, { region: { ...region, y: 101 }, scale: 0.5 })).not.toBe(k);
    expect(planKey(3, { region: { ...region, h: 851 }, scale: 0.5 })).not.toBe(k);
    expect(planKey(3, { region: { ...region, w: 2799 }, scale: 0.5 })).not.toBe(k);
    expect(planKey(3, { region: { ...region, x: 1 }, scale: 0.5 })).not.toBe(k);
    expect(planKey(3, { region, scale: 1 })).not.toBe(k);
  });
});

// ------------------------------------------------------------------------------- known bugs

describe('regression: capped region can exceed the cap by 1 px', () => {
  // When the centre of the bbox is fractional, placeSpan floors the top and ceils the bottom of a
  // window that is exactly `cap` tall, giving `cap + 1`. With `resolution: 'css'` the output is then
  // 2577 px tall (round(5153 × 0.5)), one more than the AI long edge.
  it('capped smart region is at most 2576 × dpr tall', () => {
    // Bounds 0(-5 clamped)..5005: mid 2502.5, so the capped window is -73.5..5078.5.
    const shapes = [rect({ x: 0, y: 0, w: 100, h: 100 }), rect({ x: 0, y: 4900, w: 100, h: 100 })];
    const p = plan({ image: TALL, dpr: 2, shapes });
    expect(p.region.h).toBeLessThanOrEqual(CAP2);
    expect(p.size.h).toBeLessThanOrEqual(AI_MAX_LONG_EDGE_CSS);
  });

  it('capped smart region mid-page is at most 2576 × dpr tall', () => {
    // Bounds 9995..15006: mid 12500.5.
    const shapes = [
      rect({ x: 0, y: 10000, w: 100, h: 100 }),
      rect({ x: 0, y: 14900, w: 100, h: 101 }),
    ];
    const p = plan({ image: TALL, dpr: 2, shapes });
    expect(p.region.h).toBeLessThanOrEqual(CAP2);
  });

  it('capped from-here region is at most 2576 × dpr tall', () => {
    const p = plan({ image: TALL, dpr: 2, view: { x: 0, y: 10000.5, w: 2800, h: 20000 } });
    expect(p.region.h).toBeLessThanOrEqual(CAP2);
  });
});

describe('regression: area-limited scale can round the output over maxArea', () => {
  // fitScale floors the scale to 6 decimals, but outputSize rounds w and h independently, so the
  // area can still land above maxArea by up to ~(w + h) / 2 px. E.g. a native full copy of a
  // 2800×60000 image gives 2503×53630 = 134,233,387 px > COPY_MAX_AREA (134,217,728).
  it('native full copy of a 1400×30000 CSS page stays within COPY_MAX_AREA', () => {
    const p = plan({ image: TALL, dpr: 2, request: 'full', resolution: 'native' });
    expect(p.size.w * p.size.h).toBeLessThanOrEqual(COPY_MAX_AREA);
  });

  it('outputSize(region, fitScale(region, 1, maxArea)) is within maxArea', () => {
    for (const region of ROUNDING_REGIONS) {
      for (const maxArea of [COPY_MAX_AREA, CANVAS_MAX_AREA, 1_000_003]) {
        const size = outputSize(region, fitScale(region, 1, maxArea));
        expect(size.w * size.h).toBeLessThanOrEqual(maxArea);
      }
    }
  });
});
