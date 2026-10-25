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
 * Wait (at most `capMs`) for images intersecting `area` to load and decode. Resolves with the
 * number still pending at the cap.
 */
export async function waitForImages(area: Rect, capMs: number): Promise<number> {
  const pending: Promise<unknown>[] = [];
  let unfinished = 0;
  for (const img of document.images) {
    if (!img.currentSrc && !img.src) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (!intersects({ x: r.left, y: r.top, w: r.width, h: r.height }, area)) continue;
    if (img.complete && img.naturalWidth === 0) continue; // broken image: nothing to wait for
    unfinished++;
    pending.push(
      img.decode().then(
        () => unfinished--,
        () => unfinished--,
      ),
    );
  }
  if (pending.length === 0) return 0;
  await Promise.race([Promise.all(pending), sleep(capMs)]);
  return Math.max(0, unfinished);
}

export { sleep };
