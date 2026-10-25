/**
 * What `Cmd+C` / `Shift+Cmd+C` / Download put out (CONTRACTS §4.9). Pure maths, unit-tested.
 *
 * - `copy('full')`: the whole image. Outcome `full`.
 * - `copy('default')`: the whole image when the page is at most `fullMaxCssHeight` CSS px tall;
 *   otherwise the smart region around the annotations (`smart`), or with no annotations the
 *   current view (`viewport`). Both use the full image width and are capped at
 *   `AI_MAX_LONG_EDGE_CSS * dpr` image px tall.
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

export interface ExportPlan {
  outcome: CopyOutcomeKind;
  /** Source region, whole image px. */
  region: Rect;
  /** Output px per image px. */
  scale: number;
  /** Output pixel size. */
  size: Size;
  /** Long edge above `AI_MAX_LONG_EDGE_CSS` CSS px: an AI model will shrink it noticeably. */
  tall: boolean;
}

export interface CopyPlanInput {
  request: CopyRequestKind;
  image: Size;
  dpr: number;
  shapes: readonly Shape[];
  /** The currently visible image rect (for the `viewport` outcome). */
  view: Rect;
  /** `settings.copy.fullMaxCssHeight`. */
  fullMaxCssHeight: number;
  /** `settings.copy.resolution`. */
  resolution: 'css' | 'native';
  /** Max output pixels for a clipboard image (memory guard). Default `CANVAS_MAX_AREA / 2`. */
  maxArea?: number;
}

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

/** Copy plan for `copy(request)`. */
export function planCopy(input: CopyPlanInput): ExportPlan {
  const { image, dpr } = input;
  const full: Rect = { x: 0, y: 0, w: image.w, h: image.h };
  const cssH = image.h / dpr;
  const cap = AI_MAX_LONG_EDGE_CSS * dpr;
  const capPx = Math.floor(cap);
  const baseScale = input.resolution === 'css' ? 1 / dpr : 1;
  const maxArea = input.maxArea ?? COPY_MAX_AREA;

  let outcome: CopyOutcomeKind;
  let region: Rect;
  let tall = false;

  if (input.request === 'full' || cssH <= input.fullMaxCssHeight + 0.5) {
    outcome = 'full';
    region = full;
    tall = isTall(region, dpr);
  } else {
    const bbox = shapesBounds(input.shapes, dpr);
    if (bbox) {
      outcome = 'smart';
      const y0 = Math.max(0, bbox.y);
      const y1 = Math.min(image.h, bbox.y + bbox.h);
      const bh = Math.max(0, y1 - y0);
      if (bh > cap) {
        // Taller than the cap on its own: copy the bbox and say it's tall.
        const [a, b] = placeSpan(y0, y1, image.h);
        region = { x: 0, y: a, w: image.w, h: b - a };
        tall = true;
      } else {
        const pad = Math.max(SMART_REGION_PAD_CSS * dpr, 0.1 * bh);
        let p0 = y0 - pad;
        let p1 = y1 + pad;
        if (p1 - p0 > cap) {
          const mid = (y0 + y1) / 2;
          p0 = mid - cap / 2;
          p1 = mid + cap / 2;
        }
        // Padding is simply cut at the image edges; a capped window shifts to stay full height.
        const capped = p1 - p0 >= cap - 0.5;
        const a0 = Math.max(0, Math.floor(p0));
        const [a, b] = capped
          ? placeSpan(p0, p1, image.h, capPx)
          : [a0, Math.min(image.h, Math.ceil(p1), a0 + capPx)];
        region = { x: 0, y: a, w: image.w, h: b - a };
      }
    } else {
      outcome = 'viewport';
      let v0 = Math.max(0, input.view.y);
      let v1 = Math.min(image.h, input.view.y + input.view.h);
      if (v1 <= v0) {
        v0 = 0;
        v1 = Math.min(image.h, cap);
      }
      if (v1 - v0 > cap) {
        const mid = (v0 + v1) / 2;
        v0 = mid - cap / 2;
        v1 = mid + cap / 2;
      }
      const [a, b] = placeSpan(v0, v1, image.h, capPx);
      region = { x: 0, y: a, w: image.w, h: b - a };
    }
  }

  const scale = fitScale(region, baseScale, maxArea);
  return { outcome, region, scale, size: outputSize(region, scale), tall };
}

/** Download: the whole image at native resolution (no downscale; huge images stream-encode). */
export function planDownload(image: Size, dpr: number): ExportPlan {
  const region = { x: 0, y: 0, w: image.w, h: image.h };
  return {
    outcome: 'full',
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

export function planKey(rev: number, plan: Pick<ExportPlan, 'region' | 'scale'>): string {
  const r = plan.region;
  return `${rev}|${r.x},${r.y},${r.w},${r.h}|${plan.scale}`;
}
