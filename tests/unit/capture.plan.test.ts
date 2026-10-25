import { describe, expect, it } from 'vitest';
import {
  capRange,
  chooseScrollTarget,
  classifyFloat,
  estimateSlices,
  floatVisible,
  nextOffset,
  planAxis,
  type ScrollerCandidate,
} from '@/capture/plan';

const view = { w: 1280, h: 800 };
const viewRect = { x: 0, y: 0, w: 1280, h: 800 };

describe('planAxis', () => {
  it('is a single position when there is nothing to scroll', () => {
    expect(planAxis(0, 0, 800)).toEqual([0]);
    expect(planAxis(0, -5, 800)).toEqual([0]);
  });

  it('steps by view - 2 and aligns the last position to the end', () => {
    expect(planAxis(0, 2000, 800)).toEqual([0, 798, 1596, 2000]);
    // Exact fit: no duplicate final position.
    expect(planAxis(0, 1596, 800)).toEqual([0, 798, 1596]);
  });

  it('covers every pixel with at least the overlap', () => {
    const ys = planAxis(0, 7187, 813);
    for (let i = 1; i < ys.length; i++) {
      const prev = ys[i - 1] ?? 0;
      expect((ys[i] ?? 0) - prev).toBeLessThanOrEqual(811);
      expect(ys[i]).toBeGreaterThan(prev);
    }
    expect(ys.at(-1)).toBe(7187);
    expect(ys).toHaveLength(10);
  });

  it('handles reverse (negative) ranges', () => {
    expect(planAxis(-1500, 0, 800)).toEqual([-1500, -702, 0]);
  });

  it('nextOffset never passes the end', () => {
    expect(nextOffset(1900, 2000, 800)).toBe(2000);
    expect(nextOffset(0, 2000, 800, 0)).toBe(800);
  });
});

describe('capRange', () => {
  it('leaves short ranges alone', () => {
    expect(capRange(0, 5000, 800, 80_000)).toEqual({ y1: 5000, truncated: false });
  });

  it('caps the output height at maxCss', () => {
    expect(capRange(0, 100_000, 800, 80_000)).toEqual({ y1: 79_200, truncated: true });
  });

  it('caps the number of slices, accounting for columns', () => {
    const { y1, truncated } = capRange(0, 1_000_000, 800, 10_000_000, 250, 2);
    expect(truncated).toBe(true);
    expect(planAxis(0, y1, 800).length * 2).toBeLessThanOrEqual(250);
    expect(planAxis(0, y1, 800).length).toBe(125);
  });

  it('estimates rows × columns', () => {
    expect(estimateSlices({ x0: 0, x1: 1720, y0: 0, y1: 1187 }, { w: 1280, h: 813 })).toBe(9);
  });
});

function cand(
  visible: { x: number; y: number; w: number; h: number },
  overflow: number,
  center = false,
) {
  return { ref: visible, visible, overflow, containsCenter: center } satisfies ScrollerCandidate;
}

describe('chooseScrollTarget', () => {
  it('uses the document when it scrolls and no big inner scroller beats it', () => {
    const side = cand({ x: 0, y: 0, w: 300, h: 800 }, 3000);
    expect(chooseScrollTarget(5000, [side], view)).toBeNull();
  });

  it('picks the main inner scroller of an app shell (Canvas, Gmail, chat UIs)', () => {
    const main = cand({ x: 264, y: 63, w: 1016, h: 737 }, 3500, true);
    const nav = cand({ x: 84, y: 63, w: 180, h: 737 }, 200);
    expect(chooseScrollTarget(0, [nav, main], view)?.ref).toBe(main.ref);
  });

  it('prefers a big inner scroller with more overflow than a slightly scrolling document', () => {
    const main = cand({ x: 0, y: 60, w: 1280, h: 740 }, 9000, true);
    expect(chooseScrollTarget(400, [main], view)?.ref).toBe(main.ref);
    expect(chooseScrollTarget(12_000, [main], view)).toBeNull();
  });

  it('ignores small or barely scrolling boxes (dropdowns, code blocks)', () => {
    const dropdown = cand({ x: 10, y: 10, w: 200, h: 300 }, 2000);
    const tiny = cand({ x: 0, y: 0, w: 1280, h: 800 }, 20);
    expect(chooseScrollTarget(0, [dropdown, tiny], view)).toBeNull();
  });

  it('boosts the scroller under the viewport centre', () => {
    const a = cand({ x: 0, y: 0, w: 640, h: 800 }, 3000);
    const b = cand({ x: 640, y: 0, w: 640, h: 800 }, 3000, true);
    expect(chooseScrollTarget(0, [a, b], view)?.ref).toBe(b.ref);
  });
});

describe('classifyFloat', () => {
  it('classifies headers, footers, bubbles and shells for a document target', () => {
    expect(classifyFloat({ x: 0, y: 0, w: 1280, h: 56 }, view, viewRect)).toBe('top');
    expect(classifyFloat({ x: 0, y: 736, w: 1280, h: 64 }, view, viewRect)).toBe('bottom');
    expect(classifyFloat({ x: 1196, y: 652, w: 60, h: 60 }, view, viewRect)).toBe('bottom');
    expect(classifyFloat({ x: 0, y: 0, w: 1280, h: 800 }, view, viewRect)).toBe('shell');
    expect(
      classifyFloat({ x: 0, y: 0, w: 84, h: 800 }, view, viewRect, { containsTarget: true }),
    ).toBe('shell');
  });

  it('skips invisible or off-screen elements', () => {
    expect(classifyFloat({ x: 0, y: 0, w: 0, h: 50 }, view, viewRect)).toBe('skip');
    expect(classifyFloat({ x: 0, y: 900, w: 100, h: 50 }, view, viewRect)).toBe('skip');
    expect(classifyFloat({ x: -500, y: 0, w: 400, h: 50 }, view, viewRect)).toBe('skip');
  });

  it('for inner scrollers, only floats over the scroller matter, relative to its centre', () => {
    const scroller = { x: 264, y: 63, w: 1016, h: 737 };
    const opts = { elementTarget: true };
    // The fixed global nav sits beside the scroller: it can't repeat.
    expect(classifyFloat({ x: 0, y: 0, w: 84, h: 800 }, view, scroller, opts)).toBe('skip');
    expect(classifyFloat({ x: 1196, y: 700, w: 60, h: 60 }, view, scroller, opts)).toBe('bottom');
    expect(classifyFloat({ x: 264, y: 63, w: 1016, h: 40 }, view, scroller, opts)).toBe('top');
  });
});

describe('floatVisible', () => {
  it('smart: top floats in the first slice only, bottom floats in the last only', () => {
    expect(floatVisible('top', 'smart', 0, false)).toBe(true);
    expect(floatVisible('top', 'smart', 1, false)).toBe(false);
    expect(floatVisible('bottom', 'smart', 0, false)).toBe(false);
    expect(floatVisible('bottom', 'smart', 5, true)).toBe(true);
    // A single-slice page shows both.
    expect(floatVisible('top', 'smart', 0, true)).toBe(true);
    expect(floatVisible('bottom', 'smart', 0, true)).toBe(true);
  });

  it('remove hides and keep shows everywhere', () => {
    expect(floatVisible('top', 'remove', 0, true)).toBe(false);
    expect(floatVisible('bottom', 'keep', 3, false)).toBe(true);
  });
});
