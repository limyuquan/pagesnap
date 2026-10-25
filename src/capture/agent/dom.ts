/** DOM helpers for the page agent. */
import { browser } from 'wxt/browser';
import type { Rect } from '@/shared/types';

type DomApi = { openOrClosedShadowRoot?: (el: HTMLElement) => ShadowRoot | null };

function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  // Closed roots are almost always on custom elements; the API call isn't free, so only ask there.
  if (!el.localName.includes('-') || !(el instanceof HTMLElement)) return null;
  try {
    return (browser as unknown as { dom?: DomApi }).dom?.openOrClosedShadowRoot?.(el) ?? null;
  } catch {
    return null;
  }
}

/** Every element in the document, including open and closed shadow trees, in tree order. */
export function forEachElement(cb: (el: Element) => void, root: Document | ShadowRoot = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element;
    cb(el);
    const sr = shadowRootOf(el);
    if (sr) forEachElement(cb, sr);
  }
}

/** Parent across shadow boundaries. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** `ancestor` contains `el`, across shadow boundaries. */
export function deepContains(ancestor: Element, el: Element): boolean {
  for (let n: Element | null = el; n; n = parentOf(n)) if (n === ancestor) return true;
  return false;
}

/**
 * A `position: fixed` element whose ancestor has a transform, filter, `contain` etc. is fixed to
 * that ancestor, not the viewport, so it scrolls with the content and is not a float.
 */
export function fixedToViewport(el: Element): boolean {
  for (let n = parentOf(el); n && n !== document.documentElement; n = parentOf(n)) {
    const cs = getComputedStyle(n);
    if (
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      cs.perspective !== 'none' ||
      cs.backdropFilter !== 'none' ||
      /paint|layout|strict|content/.test(cs.contain) ||
      /transform|filter|perspective/.test(cs.willChange)
    ) {
      return false;
    }
  }
  return true;
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** At most this many descendants are measured per `visibleExtent` call (app shells are huge). */
export const EXTENT_MAX_NODES = 400;

/**
 * The part of `el` that paints inside `bounds` (normally the viewport): the union of its own box
 * and the boxes of its visible descendants, including shadow trees. A `position: fixed` wrapper
 * with a 0 px box whose absolutely positioned child is the real header (w3schools) gets the child's
 * box instead of an empty one.
 * - Subtrees that are `display: none` or `opacity: 0` are skipped; `visibility: hidden` and boxes
 *   under 2 px (screen-reader-only text) don't count, but their descendants still can.
 * - Descendants are clipped by ancestors (within `el`, including `el`) that clip overflow, unless
 *   they are themselves fixed. Everything is clipped to `bounds`, so off-screen parts never count.
 * - Measures at most `maxNodes` descendants (breadth-first) and returns the union so far.
 * Returns an empty rect (w = h = 0) when nothing is visible.
 */
export function visibleExtent(el: Element, bounds: Rect, maxNodes = EXTENT_MAX_NODES): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const add = (r: Rect) => {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  };
  const ownRect = rectOf(el);
  const ownStyle = getComputedStyle(el);
  const own = clipRect(ownRect, bounds);
  if (ownStyle.visibility !== 'hidden' && own.w > 0 && own.h > 0) add(own);
  const rootClip = clipsOverflow(ownStyle) ? clipRect(ownRect, bounds) : bounds;
  // Breadth-first, so a capped walk of a big shell still sees its top-level structure.
  const queue: { node: Element; clip: Rect }[] = [];
  const pushChildren = (parent: Element, clip: Rect) => {
    if (clip.w <= 0 || clip.h <= 0) return;
    const sr = shadowRootOf(parent);
    if (sr) for (const c of sr.children) if (queue.length < maxNodes) queue.push({ node: c, clip });
    for (const c of parent.children) if (queue.length < maxNodes) queue.push({ node: c, clip });
  };
  pushChildren(el, rootClip);
  for (let head = 0; head < queue.length; head++) {
    const item = queue[head];
    if (!item) break;
    const { node } = item;
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const clip = cs.position === 'fixed' ? bounds : item.clip;
    const r = rectOf(node);
    if (cs.visibility !== 'hidden' && r.w >= 2 && r.h >= 2) {
      const v = clipRect(r, clip);
      if (v.w > 0 && v.h > 0) add(v);
    }
    if (queue.length < maxNodes && (node.firstElementChild || shadowRootOf(node))) {
      pushChildren(node, clipsOverflow(cs) ? clipRect(r, clip) : clip);
    }
  }
  if (x1 <= x0 || y1 <= y0) return { x: bounds.x, y: bounds.y, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clipsOverflow(cs: CSSStyleDeclaration): boolean {
  if (cs.display === 'contents') return false;
  return cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain.includes('paint');
}

export function clipRect(r: Rect, to: Rect): Rect {
  const x = Math.max(r.x, to.x);
  const y = Math.max(r.y, to.y);
  const w = Math.min(r.x + r.w, to.x + to.w) - x;
  const h = Math.min(r.y + r.h, to.y + to.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : { x, y, w: 0, h: 0 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve after `n` animation frames. Each frame falls back to a 100 ms timer, because rAF stops
 * in hidden or occluded tabs and the agent must never hang.
 */
export async function frames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * Wait (at most `capMs`) for images intersecting `waitArea` (default `area`) to load and decode.
 * Resolves with the number of images intersecting `area` still pending at the cap.
 */
export async function waitForImages(area: Rect, capMs: number, waitArea = area): Promise<number> {
  const pending: Promise<unknown>[] = [];
  let unfinished = 0;
  for (const img of document.images) {
    if (!img.currentSrc && !img.src) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const box = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (!intersects(box, waitArea)) continue;
    if (img.complete && img.naturalWidth === 0) continue; // broken image: nothing to wait for
    const counts = intersects(box, area);
    if (counts) unfinished++;
    const done = () => {
      if (counts) unfinished--;
    };
    pending.push(img.decode().then(done, done));
  }
  if (pending.length === 0) return 0;
  await Promise.race([Promise.all(pending), sleep(capMs)]);
  return Math.max(0, unfinished);
}

export { sleep };
