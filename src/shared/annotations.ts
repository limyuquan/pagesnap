/**
 * Annotation document model (docs/research/03-annotation-editor.md §7.1, trimmed to the v0.1 tools).
 *
 * Rules:
 * - All coordinates and sizes are **image px** (see `types.ts`). Tool defaults are defined in CSS px
 *   and multiplied by `doc.image.dpr` when a shape is created.
 * - Docs and shapes are immutable. Every edit produces a new object; never mutate in place.
 *   (Renderers may cache derived data, e.g. a `Path2D`, in a `WeakMap<Shape, ...>`.)
 * - `shapes` array order is z-order. Highlights are drawn in their own pass below the other shapes.
 * - Selection, camera and the active tool are editor state, not part of the doc.
 * - Persisted in the `docs` IDB store, keyed by `sessionId`. Bump `DOC_VERSION` and add a step to
 *   `migrateDoc` for any breaking change.
 */
import type { Point, Rect, SessionId, Size } from './types';

/**
 * v2 (2026-10-25): optional `rotation` on rect, text and pen; arrows may be bent (`bend`). A v1 doc
 * is a valid v2 doc (absent rotation = 0), so the migration only re-stamps `v`.
 */
export const DOC_VERSION = 2;

/** Shape id, `newId()` from `ids.ts`. */
export type ShapeId = string;

/** A colour as a CSS hex string, e.g. `#FF3B30`. */
export type Color = string;

interface ShapeBase {
  id: ShapeId;
  color: Color;
  /** Subtle contrast shadow behind the stroke/text (on by default). */
  shadow: boolean;
}

/** Arrow from `a` to `b`, straight or bent into a quadratic curve. */
export interface ArrowShape extends ShapeBase {
  kind: 'arrow';
  a: Point;
  b: Point;
  /** Stroke width, image px. */
  width: number;
  /**
   * Signed offset of the quadratic control point from the chord midpoint, along the chord's
   * normal `(-uy, ux)` (u = unit a→b), image px. 0 = straight. The curve itself passes through
   * the midpoint moved by `bend / 2`, which is where the bend handle sits.
   */
  bend: number;
  heads: 'end' | 'both';
}

export interface RectShape extends ShapeBase {
  kind: 'rect';
  /** Normalised: `w` and `h` are >= 0. */
  box: Rect;
  /** Stroke width, image px. */
  width: number;
  /** `tint` = the same colour at 0.15 alpha. */
  fill: 'none' | 'tint' | 'solid';
  /** Radians, clockwise on screen, about the box centre. Absent = 0 (v2). */
  rotation?: number;
}

/** Underline from `a` to `b` (horizontal unless drawn with Shift). Square caps. */
export interface UnderlineShape extends ShapeBase {
  kind: 'underline';
  a: Point;
  b: Point;
  width: number;
}

/** Highlighter band along the line `a`→`b`, drawn with `multiply`, butt caps, below other shapes. */
export interface HighlightShape extends ShapeBase {
  kind: 'highlight';
  a: Point;
  b: Point;
  /** Band thickness, image px. */
  thickness: number;
  /** 0..1, default 0.6 (`DEFAULT_HIGHLIGHT_OPACITY`). */
  opacity: number;
}

/** Freehand stroke rendered with perfect-freehand. */
export interface PenShape extends ShapeBase {
  kind: 'pen';
  /** Raw input points `[x, y, pressure]`, image px. Pressure 0..1 (0.5 when unknown). */
  pts: readonly (readonly [number, number, number])[];
  /** perfect-freehand `size`, image px. */
  size: number;
  /** Marker mode (Shift + highlighter): multiply blend, no thinning. */
  marker: boolean;
  /** Radians, clockwise on screen, about the centre of the points' bounds. Absent = 0 (v2). */
  rotation?: number;
}

export interface TextShape extends ShapeBase {
  kind: 'text';
  /** Top-left of the first line box, image px. */
  at: Point;
  text: string;
  /** Font size, image px. */
  size: number;
  weight: 400 | 700;
  /** Wrap width, image px (the text box is then this wide). Absent = no wrapping. */
  maxW?: number;
  /** `outline` = white outline behind the glyphs (default); `label` = filled box behind. */
  style: 'outline' | 'label';
  /** Radians, clockwise on screen, about the centre of the text box. Absent = 0 (v2). */
  rotation?: number;
}

