/**
 * One capture inside the page (owner: A). The agent owns the DOM: it prepares the page, plans
 * and performs every scroll, decides which floating elements are visible in each slice, and
 * restores the page afterwards. See 01 §3 and §5.5.
 */

import { MIN_SHIFT } from '@/capture/anchor';
import {
  capRange,
  classifyFloat,
  estimateSlices,
  type FloatKind,
  floatVisible,
  nextOffset,
  planAxis,
  type SliceFloatKind,
} from '@/capture/plan';
import { MAX_SLICES } from '@/shared/limits';
import type { CaptureOptions, SliceNotes } from '@/shared/protocol';
import type { CaptureWarningCode, Point, TargetGeometry } from '@/shared/types';
import { type Anchor, anchorShifts, collectAnchors, rebase, seamShift } from './anchors';
import {
  clipRect,
  fixedToViewport,
  forEachElement,
  frames,
  rectOf,
  sleep,
  visibleExtent,
  waitForImages,
} from './dom';
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
    readonly code:
      | 'NO_SCROLL'
      | 'SCROLL_JACKED'
      | 'PINCH_ZOOM'
      | 'ABORTED'
      | 'NAVIGATED'
      | 'INTERNAL',
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
  dpr: number;
}

export type StepResult =
  | {
      t: 'positioned';
      i: number;
      scrollX: number;
      scrollY: number;
      place: Point;
      last: boolean;
      target: TargetGeometry;
      visible: boolean;
      notes: SliceNotes;
      /** This replaces slice `i` (taken again because the page moved while it was shot). */
      retake?: boolean;
    }
  | { t: 'done'; notes?: SliceNotes };

/** Wait at most this long per slice for in-view images to decode... */
const IMAGE_WAIT_MS = 800;
/** ...and this long once the capture has already spent `IMAGE_BUDGET_MS` waiting on images. */
const IMAGE_WAIT_LATE_MS = 200;
const IMAGE_BUDGET_MS = 4000;
const PRESCROLL_BUDGET_MS = 2000;
const STABLE_WAIT_MS = 1500;
/** Re-anchoring passes per slice (content can keep moving while we correct). */
const MAX_REANCHOR = 3;
/** Re-takes of slices the page moved under while they were shot: per capture, per slice. */
const MAX_RETAKES = 8;
const MAX_SLICE_RETAKES = 2;
/** e2e builds only: trace the agent's decisions to the page console (`[pagesnap-agent]`). */
const trace: (...args: unknown[]) => void =
  import.meta.env.MODE === 'e2e' ? (...a) => console.debug('[pagesnap-agent]', ...a) : () => {};
/** Content height change (CSS px) that counts as the page changing. */
const HEIGHT_EPS = 2;

export class AgentSession {
  private readonly m = new PageMutations();
  private readonly startDoc: Point = { x: scrollX, y: scrollY };
  private startTarget: Point | null = null;
  private target: ScrollTarget | null = null;
  private range: Limits = { x0: 0, x1: 0, y0: 0, y1: 0 };
  private xs: number[] = [0];
  private readonly floats = new Map<Styled, SliceFloatKind>();
  private observer: MutationObserver | null = null;
  /** The page's DOM changed since the last float scan (records arrive asynchronously). */
  private domDirty = false;
  private opts: CaptureOptions | null = null;
  private index = 0;
  private col = 0;
  private rowY = 0;
  private rows = 0;
  private finished = false;
  private restored = false;
  /** Every `position: fixed` element seen: anchors inside them don't follow the content. */
  private readonly fixedEls = new Set<Element>();
  /** URL (without the hash) at prepare: a change means an SPA route change. */
  private href = '';
  /**
   * Content moved above the seams so far, CSS px: a slice scrolled to `y` goes to output
   * position `y - shift` (`SliceMeta.place`).
   */
  private shift = 0;
  /**
   * Anchors along the bottom of the last positioned slice: if they're gone when the URL changed,
   * the page's content was replaced (an SPA route change).
   */
  private replyAnchors: Anchor[] = [];
  /** The target's content height at the last slice. */
  private lastContentH = 0;
  /** The page's height changed since the last end-of-page wait. */
  private grew = false;
  private imageWaitMs = 0;
  /** The seam the last slice was anchored on, rebased to where it was when it was positioned. */
  private lastSeam: Anchor[] = [];
  private retakes = 0;
  private sliceRetakes = 0;

