import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  HISTORY_LIMIT,
  type History,
  redo,
  undo,
} from '@/editor/engine/history';
import { type AnnotationDoc, emptyDoc, type RectShape, type Shape } from '@/shared/annotations';

// ------------------------------------------------------------------------------- factories

let seq = 0;
function rect(x = 0): RectShape {
  return {
    id: `r${++seq}`,
    kind: 'rect',
    color: '#FF3B30',
    shadow: true,
    box: { x, y: 0, w: 10, h: 10 },
    width: 10,
    fill: 'none',
  };
}

function doc(): AnnotationDoc {
  return emptyDoc('session-1', { w: 2800, h: 60000, dpr: 2 });
}

const withShapes = (d: AnnotationDoc, shapes: readonly Shape[]): AnnotationDoc => ({
  ...d,
  shapes,
});

/** Commit `n` docs, each adding one shape. */
function commitN(h: History, n: number): History {
  let out = h;
  for (let i = 0; i < n; i++)
    out = commit(out, withShapes(out.present, [...out.present.shapes, rect(i)]), 1000 + i);
  return out;
}

// ------------------------------------------------------------------------------- tests

describe('createHistory', () => {
  it('starts with empty stacks', () => {
    const d = doc();
    const h = createHistory(d);
    expect(h.present).toBe(d);
    expect(h.past).toEqual([]);
    expect(h.future).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});

describe('commit', () => {
  it('pushes the present onto past, bumps rev and stamps updatedAt', () => {
    const h0 = createHistory(doc());
    const s = rect();
    const h1 = commit(h0, withShapes(h0.present, [s]), 4242);
    expect(h1.past).toEqual([h0.present]);
    expect(h1.past[0]).toBe(h0.present);
    expect(h1.present.shapes).toEqual([s]);
    expect(h1.present.rev).toBe(h0.present.rev + 1);
    expect(h1.present.updatedAt).toBe(4242);
    expect(h1.future).toEqual([]);
  });

  it('ignores the rev on the incoming doc', () => {
    const h0 = createHistory(doc());
    const h1 = commit(h0, { ...h0.present, shapes: [rect()], rev: 99 }, 1);
    expect(h1.present.rev).toBe(1);
  });

  it('clears the future', () => {
    let h = commitN(createHistory(doc()), 3);
    h = undo(undo(h, 1), 2);
    expect(h.future).toHaveLength(2);
    const next = commit(h, withShapes(h.present, [rect(500)]), 3);
    expect(next.future).toEqual([]);
    expect(canRedo(next)).toBe(false);
    expect(next.past).toHaveLength(2);
  });

  it('is a no-op for the present itself', () => {
    const h = commitN(createHistory(doc()), 1);
    expect(commit(h, h.present, 5)).toBe(h);
  });

  it('is a no-op when the shapes are identical', () => {
    const h = commitN(createHistory(doc()), 1);
    expect(commit(h, { ...h.present }, 5)).toBe(h);
    expect(commit(h, { ...h.present, updatedAt: 1 }, 5)).toBe(h);
  });

  it('does not mutate the previous history', () => {
    const h0 = commitN(createHistory(doc()), 2);
    const snapshot = { past: [...h0.past], present: h0.present, future: [...h0.future] };
    commit(h0, withShapes(h0.present, []), 9);
    undo(h0, 9);
    expect(h0.past).toEqual(snapshot.past);
    expect(h0.present).toBe(snapshot.present);
    expect(h0.future).toEqual(snapshot.future);
  });

  it(`caps past at HISTORY_LIMIT (${HISTORY_LIMIT}), dropping the oldest`, () => {
    const h = commitN(createHistory(doc()), HISTORY_LIMIT + 50);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]?.rev).toBe(50);
    expect(h.past.at(-1)?.rev).toBe(HISTORY_LIMIT + 49);
    expect(h.present.rev).toBe(HISTORY_LIMIT + 50);
  });

  it('lets you undo exactly HISTORY_LIMIT steps', () => {
    let h = commitN(createHistory(doc()), HISTORY_LIMIT + 10);
    let steps = 0;
    while (canUndo(h)) {
      h = undo(h, 0);
      steps++;
    }
    expect(steps).toBe(HISTORY_LIMIT);
    expect(h.present.shapes).toHaveLength(10);
    expect(h.future).toHaveLength(HISTORY_LIMIT);
  });
});

