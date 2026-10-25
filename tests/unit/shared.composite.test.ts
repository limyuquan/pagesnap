import { describe, expect, it } from 'vitest';
import { intersect, partsInRegion } from '@/shared/composite';
import type { BaseLayout } from '@/shared/types';

// Two 100×60 slices; the second overlaps the first by 10 px (placed at y=50).
const layout: BaseLayout = {
  size: { w: 100, h: 110 },
  background: '#fff',
  fills: [],
  parts: [
    { slice: 0, src: { x: 0, y: 0, w: 100, h: 60 }, dest: { x: 0, y: 0 } },
    { slice: 1, src: { x: 0, y: 0, w: 100, h: 60 }, dest: { x: 0, y: 50 } },
  ],
};

describe('intersect', () => {
  it('returns the overlap or null', () => {
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
      x: 5,
      y: 5,
      w: 5,
      h: 5,
    });
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBeNull();
  });
});

describe('partsInRegion', () => {
  it('clips parts to the region and maps src accordingly, in draw order', () => {
    const parts = partsInRegion(layout, { x: 0, y: 40, w: 100, h: 30 });
    expect(parts).toEqual([
      { slice: 0, src: { x: 0, y: 40, w: 100, h: 20 }, dest: { x: 0, y: 40, w: 100, h: 20 } },
      { slice: 1, src: { x: 0, y: 0, w: 100, h: 20 }, dest: { x: 0, y: 50, w: 100, h: 20 } },
    ]);
  });

  it('skips parts outside the region', () => {
    expect(partsInRegion(layout, { x: 0, y: 0, w: 100, h: 40 }).map((p) => p.slice)).toEqual([0]);
  });
});
