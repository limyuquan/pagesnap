/**
 * What `Cmd+C` / `Shift+Cmd+C` / Download put out (CONTRACTS §4.9). Pure maths, unit-tested.
 *
 * - `copy('full')`: the whole image. Outcome `full`.
 * - `copy('default')`: the whole image when the page is at most `fullMaxCssHeight` CSS px tall.
 *   Otherwise (design review §5), with marks, `fill` mode uses the whole AI budget
 *   (`AI_MAX_LONG_EDGE_CSS * dpr` image px): from the top of the page when the marks plus their
 *   padding fit there, else a budget-tall window with 55% of the spare room above the marks;
 *   `tight` mode crops to the marks plus padding. Without marks: from the top of the view down,
 *   up to the budget. All of them use the full image width.
 * - Copies are at 1 output px per CSS px when `resolution` is `css`, native otherwise. Download
 *   is always native.
 */
import type { Shape } from '@/shared/annotations';
import {
  AI_MAX_LONG_EDGE_CSS,
  CANVAS_MAX_AREA,
  CANVAS_MAX_SIDE,
  SMART_REGION_PAD_CSS,
} from '@/shared/limits';
import type { Rect, Size } from '@/shared/types';
import { shapesBounds } from './geometry';

export type CopyRequestKind = 'default' | 'full';
export type CopyOutcomeKind = 'full' | 'smart' | 'viewport';
/**
 * What a copy contains, as the user would put it (design review §5):
 * - `full`: the whole page;
 * - `fromTop`: the top of the page down to the AI budget, marks included;
 * - `aroundMarks`: a window of the page around the marks;
 * - `fromHere`: no marks, so the page from the top of the current view down.
 */
export type CopyScopeKind = 'full' | 'fromTop' | 'aroundMarks' | 'fromHere';
/** `settings.editor.copyScope`: fill the AI budget (`fill`), or crop tightly around the marks. */
export type CopyScopeMode = 'fill' | 'tight';

export interface ExportPlan {
  outcome: CopyOutcomeKind;
  kind: CopyScopeKind;
  /** Source region, whole image px. */
  region: Rect;
  /** Output px per image px. */
  scale: number;
  /** Output pixel size. */
  size: Size;
  /** Long edge above `AI_MAX_LONG_EDGE_CSS` CSS px: an AI model will shrink it noticeably. */
  tall: boolean;
  /**
   * How far (image px) the export may move each edge inward to land the cut on a blank row
   * (design §5.4). 0 = keep the edge. Never reaches into the marks.
   */
  snap?: { top: number; bottom: number };
}

export interface CopyPlanInput {
  request: CopyRequestKind;
  image: Size;
  dpr: number;
  shapes: readonly Shape[];
  /** The currently visible image rect (the no-marks scope starts at its top). */
  view: Rect;
  /** `settings.copy.fullMaxCssHeight`. */
  fullMaxCssHeight: number;
  /** `settings.copy.resolution`. */
  resolution: 'css' | 'native';
  /** `settings.editor.copyScope`. Default `fill`. */
  scope?: CopyScopeMode;
  /** Max output pixels for a clipboard image (memory guard). Default `CANVAS_MAX_AREA / 2`. */
  maxArea?: number;
}

/** Edge snapping looks this far (CSS px) for a blank row, and never moves an edge further. */
export const SNAP_MAX_CSS = 48;

/** Largest output a copy may produce; beyond that it's downscaled to fit. */
export const COPY_MAX_AREA = CANVAS_MAX_AREA / 2;

/**
 * Snap a vertical span to whole image px inside `[0, imageH]`, shifting (not shrinking) it when it
 * sticks out so its height is kept where possible.
 */
function placeSpan(y0: number, y1: number, imageH: number, maxH = imageH): [number, number] {
  let a = Math.floor(y0);
  let b = Math.ceil(y1);
  if (b - a > maxH) {
    // Fractional ends would round outwards past the cap: keep exactly `maxH`, centred.
    a = Math.round((y0 + y1) / 2 - maxH / 2);
    b = a + maxH;
  }
  const h = Math.min(b - a, imageH);
  if (a < 0) {
    a = 0;
    b = h;
  }
  if (b > imageH) {
    b = imageH;
    a = imageH - h;
  }
  return [Math.max(0, a), Math.min(imageH, b)];
}

/** Largest scale ≤ `scale` at which `region` fits the canvas side and `maxArea` limits. */
export function fitScale(region: Size, scale: number, maxArea: number): number {
  let s = scale;
  s = Math.min(s, CANVAS_MAX_SIDE / Math.max(1, region.w), CANVAS_MAX_SIDE / Math.max(1, region.h));
  const area = region.w * region.h * s * s;
  if (area > maxArea) s *= Math.sqrt(maxArea / area);
  // `outputSize` rounds each side; shrink until the rounded size respects every limit.
  const fits = (k: number) => {
    const o = outputSize(region, k);
    return o.w <= CANVAS_MAX_SIDE && o.h <= CANVAS_MAX_SIDE && o.w * o.h <= maxArea;
  };
  while (s > 1e-6 && !fits(s)) s *= 0.99995;
  return s;
}

export function outputSize(region: Size, scale: number): Size {
  return {
    w: Math.max(1, Math.round(region.w * scale)),
    h: Math.max(1, Math.round(region.h * scale)),
  };
}

