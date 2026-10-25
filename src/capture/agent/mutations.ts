/**
 * Every change the agent makes to the page goes through `PageMutations`, so `restore()` can undo
 * all of it exactly and idempotently (01 §5.5). Per-element overrides are inline `!important`
 * styles (they also reach elements inside shadow roots, where a document stylesheet can't), with
 * the original value, priority and the presence of the `style` attribute saved first.
 */

type Styled = Element & ElementCSSInlineStyle;

interface SavedProp {
  value: string;
  priority: string;
}

interface SavedElement {
  hadStyleAttr: boolean;
  props: Map<string, SavedProp>;
}

/** Page-wide rules. Nothing here is visible except the scrollbars going away. */
const CAPTURE_CSS = `
html, body { scroll-behavior: auto !important; overflow-anchor: none !important; scrollbar-width: none !important; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
*, *::before, *::after { transition: none !important; caret-color: transparent !important; }
`;

export class PageMutations {
  private readonly saved = new Map<Styled, SavedElement>();
  private sheet: HTMLStyleElement | null = null;
  private readonly lazy: (HTMLImageElement | HTMLIFrameElement)[] = [];
  private readonly paused: Animation[] = [];
  private readonly videos: HTMLMediaElement[] = [];
  private restored = false;

  addCaptureSheet(): void {
    if (this.sheet) return;
    const el = document.createElement('style');
    el.setAttribute('data-pagesnap', '');
    el.textContent = CAPTURE_CSS;
    (document.head ?? document.documentElement).append(el);
    this.sheet = el;
  }

  /** Set `prop: value !important` inline, remembering the original once. */
  setStyle(el: Styled, prop: string, value: string): void {
    let rec = this.saved.get(el);
    if (!rec) {
      rec = { hadStyleAttr: el.hasAttribute('style'), props: new Map() };
      this.saved.set(el, rec);
    }
    if (!rec.props.has(prop)) {
      rec.props.set(prop, {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      });
    }
    if (
      el.style.getPropertyValue(prop) !== value ||
      el.style.getPropertyPriority(prop) !== 'important'
    ) {
      el.style.setProperty(prop, value, 'important');
    }
  }

  /** Put one property back to its original inline value (no-op if never set). */
  resetStyle(el: Styled, prop: string): void {
    const rec = this.saved.get(el);
    const orig = rec?.props.get(prop);
    if (!rec || !orig) return;
    restoreProp(el, prop, orig);
    rec.props.delete(prop);
    if (rec.props.size === 0) {
      if (!rec.hadStyleAttr && el.getAttribute('style') === '') el.removeAttribute('style');
      this.saved.delete(el);
    }
  }

  hasStyle(el: Styled, prop: string): boolean {
    return this.saved.get(el)?.props.has(prop) ?? false;
  }

  makeEager(el: HTMLImageElement | HTMLIFrameElement): void {
    if (el.loading !== 'lazy') return;
    el.loading = 'eager';
    this.lazy.push(el);
  }

  /** Finish finite animations (scroll-reveal etc.) and pause infinite ones (spinners). */
  settleAnimations(): void {
    let list: Animation[] = [];
    try {
      list = document.getAnimations();
    } catch {
      return;
    }
    for (const a of list) {
      if (a.playState !== 'running' || a.timeline !== document.timeline) continue;
      try {
        const iterations = a.effect?.getComputedTiming().iterations ?? 1;
        if (iterations === Number.POSITIVE_INFINITY) {
          a.pause();
          this.paused.push(a);
        } else {
          a.finish();
        }
      } catch {
        // finish() throws for zero playback rate or infinite end time: leave it alone.
      }
    }
  }

  pauseVideos(): void {
    for (const v of document.querySelectorAll('video')) {
      if (!v.paused && !v.ended) {
        v.pause();
        this.videos.push(v);
      }
    }
  }

  /** Undo everything. Safe to call more than once. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.sheet?.remove();
    this.sheet = null;
    for (const [el, rec] of this.saved) {
      for (const [prop, orig] of rec.props) restoreProp(el, prop, orig);
      if (!rec.hadStyleAttr && el.getAttribute('style') === '') el.removeAttribute('style');
    }
    this.saved.clear();
    for (const el of this.lazy) el.loading = 'lazy';
    this.lazy.length = 0;
    for (const a of this.paused) {
      try {
        a.play();
      } catch {
        // The page may have cancelled it meanwhile.
      }
    }
    this.paused.length = 0;
    for (const v of this.videos) void v.play().catch(() => {});
    this.videos.length = 0;
  }
}

function restoreProp(el: Styled, prop: string, orig: SavedProp): void {
  if (orig.value) el.style.setProperty(prop, orig.value, orig.priority);
  else el.style.removeProperty(prop);
}
