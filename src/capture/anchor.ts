/**
 * Seam anchoring maths (owner: A). Pure: unit-tested in Node and used by the page agent.
 *
 * Before scrolling to the next row the agent records where some content near the bottom of the
 * slice it just shot sits (text glyphs and small elements, in the scroll target's content
 * coordinates). After scrolling and settling it measures them again. If content above the seam
 * grew or shrank meanwhile, they all moved by the same amount `d`: the next slice is scrolled by
 * `d` more and placed `d` higher in the output, so the seam stays continuous.
 */

/** Movements within this many CSS px of each other count as the same shift. */
export const SHIFT_TOLERANCE = 1;

/** Shifts smaller than this are layout noise (sub-pixel rounding), not content moving. */
export const MIN_SHIFT = 0.75;

export interface ShiftConsensus {
  /** Agreed shift, CSS px (0 when nothing moved or there is no agreement). */
  d: number;
  /** Anchors measured (lost ones excluded). */
  n: number;
  /** A clear majority agrees on `d` (always true when nothing moved). */
  reliable: boolean;
  /** Some anchor moved by at least `MIN_SHIFT`. */
  moved: boolean;
}

/**
 * Agree on one shift from per-anchor movements (`NaN` = anchor lost). The largest group of
 * movements within `SHIFT_TOLERANCE` of each other wins if it holds at least 60% of the anchors.
 */
export function shiftConsensus(shifts: readonly number[]): ShiftConsensus {
  const v = shifts.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { d: 0, n: 0, reliable: false, moved: false };
  const moved = v.some((s) => Math.abs(s) >= MIN_SHIFT);
  let best = { from: 0, to: 0 };
  for (let i = 0, j = 0; i < n; i++) {
    while ((v[i] ?? 0) - (v[j] ?? 0) > SHIFT_TOLERANCE * 2) j++;
    if (i - j > best.to - best.from) best = { from: j, to: i };
  }
  const size = best.to - best.from + 1;
  const group = v.slice(best.from, best.to + 1);
  const median = group[Math.floor(group.length / 2)] ?? 0;
  const reliable = size >= Math.max(1, Math.ceil(0.6 * n));
  if (!reliable) return { d: 0, n, reliable, moved };
  const d = Math.abs(median) < MIN_SHIFT ? 0 : median;
  return { d, n, reliable, moved };
}
