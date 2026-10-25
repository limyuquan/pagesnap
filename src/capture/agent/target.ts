/** The thing the agent scrolls: the document or one inner scroll container (01 §3.4). */
import { chooseScrollTarget, MIN_X_OVERFLOW, type ScrollerCandidate } from '@/capture/plan';
import type { Point, Rect, Size, TargetGeometry } from '@/shared/types';
import { clipRect, deepContains, rectOf } from './dom';

export interface Limits {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ScrollTarget {
  readonly kind: 'document' | 'element';
  readonly el: Element | null;
  get(): Point;
  set(p: Point): void;
  /** Reachable scroll offsets (reverse scrollers have negative offsets). */
  limits(): Limits;
  /** The scroller's visible box, viewport CSS px. */
  clientRect(): Rect;
  content(): Size;
}

/** Layout viewport without scrollbars, CSS px. */
export function viewportSize(): Size {
  const el = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
  return { w: el?.clientWidth || innerWidth, h: el?.clientHeight || innerHeight };
}

export function documentTarget(): ScrollTarget {
  const se = () => document.scrollingElement ?? document.documentElement;
  return {
    kind: 'document',
    el: null,
    get: () => ({ x: scrollX, y: scrollY }),
    set: (p) => scrollTo({ left: p.x, top: p.y, behavior: 'instant' }),
    limits() {
      const v = viewportSize();
      const ox = Math.max(0, se().scrollWidth - v.w);
      const oy = Math.max(0, se().scrollHeight - v.h);
      const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
      const xs = ox >= MIN_X_OVERFLOW ? (rtl ? { x0: -ox, x1: 0 } : { x0: 0, x1: ox }) : null;
      const x = xs ?? { x0: scrollX, x1: scrollX };
      return { ...x, y0: 0, y1: oy };
    },
    clientRect() {
      const v = viewportSize();
      return { x: 0, y: 0, w: v.w, h: v.h };
    },
    content() {
      const v = viewportSize();
      return { w: Math.max(v.w, se().scrollWidth), h: Math.max(v.h, se().scrollHeight) };
    },
  };
}

export function elementTarget(el: HTMLElement): ScrollTarget {
  const reversed = () => {
    const cs = getComputedStyle(el);
    return cs.flexDirection === 'column-reverse' && cs.display.includes('flex');
  };
  return {
    kind: 'element',
    el,
    get: () => ({ x: el.scrollLeft, y: el.scrollTop }),
    set: (p) => el.scrollTo({ left: p.x, top: p.y, behavior: 'instant' }),
    limits() {
      const over = Math.max(0, el.scrollHeight - el.clientHeight);
      const y = reversed() ? { y0: -over, y1: 0 } : { y0: 0, y1: over };
      // Inner scrollers are captured one column wide: keep the current horizontal offset.
      return { x0: el.scrollLeft, x1: el.scrollLeft, ...y };
    },
    clientRect() {
      const r = el.getBoundingClientRect();
      const v = viewportSize();
      const box = {
        x: r.left + el.clientLeft,
        y: r.top + el.clientTop,
        w: el.clientWidth,
        h: el.clientHeight,
      };
      return clipRect(box, { x: 0, y: 0, w: v.w, h: v.h });
    },
    content: () => ({ w: el.clientWidth, h: el.scrollHeight }),
  };
}

export function geometryOf(t: ScrollTarget, range: Limits): TargetGeometry {
  return { kind: t.kind, clientRect: t.clientRect(), range: { ...range }, content: t.content() };
}

/** Is `el` a scroll container whose overflow would be propagated to the viewport (body)? */
function propagatedBody(el: Element): boolean {
  if (el !== document.body) return false;
  return getComputedStyle(document.documentElement).overflowY === 'visible';
}

/** Pick the scroll target from the vertical scroller candidates found in the page scan. */
export function findScrollTarget(
  candidates: readonly HTMLElement[],
  mode: 'auto' | 'page',
): ScrollTarget {
  const doc = documentTarget();
  if (mode === 'page') return doc;
  const view = viewportSize();
  const viewRect = { x: 0, y: 0, w: view.w, h: view.h };
  const centre = document.elementFromPoint(view.w / 2, view.h / 2);
  const list: ScrollerCandidate<HTMLElement>[] = [];
  for (const el of candidates) {
    if (el === document.documentElement || el === document.scrollingElement) continue;
    if (propagatedBody(el)) continue;
    const visible = clipRect(rectOf(el), viewRect);
    if (visible.w <= 0) continue;
    list.push({
      ref: el,
      visible,
      overflow: el.scrollHeight - el.clientHeight,
      containsCenter: !!centre && deepContains(el, centre),
    });
  }
  const docOverflow = doc.limits().y1;
  const pick = chooseScrollTarget(docOverflow, list, view);
  return pick ? elementTarget(pick.ref) : doc;
}