describe('undo / redo', () => {
  it('restore the previous and next shapes', () => {
    const h0 = createHistory(doc());
    const a = rect(1);
    const b = rect(2);
    const h1 = commit(h0, withShapes(h0.present, [a]), 1);
    const h2 = commit(h1, withShapes(h1.present, [a, b]), 2);

    const u1 = undo(h2, 3);
    expect(u1.present.shapes).toEqual([a]);
    expect(u1.future[0]).toBe(h2.present);
    const u2 = undo(u1, 4);
    expect(u2.present.shapes).toEqual([]);
    expect(canUndo(u2)).toBe(false);
    expect(canRedo(u2)).toBe(true);

    const r1 = redo(u2, 5);
    expect(r1.present.shapes).toEqual([a]);
    const r2 = redo(r1, 6);
    expect(r2.present.shapes).toEqual([a, b]);
    expect(canRedo(r2)).toBe(false);
    expect(canUndo(r2)).toBe(true);
  });

  it('keep rev strictly increasing and stamp updatedAt', () => {
    let h = createHistory(doc());
    const revs = [h.present.rev];
    const step = (next: History) => {
      h = next;
      revs.push(h.present.rev);
    };
    step(commit(h, withShapes(h.present, [rect()]), 1));
    step(commit(h, withShapes(h.present, [...h.present.shapes, rect()]), 2));
    step(undo(h, 3));
    expect(h.present.updatedAt).toBe(3);
    step(undo(h, 4));
    step(redo(h, 5));
    expect(h.present.updatedAt).toBe(5);
    step(commit(h, withShapes(h.present, [rect()]), 6));
    step(undo(h, 7));
    step(redo(h, 8));
    expect(revs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1] ?? 0);
  });

  it('an undone state gets a new rev, never the old one', () => {
    const h1 = commitN(createHistory(doc()), 1);
    const h2 = commitN(h1, 1);
    const u = undo(h2, 0);
    expect(u.present.shapes).toBe(h1.present.shapes);
    expect(u.present.rev).not.toBe(h1.present.rev);
  });

  it('are no-ops at the ends', () => {
    const h0 = createHistory(doc());
    expect(undo(h0)).toBe(h0);
    expect(redo(h0)).toBe(h0);
    const h1 = commitN(h0, 2);
    expect(redo(h1)).toBe(h1);
    const bottom = undo(undo(h1, 1), 2);
    expect(undo(bottom, 3)).toBe(bottom);
    const top = redo(redo(bottom, 4), 5);
    expect(redo(top, 6)).toBe(top);
  });

  it('redo respects HISTORY_LIMIT too', () => {
    let h = commitN(createHistory(doc()), HISTORY_LIMIT);
    h = undo(h, 0);
    h = commit(h, withShapes(h.present, []), 0); // drops the future
    h = commitN(h, 1);
    h = undo(h, 0);
    h = redo(h, 0);
    expect(h.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
  });
});

describe('canUndo / canRedo', () => {
  it('track the stacks', () => {
    let h = createHistory(doc());
    expect([canUndo(h), canRedo(h)]).toEqual([false, false]);
    h = commitN(h, 1);
    expect([canUndo(h), canRedo(h)]).toEqual([true, false]);
    h = undo(h);
    expect([canUndo(h), canRedo(h)]).toEqual([false, true]);
    h = redo(h);
    expect([canUndo(h), canRedo(h)]).toEqual([true, false]);
  });
});
