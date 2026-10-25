/**
 * One capture inside the page (owner: A). The agent owns the DOM: it prepares the page, plans
 * and performs every scroll, decides which floating elements are visible in each slice, and
 * restores the page afterwards. See 01 §3 and §5.5.
 */
import {
  capRange,
  classifyFloat,
  estimateSlices,
  type FloatKind,
  floatVisible,
  nextOffset,
  planAxis,
} from '@/capture/plan';
import { MAX_SLICES } from '@/shared/limits';
import type { CaptureOptions } from '@/shared/protocol';
import type { CaptureWarningCode, Point, TargetGeometry } from '@/shared/types';
import { fixedToViewport, forEachElement, frames, rectOf, sleep, waitForImages } from './dom';
import { PageMutations } from './mutations';
import {
  findScrollTarget,
  geometryOf,
  type Limits,
  type ScrollTarget,
  viewportSize,
} from './target';

type Styled = Element & ElementCSSInlineStyle;

export class AgentError extends Error {
  constructor(
    readonly code: 'NO_SCROLL' | 'SCROLL_JACKED' | 'PINCH_ZOOM' | 'INTERNAL',
    detail: string,
  ) {
    super(detail);
  }
}

export interface Prepared {
  viewport: { w: number; h: number };
  target: TargetGeometry;
  estSlices: number;
  warnings: CaptureWarningCode[];
}

export type StepResult =
  | {
      t: 'positioned';
      i: number;
      scrollX: number;
      scrollY: number;
      last: boolean;
      target: TargetGeometry;
    }
  | { t: 'done' };

const IMAGE_WAIT_MS = 800;
const PRESCROLL_BUDGET_MS = 2000;
const STABLE_WAIT_MS = 1500;

export class AgentSession {
  private readonly m = new PageMutations();
  private readonly startDoc: Point = { x: scrollX, y: scrollY };
  private startTarget: Point | null = null;
  private target: ScrollTarget | null = null;
  private range: Limits = { x0: 0, x1: 0, y0: 0, y1: 0 };
  private xs: number[] = [0];
  private readonly floats = new Map<Styled, 'top' | 'bottom'>();
  private observer: MutationObserver | null = null;
  /** The page's DOM changed since the last float scan (records arrive asynchronously). */
  private domDirty = false;
  private opts: CaptureOptions | null = null;
  private index = 0;
  private col = 0;
  private rowY = 0;
  private finished = false;
  private restored = false;

  async prepare(opts: CaptureOptions): Promise<Prepared> {
    this.opts = opts;
    if (document.contentType === 'application/pdf') throw new AgentError('NO_SCROLL', 'pdf');
    if ((visualViewport?.scale ?? 1) > 1.01) throw new AgentError('PINCH_ZOOM', 'pinch zoom');

    // Stylesheet first, then measure: hiding scrollbars re-flows the page (upstream bug, 01 §1.2).
    this.m.addCaptureSheet();
    const scrollers: HTMLElement[] = [];
    const fixed: Styled[] = [];
    forEachElement((el) => this.scanElement(el, scrollers, fixed));
    this.m.pauseVideos();
    this.m.settleAnimations();
    await Promise.race([document.fonts?.ready, sleep(500)]);
    await frames(2);

    const target = findScrollTarget(scrollers, opts.target);
    this.target = target;
    this.startTarget = target.get();
    if (target.el) {
      const el = target.el as Styled;
      this.m.setStyle(el, 'scroll-behavior', 'auto');
      this.m.setStyle(el, 'overflow-anchor', 'none');
      this.m.setStyle(el, 'scrollbar-width', 'none');
      await frames(1);
    }

    let limits = target.limits();
    const clientRect = target.clientRect();
    const view = { w: clientRect.w, h: clientRect.h };
    if (this.wantsPreScroll(limits, view.h)) limits = await this.preScroll(target, limits, view.h);

    this.xs = planAxis(limits.x0, limits.x1, view.w);
    const capped = capRange(
      limits.y0,
      limits.y1,
      view.h,
      opts.maxCssHeight,
      MAX_SLICES,
      this.xs.length,
    );
    this.range = { x0: limits.x0, x1: limits.x1, y0: limits.y0, y1: capped.y1 };

    // Classify floats at the start position, where the first slice will be taken.
    target.set({ x: this.range.x0, y: this.range.y0 });
    await frames(2);
    for (const el of fixed) this.classify(el);
    this.observe();

    const warnings: CaptureWarningCode[] = [];
    if (capped.truncated) warnings.push('TRUNCATED');
    if (target.kind === 'element') warnings.push('INNER_SCROLLER');
    return {
      viewport: { w: innerWidth, h: innerHeight },
      target: geometryOf(target, this.range),
      estSlices: estimateSlices(this.range, view),
      warnings,
    };
  }