  async prepare(opts: CaptureOptions): Promise<Prepared> {
    this.opts = opts;
    if (document.contentType === 'application/pdf') throw new AgentError('NO_SCROLL', 'pdf');
    if ((visualViewport?.scale ?? 1) > 1.01) throw new AgentError('PINCH_ZOOM', 'pinch zoom');
    this.href = pageUrl();

    // Stylesheet first, then measure: hiding scrollbars re-flows the page (upstream bug, 01 §1.2).
    this.m.addCaptureSheet();
    const scrollers: HTMLElement[] = [];
    const fixed: Styled[] = [];
    forEachElement((el) => this.scanElement(el, scrollers, fixed));
    for (const el of fixed) this.fixedEls.add(el);
    this.m.pauseVideos();
    this.m.settleAnimations();
    await Promise.race([document.fonts?.ready, sleep(500)]);
    this.alive();
    await frames(2);
    this.alive();

    const target = findScrollTarget(scrollers, opts.target);
    this.target = target;
    this.startTarget = target.get();
    if (target.el) {
      const el = target.el as Styled;
      this.m.setStyle(el, 'scroll-behavior', 'auto');
      this.m.setStyle(el, 'overflow-anchor', 'none');
      this.m.setStyle(el, 'scrollbar-width', 'none');
      await frames(1);
      this.alive();
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
    this.scrollTarget(target, { x: this.range.x0, y: this.range.y0 });
    await frames(2);
    this.alive();
    for (const el of fixed) this.classify(el);
    this.observe();
    this.lastContentH = target.content().h;

    const warnings: CaptureWarningCode[] = [];
    if (capped.truncated) warnings.push('TRUNCATED');
    if (target.kind === 'element') warnings.push('INNER_SCROLLER');
    if (target.kind === 'document' && limits.y1 - limits.y0 < 1 && scrollLocked(view.h)) {
      warnings.push('NOT_SCROLLABLE');
    }
    return {
      viewport: { w: innerWidth, h: innerHeight },
      target: geometryOf(target, this.range),
      estSlices: estimateSlices(this.range, view),
      warnings,
      dpr: devicePixelRatio,
    };
  }

  async step(): Promise<StepResult> {
    const target = this.target;
    const opts = this.opts;
    if (!target || !opts) throw new AgentError('INTERNAL', 'not prepared');
    this.alive();
    this.checkUrl();
    const notes: SliceNotes = {};
    // The page moved around the slice while the SW shot it (between our reply and now), so the
    // shot may show either state: take it again.
    if (this.index > 0 && this.shotMoved(target)) {
      const canRetake =
        this.xs.length === 1 && this.retakes < MAX_RETAKES && this.sliceRetakes < MAX_SLICE_RETAKES;
      trace('shot moved', { i: this.index - 1, canRetake, retakes: this.retakes });
      if (canRetake) return this.retake(target, opts);
      notes.misaligned = true;
    }
    if (this.finished) return { t: 'done', notes };

    const view = target.clientRect();
    let want: Point;
    let newRow = false;
    // Content near the bottom of the slice the SW just shot, to re-anchor the next row on.
    let seam: Anchor[] = [];
    if (this.index === 0) {
      want = { x: this.xs[0] ?? 0, y: this.range.y0 };
      newRow = true;
    } else if (this.col + 1 < this.xs.length) {
      this.col++;
      want = { x: this.xs[this.col] ?? 0, y: this.rowY };
    } else {
      const { end } = this.planEnd(target, view.h);
      if (this.rowY >= end - 0.5 || this.rows >= this.maxRows()) return this.finish(notes);
      seam = collectAnchors(target, view, (el) => this.inFixed(el));
      this.col = 0;
      want = { x: this.xs[0] ?? 0, y: nextOffset(this.rowY, end, view.h) };
      newRow = true;
    }

    const scrolledAt = performance.now();
    this.scrollTarget(target, want);
    await frames(2);
    this.alive();
    let at = await this.settledPosition(target, want);
    if (newRow && this.index > 0 && at.y <= this.rowY + 0.5) return this.finish(notes); // page end

    this.updateFloats(this.index, false, opts.floating);
    this.m.settleAnimations();

    const imgCap = this.imageWaitMs >= IMAGE_BUDGET_MS ? IMAGE_WAIT_LATE_MS : IMAGE_WAIT_MS;
    const imgT0 = performance.now();
    const pendingImages = await waitForImages(view, imgCap, { ...view, h: view.h * 1.25 });
    this.imageWaitMs += performance.now() - imgT0;
    this.alive();
    const extra = opts.settleMs - (performance.now() - scrolledAt);
    if (extra > 0) await sleep(extra);
    await frames(1);
    this.alive();

    // Content above the seam moved while we scrolled and settled: scroll the same amount
    // further so the next slice starts right where the last one ended, and place it that much
    // higher. Content that moved below the seam needs nothing.
    if (newRow) this.lastSeam = [];
    if (newRow && seam.length > 0) {
      const r = await this.reanchor(target, seam, at, notes);
      at = r.pos;
      this.lastSeam = r.anchors;
    } else if (newRow && this.index > 0 && this.heightMoved(target)) notes.misaligned = true;
    if (newRow) {
      this.rowY = at.y;
      this.rows++;
    }

    let { end, truncated } = this.planEnd(target, view.h);
    let last = this.isLast(at, end);
    if (last && this.index > 0) {
      // Pages often load more (footers, "most read") once the end is reached: give them a
      // moment and follow if they grew. Mostly free: the SW waits for its capture slot anyway.
      const grew = this.grew || this.heightMoved(target);
      await this.waitForStableHeight(target, grew ? 1500 : 600, grew ? 400 : 250);
      this.alive();
      ({ end, truncated } = this.planEnd(target, view.h));
      last = this.isLast(at, end);
      this.grew = false;
    }
    // The slice cap ends the capture even if the page goes on.
    if (!last && this.rows >= this.maxRows() && this.col === this.xs.length - 1) {
      last = true;
      notes.truncated = true;
    } else if (last && truncated) notes.truncated = true;

    this.updateFloats(this.index, last, opts.floating);
    this.m.settleAnimations();
    await frames(1);
    this.alive();
    // Late scroll handlers (debounced headers) get one more chance.
    if (this.domDirty) {
      this.updateFloats(this.index, last, opts.floating);
      this.m.settleAnimations();
    }
    await frames(1);
    this.alive();
    at = target.get();
    if (pendingImages > 0) notes.imagesPending = pendingImages;
    this.trackHeight(target);
    // A route change during this step: judge by what was on screen before it began.
    this.checkUrl(seam.length > 0 ? seam : this.replyAnchors);
    this.replyAnchors = collectAnchors(target, view, (el) => this.inFixed(el));

    const i = this.index++;
    this.sliceRetakes = 0;
    if (last) this.finished = true;
    this.range = { ...this.range, y1: Math.max(this.range.y1, Math.min(end, at.y)) };
    return this.positioned(target, i, at, last, notes);
  }

  private positioned(
    target: ScrollTarget,
    i: number,
    at: Point,
    last: boolean,
    notes: SliceNotes,
    retake = false,
  ): StepResult {
    return {
      t: 'positioned',
      i,
      scrollX: at.x,
      scrollY: at.y,
      place: { x: at.x, y: at.y - this.shift },
      last,
      target: geometryOf(target, this.range),
      visible: document.visibilityState === 'visible',
      notes,
      ...(retake && { retake }),
    };
  }

  /** Content along the bottom of the last slice moved since we replied (one agreed shift). */
  private shotMoved(target: ScrollTarget): boolean {
    if (this.replyAnchors.length === 0) return false;
    const c = seamShift(target, this.replyAnchors);
    return c.reliable ? Math.abs(c.d) >= MIN_SHIFT : c.moved;
  }

  /** Position the last slice again (re-anchored on its seam) so the SW can replace it. */
  private async retake(target: ScrollTarget, opts: CaptureOptions): Promise<StepResult> {
    this.retakes++;
    this.sliceRetakes++;
    const i = this.index - 1;
    const notes: SliceNotes = {};
    let at = target.get();
    if (this.lastSeam.length > 0) {
      const r = await this.reanchor(target, this.lastSeam, at, notes);
      at = r.pos;
      this.lastSeam = r.anchors;
      this.rowY = at.y;
    }
    this.updateFloats(i, this.finished, opts.floating);
    this.m.settleAnimations();
    await frames(2);
    this.alive();
    at = target.get();
    this.trackHeight(target);
    this.replyAnchors = collectAnchors(target, target.clientRect(), (el) => this.inFixed(el));
    return this.positioned(target, i, at, this.finished, notes, true);
  }

  /**
   * After the page was hidden (the SW paused): repaint the current slice's floats and re-record
   * the seam anchors, since the page may have changed meanwhile.
   */
  async resettle(): Promise<void> {
    const target = this.target;
    const opts = this.opts;
    if (!target || !opts || this.restored || this.index === 0) return;
    this.updateFloats(this.index - 1, this.finished, opts.floating);
    this.m.settleAnimations();
    await frames(1);
    if (this.restored) return;
    this.replyAnchors = collectAnchors(target, target.clientRect(), (el) => this.inFixed(el));
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

  /**
   * SPA route change: the URL changed and the content we last shot is gone. Pages that only
   * rewrite their URL while scrolling (infinite articles, `?page=2`) keep their content: follow
   * the new URL.
   */
  private checkUrl(anchors: readonly Anchor[] = this.replyAnchors): void {
    const now = pageUrl();
    if (now === this.href) return;
    const lost = anchors.filter((a) => !a.node.isConnected).length;
    trace('url changed', JSON.stringify({ now, was: this.href, anchors: anchors.length, lost }));
    if (anchors.length === 0 || lost >= Math.max(1, 0.6 * anchors.length)) {
      throw new AgentError('NAVIGATED', 'url changed');
    }
    this.href = now;
  }

  /** Throw once restored: nothing may touch the page after that. Call after every `await`. */
  private alive(): void {
    if (this.restored) throw new AgentError('ABORTED', 'restored');
  }

  /** Scroll the target, unless the page was restored meanwhile. */
  private scrollTarget(target: ScrollTarget, p: Point): void {
    if (!this.restored) target.set(p);
  }

  private maxRows(): number {
    return Math.max(1, Math.floor(MAX_SLICES / Math.max(1, this.xs.length)));
  }

  /**
   * Last scroll offset to capture, from the live scroll range (the page may have grown or shrunk
   * since prepare), capped so the output stays within `maxCssHeight`.
   */
  private planEnd(target: ScrollTarget, viewH: number): { end: number; truncated: boolean } {
    const live = target.limits().y1;
    const maxCss = this.opts?.maxCssHeight ?? Number.POSITIVE_INFINITY;
    const capEnd = this.range.y0 + Math.max(0, maxCss - viewH) + this.shift;
    return {
      end: Math.max(this.range.y0, Math.min(live, capEnd)),
      truncated: live > capEnd + 0.5,
    };
  }

  private isLast(at: Point, end: number): boolean {
    return at.y >= end - 0.5 && this.col === this.xs.length - 1;
  }

  /** Remember the content height; note growth for the end-of-page wait. */
  private trackHeight(target: ScrollTarget): void {
    const h = target.content().h;
    if (Math.abs(h - this.lastContentH) > HEIGHT_EPS) this.grew = true;
    this.lastContentH = h;
  }

  private heightMoved(target: ScrollTarget): boolean {
    return Math.abs(target.content().h - this.lastContentH) > HEIGHT_EPS;
  }

  private inFixed(el: Element): boolean {
    for (let n: Element | null = el; n; n = n.parentElement) if (this.fixedEls.has(n)) return true;
    return false;
  }

  /**
   * Correct `at` for content that moved above the seam (see `capture/anchor.ts`). Updates
   * `shift`; flags `misaligned` when the movement can't be trusted or keeps changing.
   */
  private async reanchor(
    target: ScrollTarget,
    seam: Anchor[],
    at: Point,
    notes: SliceNotes,
    refH = this.lastContentH,
  ): Promise<{ pos: Point; anchors: Anchor[] }> {
    let anchors = seam;
    let pos = at;
    for (let pass = 0; pass < MAX_REANCHOR; pass++) {
      let c = seamShift(target, anchors);
      if (!c.reliable) {
        // Content above the seam can't move further than the document grew or shrank (short of
        // one thing growing while another shrinks): an anchor that did is in something that
        // moves by itself (a JS-positioned ad, a carousel). Drop those and vote again.
        const dh = Math.abs(target.content().h - refH) + 2 * HEIGHT_EPS;
        const shifts = anchorShifts(target, anchors);
        const plausible = anchors.filter((_, i) => Math.abs(shifts[i] ?? Number.NaN) <= dh);
        if (plausible.length > 0 && plausible.length < anchors.length) {
          const again = seamShift(target, plausible);
          if (again.reliable) {
            anchors = plausible;
            c = again;
          }
        }
      }
      if (!c.reliable) {
        trace(
          'unreliable',
          JSON.stringify({
            pass,
            n: c.n,
            shifts: anchorShifts(target, anchors),
            nodes: anchors.map((a) => {
              const el = a.node instanceof Element ? a.node : a.node.parentElement;
              return `${el?.tagName}#${el?.id}.${String(el?.className).slice(0, 40)} r${a.row}`;
            }),
          }),
        );
        if (c.moved || (c.n === 0 && this.heightMoved(target))) notes.misaligned = true;
        return { pos, anchors };
      }
      if (Math.abs(c.d) < MIN_SHIFT) return { pos, anchors };
      trace('reanchor', { pass, d: c.d, n: c.n, at: pos.y, shift: this.shift + c.d });
      this.shift += c.d;
      anchors = rebase(anchors, c.d);
      const want = { x: pos.x, y: pos.y + c.d };
      this.scrollTarget(target, want);
      await frames(2);
      this.alive();
      pos = await this.settledPosition(target, want);
    }
    // Still moving after every pass: say so rather than pretend the seam is exact.
    if (seamShift(target, anchors).moved) notes.misaligned = true;
    return { pos, anchors };
  }

  private finish(notes?: SliceNotes): StepResult {
    this.finished = true;
    return notes ? { t: 'done', notes } : { t: 'done' };
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

  /**
   * Classify a fixed element by its visible extent (own box plus visible descendants: a 0 px
   * wrapper around an absolutely positioned header is a header). `top`, `bottom` and `side`
   * floats are remembered, so their kind can't flip later in the capture; `shell` and `skip` ones
   * are re-checked when the DOM changes.
   */
  private classify(el: Styled): void {
    if (this.opts?.floating === 'keep' || this.floats.has(el) || !this.target || !el.style) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || Number(cs.opacity) === 0) return;
    if (!fixedToViewport(el)) return;
    const view = viewportSize();
    const area = this.target.clientRect();
    const containsTarget = !!this.target.el && el.contains(this.target.el);
    // Shells by their own box need no descendant walk (app shells can be huge).
    const own = clipRect(rectOf(el), { x: 0, y: 0, ...view });
    const isShell = containsTarget || own.w * own.h >= 0.5 * view.w * view.h;
    const rect = isShell ? rectOf(el) : visibleExtent(el, { x: 0, y: 0, ...view });
    const kind: FloatKind = classifyFloat(rect, view, area, {
      containsTarget,
      elementTarget: this.target.kind === 'element',
    });
    if (kind === 'top' || kind === 'bottom' || kind === 'side') this.floats.set(el, kind);
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
        if (pos === 'fixed') {
          this.fixedEls.add(el);
          this.classify(el as Styled);
        } else if (pos === 'sticky') this.unstick(el as Styled);
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
    if (this.restored) return;
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
      this.scrollTarget(target, { x: lim.x0, y });
      // IntersectionObserver runs after rAF callbacks in the same frame, so scrolling again from
      // a task queued in rAF lets this frame observe this position: one frame per viewport.
      await frames(1);
      await afterFrameTask();
      this.alive();
      lim = target.limits();
    }
    this.m.settleAnimations();
    // Lazy content changed the page: give it a moment to stop moving before planning.
    if (target.limits().y1 !== limits.y1) await this.waitForStableHeight(target);
    this.alive();
    return target.limits();
  }

  /** Wait until the scroll range is unchanged for `quietMs`, at most `capMs`. */
  private async waitForStableHeight(
    target: ScrollTarget,
    capMs = STABLE_WAIT_MS,
    quietMs = 300,
  ): Promise<void> {
    const t0 = performance.now();
    let last = target.limits().y1;
    let since = t0;
    while (performance.now() - t0 < capMs) {
      await sleep(50);
      this.alive();
      const now = target.limits().y1;
      if (now !== last) {
        last = now;
        since = performance.now();
      } else if (performance.now() - since >= quietMs) {
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
      this.alive();
      const next = target.get();
      if (next.x === at.x && next.y === at.y) break;
      at = next;
    }
    return target.get();
  }
}

/** The page URL without the hash (hash changes are in-page navigation, not a new page). */
function pageUrl(): string {
  return location.href.split('#')[0] ?? '';
}

/**
 * Scrolling is locked (a cookie wall or dialog set `overflow: hidden` / `position: fixed`) while
 * the content is clearly taller than the viewport.
 */
function scrollLocked(viewH: number): boolean {
  const html = document.documentElement;
  const body = document.body;
  if (!body) return false;
  const hs = getComputedStyle(html);
  const bs = getComputedStyle(body);
  const hidden = (v: string) => v === 'hidden' || v === 'clip';
  const locked = hidden(hs.overflowY) || hidden(bs.overflowY) || bs.position === 'fixed';
  return locked && Math.max(body.scrollHeight, body.offsetHeight) > viewH + 50;
}

/** Resolve in a task after the current frame's rendering steps. */
function afterFrameTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}