function isTall(region: Size, dpr: number): boolean {
  return Math.max(region.w, region.h) / dpr > AI_MAX_LONG_EDGE_CSS + 0.5;
}

/** Union bbox of the shapes, clipped to the image; null when nothing is on the image. */
export function marksOnImage(shapes: readonly Shape[], image: Size, dpr: number): Rect | null {
  const b = shapesBounds(shapes, dpr);
  if (!b) return null;
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(image.w, b.x + b.w);
  const y1 = Math.min(image.h, b.y + b.h);
  // Wholly off the image (dragged past an edge): there's nothing to copy around.
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Copy plan for `copy(request)`. */
export function planCopy(input: CopyPlanInput): ExportPlan {
  const { image, dpr } = input;
  const full: Rect = { x: 0, y: 0, w: image.w, h: image.h };
  const cssH = image.h / dpr;
  const cap = AI_MAX_LONG_EDGE_CSS * dpr;
  const capPx = Math.floor(cap);
  const baseScale = input.resolution === 'css' ? 1 / dpr : 1;
  const maxArea = input.maxArea ?? COPY_MAX_AREA;
  const mode: CopyScopeMode = input.scope === 'tight' ? 'tight' : 'fill';
  const snapMax = Math.round(SNAP_MAX_CSS * dpr);

  let outcome: CopyOutcomeKind;
  let kind: CopyScopeKind;
  let region: Rect;
  let tall = false;
  let bbox: Rect | null = null;

  if (input.request === 'full' || cssH <= input.fullMaxCssHeight + 0.5) {
    outcome = 'full';
    kind = 'full';
    region = full;
    tall = isTall(region, dpr);
  } else {
    bbox = marksOnImage(input.shapes, image, dpr);
    if (bbox) {
      outcome = 'smart';
      const y0 = bbox.y;
      const y1 = bbox.y + bbox.h;
      const bh = bbox.h;
      const pad = Math.max(SMART_REGION_PAD_CSS * dpr, 0.1 * bh);
      let a: number;
      let b: number;
      if (bh > cap) {
        // Taller than the budget on its own: copy the bbox and say it's tall.
        [a, b] = placeSpan(y0, y1, image.h);
        tall = true;
      } else if (y1 - y0 + 2 * pad > cap) {
        // The marks fit but their padding doesn't: a full budget window centred on them.
        const mid = (y0 + y1) / 2;
        [a, b] = placeSpan(mid - cap / 2, mid + cap / 2, image.h, capPx);
      } else if (mode === 'tight') {
        // bbox + padding; the padding is simply cut at the image edges.
        const a0 = Math.max(0, Math.floor(y0 - pad));
        a = a0;
        b = Math.min(image.h, Math.ceil(y1 + pad), a0 + capPx);
      } else if (y1 + pad <= cap) {
        // Fill: the top of the page fits with the marks, so take it.
        a = 0;
        b = Math.min(image.h, capPx);
      } else {
        // Fill: a budget-tall window, a little more of the spare room above (headings live there).
        const spare = cap - (bh + 2 * pad);
        const top = y0 - pad - Math.round(0.55 * spare);
        [a, b] = placeSpan(top, top + cap, image.h, capPx);
      }
      region = { x: 0, y: a, w: image.w, h: b - a };
      kind = a === 0 && !tall ? 'fromTop' : 'aroundMarks';
    } else {
      // No marks (or all of them off the image): from the top of the view down.
      outcome = 'viewport';
      kind = 'fromHere';
      const v0 = Math.min(Math.max(0, input.view.y), image.h);
      const [a, b] = placeSpan(v0, v0 + cap, image.h, capPx);
      region = { x: 0, y: a, w: image.w, h: b - a };
    }
  }

  const scale = fitScale(region, baseScale, maxArea);
  const plan: ExportPlan = { outcome, kind, region, scale, size: outputSize(region, scale), tall };
  if (kind !== 'full' && !tall) {
    const bottom = region.y + region.h;
    const top =
      region.y > 0 ? Math.max(0, Math.min(snapMax, (bbox ? bbox.y : bottom) - region.y)) : 0;
    const bot =
      bottom < image.h
        ? Math.max(0, Math.min(snapMax, bottom - (bbox ? bbox.y + bbox.h : region.y)))
        : 0;
    if (top > 0 || bot > 0) plan.snap = { top: Math.floor(top), bottom: Math.floor(bot) };
  }
  return plan;
}

/** Download: the whole image at native resolution (no downscale; huge images stream-encode). */
export function planDownload(image: Size, dpr: number): ExportPlan {
  const region = { x: 0, y: 0, w: image.w, h: image.h };
  return {
    outcome: 'full',
    kind: 'full',
    region,
    scale: 1,
    size: outputSize(region, 1),
    tall: isTall(region, dpr),
  };
}

/** Same scope as a copy plan but at native resolution (the e2e `exportPng` hook). */
export function nativePlan(plan: ExportPlan): ExportPlan {
  return { ...plan, scale: 1, size: outputSize(plan.region, 1) };
}

export function planKey(rev: number, plan: Pick<ExportPlan, 'region' | 'scale' | 'snap'>): string {
  const r = plan.region;
  const snap = plan.snap ? `|s${plan.snap.top},${plan.snap.bottom}` : '';
  return `${rev}|${r.x},${r.y},${r.w},${r.h}|${plan.scale}${snap}`;
}