  async step(): Promise<StepResult> {
    const target = this.target;
    const opts = this.opts;
    if (!target || !opts || this.restored) throw new AgentError('INTERNAL', 'not prepared');
    if (this.finished) return { t: 'done' };

    const view = target.clientRect();
    const live = target.limits();
    const end = Math.max(this.range.y0, Math.min(this.range.y1, live.y1));
    let want: Point;
    let newRow = false;
    if (this.index === 0) {
      want = { x: this.xs[0] ?? 0, y: this.range.y0 };
      newRow = true;
    } else if (this.col + 1 < this.xs.length) {
      this.col++;
      want = { x: this.xs[this.col] ?? 0, y: this.rowY };
    } else {
      if (this.rowY >= end - 0.5) return this.finish();
      this.col = 0;
      want = { x: this.xs[0] ?? 0, y: nextOffset(this.rowY, end, view.h) };
      newRow = true;
    }

    const scrolledAt = performance.now();
    target.set(want);
    await frames(2);
    let at = await this.settledPosition(target, want);
    if (newRow) {
      if (this.index > 0 && at.y <= this.rowY + 0.5) return this.finish(); // no progress: page end
      this.rowY = at.y;
    }
    const last = at.y >= end - 0.5 && this.col === this.xs.length - 1;

    this.updateFloats(this.index, last, opts.floating);
    this.m.settleAnimations();

    await waitForImages(view, IMAGE_WAIT_MS);
    const extra = opts.settleMs - (performance.now() - scrolledAt);
    if (extra > 0) await sleep(extra);
    await frames(1);
    // Late scroll handlers (debounced headers) get one more chance.
    if (this.domDirty) {
      this.updateFloats(this.index, last, opts.floating);
      this.m.settleAnimations();
    }
    await frames(1);
    at = target.get();

    const i = this.index++;
    if (last) this.finished = true;
    return {
      t: 'positioned',
      i,
      scrollX: at.x,
      scrollY: at.y,
      last,
      target: geometryOf(target, this.range),
    };
  }

  /** Undo every page mutation and scroll back. Idempotent. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.observer?.disconnect();
    this.observer = null;
    this.m.restore();
    if (this.target?.el && this.startTarget) this.target.set(this.startTarget);
    scrollTo({ left: this.startDoc.x, top: this.startDoc.y, behavior: 'instant' });
  }

  // -------------------------------------------------------------------------------------------

  private finish(): StepResult {
    this.finished = true;
    return { t: 'done' };
  }

  private scanElement(el: Element, scrollers: HTMLElement[], fixed: Styled[]): void {
    const cs = getComputedStyle(el);
    const styled = el as Styled;
    if (!styled.style) return;
    const pos = cs.position;
    if (pos === 'sticky') this.unstick(styled);
    else if (pos === 'fixed') fixed.push(styled);
    if (cs.backgroundAttachment.includes('fixed'))
      this.m.setStyle(styled, 'background-attachment', 'scroll');
    if (cs.contentVisibility === 'auto') this.m.setStyle(styled, 'content-visibility', 'visible');
    if (el instanceof HTMLImageElement || el instanceof HTMLIFrameElement) this.m.makeEager(el);
    const oy = cs.overflowY;
    if (
      (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
      el instanceof HTMLElement &&
      el.scrollHeight - el.clientHeight >= 50
    ) {
      scrollers.push(el);
    }
  }

  private unstick(el: Styled): void {
    if (this.opts?.floating === 'keep' || !el.style) return;
    // `relative` + `inset: auto` keeps the element in flow at its natural place (01 §3.1).
    this.m.setStyle(el, 'position', 'relative');
    this.m.setStyle(el, 'inset', 'auto');
  }

  private classify(el: Styled): void {
    if (this.opts?.floating === 'keep' || this.floats.has(el) || !this.target || !el.style) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
    if (!fixedToViewport(el)) return;
    const view = viewportSize();
    const area = this.target.clientRect();
    const kind: FloatKind = classifyFloat(rectOf(el), view, area, {
      containsTarget: !!this.target.el && el.contains(this.target.el),
      elementTarget: this.target.kind === 'element',
    });
    if (kind === 'top' || kind === 'bottom') this.floats.set(el, kind);
  }

  /**
   * Header jump: re-check for elements that became fixed (or sticky) since the last slice, then
   * show or hide every float for this slice. A class change on any ancestor can make an element
   * fixed, so every element is re-checked, but only when the DOM changed.
   */
  private updateFloats(index: number, last: boolean, mode: CaptureOptions['floating']): void {
    if (this.domDirty || this.observer?.takeRecords().length) {
      forEachElement((el) => {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed') this.classify(el as Styled);
        else if (pos === 'sticky') this.unstick(el as Styled);
      });
    }
    this.applyFloats(index, last, mode);
    // Our own style changes aren't page changes.
    this.observer?.takeRecords();
    this.domDirty = false;
  }