export type Shape = ArrowShape | RectShape | UnderlineShape | HighlightShape | PenShape | TextShape;

export type ShapeKind = Shape['kind'];

export const SHAPE_KINDS: readonly ShapeKind[] = [
  'arrow',
  'rect',
  'underline',
  'highlight',
  'pen',
  'text',
];

export interface AnnotationDoc {
  v: typeof DOC_VERSION;
  sessionId: SessionId;
  /** Bumps by 1 on every committed change. Export-cache key and autosave trigger. */
  rev: number;
  /** Copied from the session so the doc renders on its own. */
  image: Size & { dpr: number };
  shapes: readonly Shape[];
  /** Reserved for the v0.2 crop tool. Always `null` in v0.1. Image px. */
  crop: Rect | null;
  /** Epoch ms of the last commit. */
  updatedAt: number;
}

export function emptyDoc(sessionId: SessionId, image: Size & { dpr: number }): AnnotationDoc {
  return {
    v: DOC_VERSION,
    sessionId,
    rev: 0,
    image: { w: image.w, h: image.h, dpr: image.dpr },
    shapes: [],
    crop: null,
    updatedAt: Date.now(),
  };
}

/**
 * Upgrade a stored doc to the current version. Returns `null` for anything unrecognisable, so the
 * caller can fall back to `emptyDoc`. Add one step per version bump: `if (v === 1) raw = v1to2(raw)`.
 */
export function migrateDoc(raw: unknown): AnnotationDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const doc = raw as Partial<Omit<AnnotationDoc, 'v'>> & { v?: unknown };
  if (!Array.isArray(doc.shapes) || typeof doc.sessionId !== 'string') return null;
  // v1 → v2: rotation and bend are optional/additive, so a v1 doc is already a valid v2 doc.
  if (doc.v === 1) return { ...(doc as AnnotationDoc), v: DOC_VERSION };
  if (doc.v === DOC_VERSION) return doc as AnnotationDoc;
  return null;
}

/** Colour palette, keys 1–8 in the editor. Index 0 (red) is the default. */
export const PALETTE: readonly Color[] = [
  '#FF3B30', // red
  '#FF9500', // orange
  '#FFCC00', // yellow (also the highlighter's)
  '#34C759', // green
  '#0A84FF', // blue
  '#AF52DE', // purple
  '#111111', // black
  '#FFFFFF', // white
];

export const DEFAULT_COLOR: Color = '#FF3B30';
/** Highlighter: `#FFCC00` at 0.6, multiply (design review §3: reads apart from a page's own marks). */
export const DEFAULT_HIGHLIGHT_COLOR: Color = '#FFCC00';
export const DEFAULT_HIGHLIGHT_OPACITY = 0.6;

/**
 * Default size per tool in **CSS px** (multiply by `dpr` at creation). Meaning per kind:
 * arrow/rect/underline: stroke width; highlight: band thickness; pen: perfect-freehand size;
 * text: font size. Sized to survive AI downscaling (03 §5).
 */
export const DEFAULT_SIZES_CSS: Readonly<Record<ShapeKind, number>> = {
  arrow: 6,
  rect: 5,
  underline: 5,
  highlight: 22,
  pen: 6,
  text: 26,
};

/** `[` / `]` step through these sizes (CSS px). Each tool snaps to the nearest step. */
export const SIZE_STEPS_CSS: Readonly<Record<ShapeKind, readonly number[]>> = {
  arrow: [2, 3, 4, 6, 8, 12, 16],
  rect: [2, 3, 4, 5, 8, 12, 16],
  underline: [2, 3, 4, 5, 8, 12, 16],
  highlight: [10, 14, 18, 22, 28, 36, 48],
  pen: [2, 3, 4, 6, 8, 12, 16],
  text: [14, 18, 22, 26, 32, 40, 56],
};
