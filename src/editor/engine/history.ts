/**
 * Undo/redo over immutable doc snapshots (03 §7.2). One entry per finished gesture: callers build
 * the next doc locally during a drag and `commit` once on pointer-up.
 */
import type { AnnotationDoc } from '@/shared/annotations';

export const HISTORY_LIMIT = 200;

export interface History {
  past: readonly AnnotationDoc[];
  present: AnnotationDoc;
  future: readonly AnnotationDoc[];
}

export function createHistory(present: AnnotationDoc): History {
  return { past: [], present, future: [] };
}

/**
 * Push `next` as the new present. Its `rev` becomes `present.rev + 1` and `updatedAt` is stamped.
 * Committing the present itself (or a doc with identical shapes) is a no-op.
 */
export function commit(h: History, next: AnnotationDoc, now = Date.now()): History {
  if (next === h.present || next.shapes === h.present.shapes) return h;
  return {
    past: [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: { ...next, rev: h.present.rev + 1, updatedAt: now },
    future: [],
  };
}

/**
 * Undo/redo keep `rev` strictly increasing (the doc gets a fresh rev), so export caches and
 * autosave keyed by rev never confuse an undone state with a later one.
 */
export function undo(h: History, now = Date.now()): History {
  const prev = h.past.at(-1);
  if (!prev) return h;
  return {
    past: h.past.slice(0, -1),
    present: { ...prev, rev: h.present.rev + 1, updatedAt: now },
    future: [h.present, ...h.future],
  };
}

export function redo(h: History, now = Date.now()): History {
  const next = h.future[0];
  if (!next) return h;
  return {
    past: [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: { ...next, rev: h.present.rev + 1, updatedAt: now },
    future: h.future.slice(1),
  };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;
