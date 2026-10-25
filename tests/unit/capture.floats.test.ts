import { describe, expect, it } from 'vitest';
import { classifyFloat, floatVisible } from '@/capture/plan';

const view = { w: 1280, h: 813 };
const viewRect = { x: 0, y: 0, w: 1280, h: 813 };

describe('classifyFloat: side floats', () => {
  it('a full-height left sidebar centred on the viewport is side, not bottom (w3schools I-2)', () => {
    expect(classifyFloat({ x: 0, y: 0, w: 230, h: 813 }, view, viewRect)).toBe('side');
    // Its fixed inner menu, below the header.
    expect(classifyFloat({ x: 0, y: 56, w: 230, h: 757 }, view, viewRect)).toBe('side');
  });

  it('right rails and sidebars taller than the viewport are side', () => {
    // w3schools' sticky ad rail: top 100, 767 tall (runs past the bottom).
    expect(classifyFloat({ x: 1113, y: 100, w: 159, h: 767 }, view, viewRect)).toBe('side');
    expect(classifyFloat({ x: 1050, y: 0, w: 230, h: 2000 }, view, viewRect)).toBe('side');
    // Not docked to the edge (centred layout), but entirely left of the centre line.
    expect(classifyFloat({ x: 200, y: 64, w: 240, h: 749 }, view, viewRect)).toBe('side');
  });

  it('headers, footers, bubbles and overlays are unchanged', () => {
    // The w3schools nav as the union of the 0 px wrapper's children (I-1).
    expect(classifyFloat({ x: 0, y: 0, w: 1280, h: 89 }, view, viewRect)).toBe('top');
    expect(classifyFloat({ x: 0, y: 749, w: 1280, h: 64 }, view, viewRect)).toBe('bottom');
    expect(classifyFloat({ x: 1196, y: 729, w: 60, h: 60 }, view, viewRect)).toBe('bottom');
    expect(classifyFloat({ x: 0, y: 0, w: 1280, h: 813 }, view, viewRect)).toBe('shell');
    expect(classifyFloat({ x: 140, y: 50, w: 1000, h: 700 }, view, viewRect)).toBe('shell');
  });

  it('tall panels that stop short of the bottom, or are too wide, are not side', () => {
    // An open chat panel (bottom: 20px).
    expect(classifyFloat({ x: 900, y: 93, w: 360, h: 700 }, view, viewRect)).toBe('bottom');
    // A floating table of contents (top: 100px; max-height: calc(100vh - 200px)).
    expect(classifyFloat({ x: 1000, y: 90, w: 260, h: 613 }, view, viewRect)).toBe('top');
    // Flush to the bottom but not tall enough (a docked chat window).
    expect(classifyFloat({ x: 980, y: 363, w: 300, h: 450 }, view, viewRect)).toBe('bottom');
    // A bottom sheet across most of the width.
    expect(classifyFloat({ x: 0, y: 300, w: 1280, h: 513 }, view, viewRect)).toBe('shell');
    // Narrow-ish but straddling the centre line.
    expect(classifyFloat({ x: 500, y: 0, w: 300, h: 813 }, view, viewRect)).toBe('bottom');
    // Wider than 40% of the viewport (and under half its area).
    expect(classifyFloat({ x: 0, y: 200, w: 600, h: 613 }, view, viewRect)).toBe('bottom');
  });

  it('for inner scrollers, a rail beside the scroller is skipped and one over it is side', () => {
    const scroller = { x: 264, y: 103, w: 1016, h: 710 };
    const opts = { elementTarget: true };
    expect(classifyFloat({ x: 0, y: 0, w: 84, h: 813 }, view, scroller, opts)).toBe('skip');
    expect(classifyFloat({ x: 1050, y: 103, w: 230, h: 710 }, view, scroller, opts)).toBe('side');
    expect(classifyFloat({ x: 264, y: 63, w: 1016, h: 40 }, view, scroller, opts)).toBe('skip');
    expect(classifyFloat({ x: 264, y: 103, w: 1016, h: 40 }, view, scroller, opts)).toBe('top');
  });

  it('the container of the scroll target stays a shell', () => {
    const opts = { containsTarget: true };
    expect(classifyFloat({ x: 0, y: 0, w: 230, h: 813 }, view, viewRect, opts)).toBe('shell');
  });
});

describe('floatVisible: side floats', () => {
  it('are shown in every slice in every mode', () => {
    for (const mode of ['smart', 'remove', 'keep'] as const) {
      expect(floatVisible('side', mode, 0, false)).toBe(true);
      expect(floatVisible('side', mode, 3, false)).toBe(true);
      expect(floatVisible('side', mode, 7, true)).toBe(true);
    }
  });

  it('top and bottom floats keep their rules', () => {
    expect(floatVisible('top', 'smart', 0, false)).toBe(true);
    expect(floatVisible('top', 'smart', 2, true)).toBe(false);
    expect(floatVisible('bottom', 'smart', 2, false)).toBe(false);
    expect(floatVisible('bottom', 'smart', 2, true)).toBe(true);
    expect(floatVisible('top', 'remove', 0, false)).toBe(false);
    expect(floatVisible('bottom', 'remove', 2, true)).toBe(false);
  });
});
