/**
 * Seam anchors (owner: A): content positions near the bottom of the viewport, in the scroll
 * target's content coordinates, so the agent can tell whether content above a seam moved between
 * two slices (see `capture/anchor.ts`).
 *
 * An anchor is preferably one text glyph (found with `caretRangeFromPoint`): a glyph moves with
 * everything above it, including growth inside the block it belongs to. Small elements are the
 * fallback where there is no text.
 */
import { type ShiftConsensus, shiftConsensus } from '@/capture/anchor';
import type { Rect } from '@/shared/types';
import type { ScrollTarget } from './target';

export interface Anchor {
  node: Node;
  /** Character offset for text anchors; -1 for element anchors. */
  offset: number;
  /** Content-space y of the glyph or element top when recorded, CSS px. */
  y: number;
  /** Probe row it was found on, 0 = closest to the bottom edge (the seam). */
  row: number;
  /** Element anchors: content-space y of the probe point, and the element's height. */
  probe?: number;
  h?: number;
}

/** Probe points per row, and the rows' distances above the bottom edge of the scroll area. */
const PROBE_XS = [0.08, 0.27, 0.5, 0.73, 0.92];
const PROBE_ROWS = [4, 12, 24, 40];
/** A caret found further than this from its probe is a different line: ignore it. */
const MAX_CARET_DISTANCE = 48;

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

/** Viewport y of content y 0 of `target`, CSS px (so content y = viewport y - origin). */
function originY(target: ScrollTarget): number {
  const el = target.el;
  if (!el) return -scrollY;
  return el.getBoundingClientRect().top + el.clientTop - (el as HTMLElement).scrollTop;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as CaretDoc;
  try {
    if (d.caretRangeFromPoint) {
      const r = d.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    const p = d.caretPositionFromPoint?.(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  } catch {
    return null;
  }
}

function glyphTop(node: Node, offset: number): number | null {
  if (!(node instanceof Text) || node.length === 0) return null;
  const i = Math.max(0, Math.min(offset, node.length - 1));
  const range = document.createRange();
  range.setStart(node, i);
  range.setEnd(node, i + 1);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return rect.height > 0 ? rect.top : null;
}

/**
 * How far the content at the anchor moved (`origin` = viewport y of content y 0). A glyph moves
 * with its line. An element anchor follows its top while the probe point is still inside it; if
 * it shrank so the probe point is now past its end (a placeholder that collapsed), the probe maps
 * to its new end.
 */
function shiftOf(a: Anchor, origin: number): number {
  if (!a.node.isConnected) return Number.NaN;
  if (a.offset >= 0) {
    const top = glyphTop(a.node, a.offset);
    return top == null ? Number.NaN : top - origin - a.y;
  }
  const r = (a.node as Element).getBoundingClientRect();
  if (r.height <= 0 && r.width <= 0) return Number.NaN;
  const top = r.top - origin;
  const probe = a.probe ?? a.y;
  if (probe - a.y <= r.height) return top - a.y;
  // Collapsed past the probe: the old seam now maps to the element's new end, so the next slice
  // starts with whatever follows it (and nothing above it is repeated).
  return top + r.height - probe;
}

/**
 * Record anchors along the bottom edge of `area` (viewport CSS px). `excluded(el)` rejects nodes
 * inside floating elements, whose position doesn't follow the content.
 */
export function collectAnchors(
  target: ScrollTarget,
  area: Rect,
  excluded: (el: Element) => boolean,
): Anchor[] {
  if (area.w < 1 || area.h < 1) return [];
  const origin = originY(target);
  const out: Anchor[] = [];
  const seen = new Set<Node>();
  const accept = (el: Element | null): boolean => {
    if (!el || el === document.documentElement || el === document.body || el === target.el) {
      return false;
    }
    if (target.el && !target.el.contains(el)) return false;
    return !excluded(el);
  };
  for (const [row, dy] of PROBE_ROWS.entries()) {
    const y = area.y + area.h - dy;
    if (y < area.y) continue;
    for (const fx of PROBE_XS) {
      const x = area.x + area.w * fx;
      const caret = caretAt(x, y);
      if (caret && !seen.has(caret.node) && accept(caret.node.parentElement)) {
        const top = glyphTop(caret.node, caret.offset);
        if (top != null && Math.abs(top - y) <= MAX_CARET_DISTANCE) {
          seen.add(caret.node);
          out.push({ node: caret.node, offset: caret.offset, y: top - origin, row });
          continue;
        }
      }
      // No text here: the smallest element under the point that isn't a page-sized block.
      for (const el of document.elementsFromPoint(x, y)) {
        if (!accept(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height <= 0 || r.height > area.h) continue;
        if (!seen.has(el)) {
          seen.add(el);
          out.push({
            node: el,
            offset: -1,
            y: r.top - origin,
            probe: y - origin,
            h: r.height,
            row,
          });
        }
        break;
      }
    }
  }
  return out;
}

/** How far each anchor moved since it was recorded, CSS px (`NaN` if it's gone). */
export function anchorShifts(target: ScrollTarget, anchors: readonly Anchor[]): number[] {
  const origin = originY(target);
  return anchors.map((a) => shiftOf(a, origin));
}

/** Shift every anchor's recorded position by `d` (after a correction was applied). */
export function rebase(anchors: readonly Anchor[], d: number): Anchor[] {
  return anchors.map((a) => {
    const next = { ...a, y: a.y + d };
    if (a.probe != null) next.probe = a.probe + d;
    return next;
  });
}

/**
 * How far the content at the seam moved. If anchors at different heights disagree, the change
 * happened between them, and the ones nearest the seam (the lowest probe row that has any) are
 * the ones that describe it; otherwise every anchor votes.
 */
export function seamShift(target: ScrollTarget, anchors: readonly Anchor[]): ShiftConsensus {
  const shifts = anchorShifts(target, anchors);
  const all = shiftConsensus(shifts);
  if (all.reliable && !all.moved) return all;
  for (let row = 0; row < PROBE_ROWS.length; row++) {
    const mine = shifts.filter((_, i) => anchors[i]?.row === row);
    const c = shiftConsensus(mine);
    if (c.n === 0) continue;
    if (c.reliable) return { ...c, n: all.n, moved: all.moved };
    break;
  }
  return all;
}