  private applyFloats(index: number, last: boolean, mode: CaptureOptions['floating']): void {
    for (const [el, kind] of this.floats) {
      if (floatVisible(kind, mode, index, last)) this.m.resetStyle(el, 'opacity');
      else this.m.setStyle(el, 'opacity', '0');
    }
  }

  private observe(): void {
    this.observer = new MutationObserver(() => {
      this.domDirty = true;
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  }

  private wantsPreScroll(limits: Limits, viewH: number): boolean {
    const mode = this.opts?.preScroll ?? 'auto';
    if (mode === 'off') return false;
    if (mode === 'on') return limits.y1 > limits.y0;
    return limits.y1 - limits.y0 > 2 * viewH;
  }

  /**
   * Step through the scroller without capturing so IntersectionObserver loaders and scroll-reveal
   * code run. One frame per viewport, capped at `PRESCROLL_BUDGET_MS`.
   */
  private async preScroll(target: ScrollTarget, limits: Limits, viewH: number): Promise<Limits> {
    const t0 = performance.now();
    const maxEnd = limits.y0 + (this.opts?.maxCssHeight ?? Number.POSITIVE_INFINITY);
    let y = limits.y0;
    let lim = limits;
    while (y < Math.min(lim.y1, maxEnd) && performance.now() - t0 < PRESCROLL_BUDGET_MS) {
      y = Math.min(y + viewH, lim.y1);
      target.set({ x: lim.x0, y });
      // IntersectionObserver runs after rAF callbacks in the same frame, so scrolling again from
      // a task queued in rAF lets this frame observe this position: one frame per viewport.
      await frames(1);
      await afterFrameTask();
      lim = target.limits();
    }
    this.m.settleAnimations();
    // Lazy content changed the page: give it a moment to stop moving before planning.
    if (target.limits().y1 !== limits.y1) await this.waitForStableHeight(target);
    return target.limits();
  }

  /** Wait until the scroll range is unchanged for 300 ms, at most `STABLE_WAIT_MS`. */
  private async waitForStableHeight(target: ScrollTarget): Promise<void> {
    const t0 = performance.now();
    let last = target.limits().y1;
    let since = t0;
    while (performance.now() - t0 < STABLE_WAIT_MS) {
      await sleep(50);
      const now = target.limits().y1;
      if (now !== last) {
        last = now;
        since = performance.now();
      } else if (performance.now() - since >= 300) {
        return;
      }
    }
  }

  /** Read the position back; if it is still moving (JS smooth scrolling), wait up to 300 ms. */
  private async settledPosition(target: ScrollTarget, want: Point): Promise<Point> {
    let at = target.get();
    if (Math.abs(at.y - want.y) <= 1 && Math.abs(at.x - want.x) <= 1) return at;
    const t0 = performance.now();
    while (performance.now() - t0 < 300) {
      await frames(1);
      const next = target.get();
      if (next.x === at.x && next.y === at.y) break;
      at = next;
    }
    return target.get();
  }
}

/** Resolve in a task after the current frame's rendering steps. */
function afterFrameTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}
