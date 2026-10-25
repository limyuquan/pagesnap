import { describe, expect, it } from 'vitest';
import { buildLayout, colorRuns } from '@/capture/layout';
import { partsInRegion } from '@/shared/composite';
import type { BaseLayout, SliceMeta, TargetGeometry } from '@/shared/types';

function docSlices(ys: number[], xs: number[], view = { w: 1280, h: 800 }, scale = 2): SliceMeta[] {
  const range = { x0: xs[0] ?? 0, x1: xs.at(-1) ?? 0, y0: ys[0] ?? 0, y1: ys.at(-1) ?? 0 };
  const target: TargetGeometry = {
    kind: 'document',
    clientRect: { x: 0, y: 0, ...view },
    range,
    content: { w: range.x1 + view.w, h: range.y1 + view.h },
  };
  const out: SliceMeta[] = [];
  for (const y of ys) {
    for (const x of xs) {
      out.push({
        index: out.length,
        scroll: { x, y },
        bitmap: { w: Math.round(view.w * scale), h: Math.round(view.h * scale) },
        target,
        capturedAt: 0,
      });
    }
  }
  return out;
}

/** Every image pixel row/column covered by some part (checks a column at x and a row at y). */
function coverage(layout: BaseLayout, x: number, y: number) {
  const { w, h } = layout.size;
  const col = partsInRegion(layout, { x, y: 0, w: 1, h });
  const row = partsInRegion(layout, { x: 0, y, w, h: 1 });
  const covered = (parts: typeof col, axis: 'x' | 'y', len: number) => {
    const hit = new Uint8Array(len);
    for (const p of parts)
      for (let i = p.dest[axis]; i < p.dest[axis] + (axis === 'x' ? p.dest.w : p.dest.h); i++)
        hit[i] = 1;
    return hit.every((v) => v === 1);
  };
  return { column: covered(col, 'y', h), row: covered(row, 'x', w) };
}

describe('buildLayout (document target)', () => {
  it('places slices at round(scroll * scale), last one bottom-aligned, covering the image', () => {
    const slices = docSlices([0, 798, 1596, 2000], [0]);
    const { css, image, layout } = buildLayout({ slices, scale: 2 });
    expect(css).toEqual({ w: 1280, h: 2800 });
    expect(image).toEqual({ w: 2560, h: 5600 });
    expect(layout.parts.map((p) => p.dest.y)).toEqual([0, 1596, 3192, 4000]);
    expect(layout.parts.every((p) => p.src.w === 2560 && p.src.h === 1600)).toBe(true);
    expect(coverage(layout, 100, 5599)).toEqual({ column: true, row: true });
  });

  it('fractional scales never leave a gap at the bottom edge', () => {
    // 125% scaling: 1023 CSS px wide → 1279 px bitmaps; fractional scroll offsets.
    const scale = 1279 / 1023;
    const slices = docSlices([0, 650.4, 1300.8, 1777.6], [0], { w: 1023, h: 652.8 }, scale);
    const { image, layout } = buildLayout({ slices, scale });
    expect(image.h).toBe(Math.round((1777.6 + 652.8) * scale));
    const last = layout.parts.at(-1);
    expect((last?.dest.y ?? 0) + (last?.src.h ?? 0)).toBe(image.h);
    expect(coverage(layout, 10, image.h - 1).column).toBe(true);
  });

  it('lays out columns row-major and right-aligns the last column', () => {
    const slices = docSlices([0, 811, 1187], [0, 1278, 1720], { w: 1280, h: 813 }, 1);
    const { css, image, layout } = buildLayout({ slices, scale: 1 });
    expect(css).toEqual({ w: 3000, h: 2000 });
    expect(image).toEqual({ w: 3000, h: 2000 });
    expect(layout.parts.slice(0, 3).map((p) => p.dest)).toEqual([
      { x: 0, y: 0 },
      { x: 1278, y: 0 },
      { x: 1720, y: 0 },
    ]);
    expect(coverage(layout, 2999, 1999)).toEqual({ column: true, row: true });
  });

  it('a single slice is the viewport', () => {
    const { css, image, layout } = buildLayout({ slices: docSlices([0], [0]), scale: 2 });
    expect(css).toEqual({ w: 1280, h: 800 });
    expect(image).toEqual({ w: 2560, h: 1600 });
    expect(layout.parts).toHaveLength(1);
  });

  it('is empty without slices', () => {
    expect(buildLayout({ slices: [], scale: 1 }).image).toEqual({ w: 0, h: 0 });
  });
});

