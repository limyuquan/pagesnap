/**
 * Viewport renderer (owner: B): one viewport-sized canvas, redrawn on demand (rAF-coalesced).
 * Each frame paints the visible base tiles, then `drawDoc` (the same function the export uses),
 * then the selection overlay in screen space.
 *
 * It reads committed state from the store directly (no React) and per-frame drag state through
 * a draft provider set by the controller.
 */
import type { AnnotationDoc, ShapeId } from '@/shared/annotations';
import type { Ctx2D } from '@/shared/composite';
import type { Rect } from '@/shared/types';
import { drawDoc, type View } from './draw';
import { imageToScreen, shapeBounds, shapeHandles, visibleRect } from './geometry';
import { perf } from './perf';
import { type EditorState, useEditorStore } from './store';
import { type LevelTile, levelForScale, TileCache } from './tiles';

/** What the controller wants drawn on top of the committed state this frame. */
export interface Draft {
  /** Replaces the committed doc for this frame (in-progress shape or transform). */
  doc?: AnnotationDoc;
  /** Overrides the selection outline (e.g. during a move). */
  selection?: readonly ShapeId[];
  /** Marquee rect in image px. */
  marquee?: Rect | null;
  /** Hide shapes (text in the overlay editor). */
  hidden?: ReadonlySet<ShapeId>;
}

/** After the last camera change, wait this long before the high-quality "rest" redraw. */
const REST_MS = 140;
const SELECTION_COLOR = '#0A84FF';
const HANDLE_SIZE_CSS = 8;

/** Copied-region flash (design review §5.5): fade in, hold, fade out. */
export const FLASH_IN_MS = 120;
export const FLASH_HOLD_MS = 500;
export const FLASH_OUT_MS = 420;
/** With reduced motion: a static outline for this long, no animation. */
export const FLASH_STATIC_MS = 900;
const FLASH_DIM = 0.28;

/** `--ps-ease-out`-like curve (cubic-bezier(0.16, 1, 0.3, 1) is close to an exponential out). */
function easeOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - (1 - x) ** 3;
}

/** Opacity of the flash `t` ms after it started (0 once it's over). */
export function flashAlpha(t: number, reducedMotion: boolean): number {
  if (t < 0) return 0;
  if (reducedMotion) return t < FLASH_STATIC_MS ? 1 : 0;
  if (t < FLASH_IN_MS) return easeOut(t / FLASH_IN_MS);
  if (t < FLASH_IN_MS + FLASH_HOLD_MS) return 1;
  const u = (t - FLASH_IN_MS - FLASH_HOLD_MS) / FLASH_OUT_MS;
  return u >= 1 ? 0 : 1 - easeOut(u);
}