describe('buildLayout (inner scroller, expand in place)', () => {
  const R = { x: 264, y: 63, w: 1016, h: 700 };
  const view = { w: 1280, h: 813 };
  const target = (y1: number): TargetGeometry => ({
    kind: 'element',
    clientRect: R,
    range: { x0: 0, x1: 0, y0: 0, y1 },
    content: { w: R.w, h: y1 + R.h },
  });
  const slices = (ys: number[], scale: number): SliceMeta[] =>
    ys.map((y, index) => ({
      index,
      scroll: { x: 0, y },
      bitmap: { w: view.w * scale, h: view.h * scale },
      target: target(ys.at(-1) ?? 0),
      capturedAt: 0,
    }));

  it('stitches the shell once and the scroller from every slice', () => {
    const scale = 2;
    const s = slices([0, 698, 1396, 1800], scale);
    const sideRuns = {
      left: [
        { x0: 0, x1: 168, color: '#394b58' },
        { x0: 168, x1: 528, color: '#ffffff' },
      ],
      right: [],
    };
    const { css, image, layout } = buildLayout({ slices: s, scale, sideRuns });
    expect(css).toEqual({ w: 1280, h: 813 + 1800 });
    expect(image).toEqual({ w: 2560, h: (813 + 1800) * 2 });
    const [top, ...rest] = layout.parts;
    // Slice 0 down to the scroller's bottom edge.
    expect(top).toEqual({ slice: 0, src: { x: 0, y: 0, w: 2560, h: 1526 }, dest: { x: 0, y: 0 } });
    // Scroller crops of later slices.
    expect(rest.slice(0, 3).map((p) => [p.slice, p.src, p.dest])).toEqual([
      [1, { x: 528, y: 126, w: 2032, h: 1400 }, { x: 528, y: 126 + 1396 }],
      [2, { x: 528, y: 126, w: 2032, h: 1400 }, { x: 528, y: 126 + 2792 }],
      [3, { x: 528, y: 126, w: 2032, h: 1400 }, { x: 528, y: 126 + 3600 }],
    ]);
    // Band below the scroller from the last slice, shifted down.
    expect(rest[3]).toEqual({
      slice: 3,
      src: { x: 0, y: 1526, w: 2560, h: 100 },
      dest: { x: 0, y: 5126 },
    });
    // Side rails continued with fills.
    expect(layout.fills).toEqual([
      { rect: { x: 0, y: 1526, w: 168, h: 3600 }, color: '#394b58' },
      { rect: { x: 168, y: 1526, w: 360, h: 3600 }, color: '#ffffff' },
    ]);
    expect(coverage(layout, 1000, image.h - 1).column).toBe(true);
  });
});

describe('colorRuns', () => {
  const row = (colors: [number, number, number, number][]) => {
    const out = new Uint8ClampedArray(colors.reduce((n, [, , , w]) => n + w * 4, 0));
    let i = 0;
    for (const [r, g, b, w] of colors) {
      for (let k = 0; k < w; k++) out.set([r, g, b, 255], i++ * 4);
    }
    return { data: out, width: i };
  };

  it('splits a rail row into colour runs and absorbs text specks', () => {
    const { data, width } = row([
      [0x39, 0x4b, 0x58, 84],
      [255, 255, 255, 60],
      [0, 0, 0, 2], // a speck of text
      [255, 255, 255, 118],
    ]);
    expect(colorRuns(data, width)).toEqual([
      { x0: 0, x1: 84, color: '#394b58' },
      { x0: 84, x1: 264, color: '#ffffff' },
    ]);
  });

  it('offsets runs and tolerates anti-aliasing noise', () => {
    const { data, width } = row([
      [250, 250, 250, 10],
      [255, 255, 255, 10],
    ]);
    expect(colorRuns(data, width, 100)).toEqual([{ x0: 100, x1: 120, color: '#fafafa' }]);
  });
});