interface Flash {
  /** Image px. */
  region: Rect;
  start: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private tiles: TileCache | null = null;
  private tilesFor: EditorState['source'] = null;
  private raf = 0;
  private draftProvider: (() => Draft | null) | null = null;
  private dpr = 1;
  private lastCamAt = 0;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private moving = false;
  private backdrop = '#ececee';
  private flash: Flash | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private unsubscribe: () => void;
  private readonly disposers: (() => void)[] = [];
  private readonly mql: { media: MediaQueryList; listener: () => void }[] = [];
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.tiles?.trim();
    else this.invalidate();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: false });
    if (!ctx) throw new Error('No 2D context');
    this.ctx = ctx;
    this.readBackdrop();
    this.watchDpr();
    // C themes the surround with `--ps-canvas-bg`; follow light/dark switches live.
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      this.readBackdrop();
      this.invalidate();
    };
    scheme.addEventListener('change', onScheme);
    this.disposers.push(() => scheme.removeEventListener('change', onScheme));
    document.addEventListener('visibilitychange', this.onVisibility);
    if (import.meta.env.MODE === 'e2e') {
      const hook = (window as unknown as { __pagesnapEngine?: Record<string, unknown> })
        .__pagesnapEngine;
      if (hook) {
        hook.tiles = () => this.tiles?.stats ?? null;
        hook.flash = () => this.flashState;
      }
    }

    let prev = useEditorStore.getState();
    this.unsubscribe = useEditorStore.subscribe((s) => {
      const p = prev;
      prev = s;
      if (s.camera !== p.camera) {
        this.lastCamAt = performance.now();
        this.moving = true;
      }
      if (s.copy !== p.copy && s.copy.state === 'copied') this.startFlash(s);
      if (
        s.doc !== p.doc ||
        s.camera !== p.camera ||
        s.viewport !== p.viewport ||
        s.selection !== p.selection ||
        s.source !== p.source ||
        s.editingTextId !== p.editingTextId ||
        s.load !== p.load
      ) {
        this.invalidate();
      }
    });
    this.invalidate();
  }

  setDraftProvider(fn: (() => Draft | null) | null): void {
    this.draftProvider = fn;
    this.invalidate();
  }

  /** Request a redraw on the next animation frame (coalesced). */
  invalidate(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0;
      this.frame(t);
    });
  }

  /** Re-read the backdrop colour (`--ps-canvas-bg` on the canvas, set by C's CSS). */
  readBackdrop(): void {
    const v = getComputedStyle(this.canvas).getPropertyValue('--ps-canvas-bg').trim();
    if (v) this.backdrop = v;
  }

  get tileCache(): TileCache | null {
    return this.tiles;
  }

  /** Flash the region a copy just put on the clipboard (image px). */
  startFlash(s: EditorState): void {
    if (s.copy.state !== 'copied' || !s.session) return;
    const region = s.copy.scope?.region ?? {
      x: 0,
      y: 0,
      w: s.session.image.w,
      h: s.session.image.h,
    };
    this.flash = { region, start: performance.now() };
    this.invalidate();
  }

  /** Flash state for tests: the region and its opacity right now (null when none). */
  get flashState(): { region: Rect; alpha: number } | null {
    const f = this.flash;
    if (!f) return null;
    return {
      region: f.region,
      alpha: flashAlpha(performance.now() - f.start, this.reducedMotion.matches),
    };
  }

  private watchDpr(): void {
    for (const m of this.mql) m.media.removeEventListener('change', m.listener);
    this.mql.length = 0;
    this.dpr = window.devicePixelRatio || 1;
    const media = matchMedia(`(resolution: ${this.dpr}dppx)`);
    const listener = () => {
      this.watchDpr();
      this.invalidate();
    };
    media.addEventListener('change', listener);
    this.mql.push({ media, listener });
  }

  private ensureTiles(s: EditorState): TileCache | null {
    if (s.source !== this.tilesFor) {
      this.tiles?.dispose();
      this.tiles = s.source ? new TileCache(s.source, () => this.invalidate()) : null;
      this.tilesFor = s.source;
    }
    return this.tiles;
  }

  private frame(stamp: number): void {
    const t0 = performance.now();
    const s = useEditorStore.getState();
    const { viewport } = s;
    const D = this.dpr;
    const W = Math.max(1, Math.round(viewport.w * D));
    const H = Math.max(1, Math.round(viewport.h * D));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.backdrop;
    ctx.fillRect(0, 0, W, H);

    const session = s.session;
    const doc = s.doc;
    const tiles = this.ensureTiles(s);
    if (!session || !doc || viewport.w <= 0) return;

    // Snap the camera to the device-pixel grid so tiles land on whole pixels (crisp at rest).
    const scale = s.camera.zoom * D;
    const view: View = {
      x: Math.round(s.camera.x * scale) / scale,
      y: Math.round(s.camera.y * scale) / scale,
      scale,
    };
    const visible = visibleRect(s.camera, viewport);
    const draft = this.draftProvider?.() ?? null;
    const drawn = draft?.doc ?? doc;

    const level = tiles ? levelForScale(scale, tiles.maxLevel) : 0;
    if (tiles) {
      const prefetch = { x: visible.x, y: visible.y - visible.h, w: visible.w, h: visible.h * 3 };
      tiles.update(visible, prefetch, level);
    }

    const resting = performance.now() - this.lastCamAt >= REST_MS;
    if (resting) this.moving = false;
    const hidden = new Set<ShapeId>(draft?.hidden ?? []);
    if (s.editingTextId) hidden.add(s.editingTextId);

    drawDoc(ctx, drawn, view, {
      drawBase: (c) =>
        this.drawBase(c, view, visible, level, session.layout.background, !this.moving),
      hidden,
      cull: visible,
    });
    this.drawOverlay(drawn, draft?.selection ?? s.selection, draft?.marquee ?? null, s);
    this.drawFlash(s);

    if (s.load.phase === 'loading' && tiles?.covers(visible)) s._engine._firstPaint();
    if (this.moving) this.scheduleRest();
    perf.recordFrame(performance.now() - t0, stamp);
  }

  private scheduleRest(): void {
    if (this.restTimer) return;
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      this.invalidate();
    }, REST_MS);
  }

  /**
   * Visible tiles of `level`. Where one hasn't loaded yet, whatever else is resident is drawn in
   * its place (coarser levels first, then finer ones), over a neutral placeholder.
   */
  private drawBase(
    ctx: Ctx2D,
    view: View,
    visible: Rect,
    level: number,
    background: string,
    hq: boolean,
  ): void {
    const tiles = this.tiles;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = view.scale;
    const ox = (x: number) => Math.round((x - view.x) * s);
    const oy = (y: number) => Math.round((y - view.y) * s);
    // Pixel-exact above 200%; best downsampling otherwise ('low' while moving keeps frames cheap).
    ctx.imageSmoothingEnabled = s < 2;
    ctx.imageSmoothingQuality = hq ? 'high' : 'low';
    if (!tiles) return;
    const box = (t: LevelTile) => {
      const x0 = ox(t.rect.x);
      const y0 = oy(t.rect.y);
      return { x: x0, y: y0, w: ox(t.rect.x + t.rect.w) - x0, h: oy(t.rect.y + t.rect.h) - y0 };
    };
    const missing: LevelTile[] = [];
    for (const t of tiles.tilesIn(level, visible)) {
      const bmp = tiles.get(t);
      if (!bmp) {
        missing.push(t);
        continue;
      }
      const b = box(t);
      ctx.drawImage(bmp, b.x, b.y, b.w, b.h);
    }
    if (missing.length === 0) return;
    ctx.save();
    const clip = new Path2D();
    let union: Rect | null = null;
    for (const t of missing) {
      const b = box(t);
      clip.rect(b.x, b.y, b.w, b.h);
      union = union
        ? {
            x: Math.min(union.x, t.rect.x),
            y: Math.min(union.y, t.rect.y),
            w: Math.max(union.x + union.w, t.rect.x + t.rect.w) - Math.min(union.x, t.rect.x),
            h: Math.max(union.y + union.h, t.rect.y + t.rect.h) - Math.min(union.y, t.rect.y),
          }
        : { ...t.rect };
    }
    ctx.clip(clip);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (union) {
      const area = intersectRect(union, visible);
      if (area) {
        for (const f of tiles.fallbacks(area, level)) {
          const b = box(f.tile);
          ctx.drawImage(f.bitmap, b.x, b.y, b.w, b.h);
        }
      }
    }
    ctx.restore();
  }

  /** The copied-region flash: dim outside, white outline with a dark hairline ring. */
  private drawFlash(s: EditorState): void {
    const f = this.flash;
    if (!f) return;
    const reduced = this.reducedMotion.matches;
    const t = performance.now() - f.start;
    const a = flashAlpha(t, reduced);
    if (a <= 0) {
      this.flash = null;
      return;
    }
    const ctx = this.ctx;
    const D = this.dpr;
    const cam = s.camera;
    const p0 = imageToScreen(cam, { x: f.region.x, y: f.region.y });
    const p1 = imageToScreen(cam, { x: f.region.x + f.region.w, y: f.region.y + f.region.h });
    const x = Math.round(p0.x * D) / D;
    const y = Math.round(p0.y * D) / D;
    const w = Math.round(p1.x * D) / D - x;
    const h = Math.round(p1.y * D) / D - y;
    ctx.save();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.globalAlpha = a;
    if (!reduced) {
      const vw = this.canvas.width / D;
      const vh = this.canvas.height / D;
      const dim = new Path2D();
      dim.rect(0, 0, vw, vh);
      dim.rect(x, y, w, h);
      ctx.fillStyle = `rgba(0,0,0,${FLASH_DIM})`;
      ctx.fill(dim, 'evenodd');
    }
    // 2 px white just outside the region, then a 1 px dark ring outside that.
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeRect(x - 2.5, y - 2.5, w + 5, h + 5);
    ctx.restore();
    if (!reduced) {
      this.invalidate();
    } else if (!this.flashTimer) {
      // Static: one frame to show it, one to take it away.
      this.flashTimer = setTimeout(
        () => {
          this.flashTimer = null;
          this.invalidate();
        },
        Math.max(0, FLASH_STATIC_MS - t) + 5,
      );
    }
  }

  /** Selection boxes, handles and the marquee, in CSS px (fixed size at any zoom). */
  private drawOverlay(
    doc: AnnotationDoc,
    selection: readonly ShapeId[],
    marquee: Rect | null,
    s: EditorState,
  ): void {
    if (selection.length === 0 && !marquee) return;
    const ctx = this.ctx;
    const D = this.dpr;
    const cam = s.camera;
    const dpr = doc.image.dpr;
    ctx.save();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.lineWidth = 1;
    const sel = new Set(selection);
    const shapes = doc.shapes.filter((sh) => sel.has(sh.id) && sh.id !== s.editingTextId);
    for (const sh of shapes) {
      // Rects: on the stroke centre, where the handles are (design §3); others: their bounds.
      const b = sh.kind === 'rect' ? sh.box : shapeBounds(sh, dpr);
      const out = sh.kind === 'rect' ? 0 : 3;
      const p0 = imageToScreen(cam, { x: b.x, y: b.y });
      const p1 = imageToScreen(cam, { x: b.x + b.w, y: b.y + b.h });
      const lineLike = sh.kind === 'arrow' || sh.kind === 'underline' || sh.kind === 'highlight';
      if (!lineLike) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.strokeRect(
          Math.round(p0.x - out) + 0.5,
          Math.round(p0.y - out) + 0.5,
          Math.round(p1.x - p0.x + 2 * out),
          Math.round(p1.y - p0.y + 2 * out),
        );
        ctx.setLineDash([]);
      }
    }
    if (shapes.length === 1) {
      const only = shapes[0];
      if (only) {
        const half = HANDLE_SIZE_CSS / 2;
        for (const h of shapeHandles(only)) {
          const p = imageToScreen(cam, h);
          ctx.beginPath();
          if (h.id === 'a' || h.id === 'b') ctx.arc(p.x, p.y, half + 1, 0, Math.PI * 2);
          else
            ctx.rect(
              Math.round(p.x - half) + 0.5,
              Math.round(p.y - half) + 0.5,
              HANDLE_SIZE_CSS,
              HANDLE_SIZE_CSS,
            );
          // A faint dark ring first, so white handles still read on a red stroke.
          ctx.strokeStyle = 'rgba(0,0,0,0.25)';
          ctx.lineWidth = 3.5;
          ctx.stroke();
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.strokeStyle = SELECTION_COLOR;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    } else if (shapes.length > 1) {
      // Line-like shapes get endpoint dots so multi-selections stay legible.
      for (const sh of shapes) {
        for (const h of shapeHandles(sh)) {
          if (h.id !== 'a' && h.id !== 'b') continue;
          const p = imageToScreen(cam, h);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = SELECTION_COLOR;
          ctx.fill();
        }
      }
    }
    if (marquee) {
      const p0 = imageToScreen(cam, marquee);
      const p1 = imageToScreen(cam, { x: marquee.x + marquee.w, y: marquee.y + marquee.h });
      ctx.fillStyle = 'rgba(10,132,255,0.08)';
      ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(p0.x) + 0.5,
        Math.round(p0.y) + 0.5,
        Math.round(p1.x - p0.x),
        Math.round(p1.y - p0.y),
      );
    }
    ctx.restore();
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.restTimer) clearTimeout(this.restTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.unsubscribe();
    for (const m of this.mql) m.media.removeEventListener('change', m.listener);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const d of this.disposers.splice(0)) d();
    this.tiles?.dispose();
    this.tiles = null;
  }
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}
