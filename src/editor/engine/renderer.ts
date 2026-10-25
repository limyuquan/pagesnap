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
import { imageToScreen, rectsIntersect, shapeBounds, shapeHandles, visibleRect } from './geometry';
import { perf } from './perf';
import { type EditorState, useEditorStore } from './store';
import { TileCache } from './tiles';

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

    let prev = useEditorStore.getState();
    this.unsubscribe = useEditorStore.subscribe((s) => {
      const p = prev;
      prev = s;
      if (s.camera !== p.camera) {
        this.lastCamAt = performance.now();
        this.moving = true;
      }
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

    if (tiles) {
      const prefetch = { x: visible.x, y: visible.y - visible.h, w: visible.w, h: visible.h * 3 };
      tiles.update(visible, prefetch);
    }

    const resting = performance.now() - this.lastCamAt >= REST_MS;
    if (resting) this.moving = false;
    const hidden = new Set<ShapeId>(draft?.hidden ?? []);
    if (s.editingTextId) hidden.add(s.editingTextId);

    drawDoc(ctx, drawn, view, {
      drawBase: (c) => this.drawBase(c, view, visible, session.layout.background, !this.moving),
      hidden,
      cull: visible,
    });
    this.drawOverlay(drawn, draft?.selection ?? s.selection, draft?.marquee ?? null, s);

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

  /** Visible tiles at full resolution; placeholders where a tile hasn't decoded yet. */
  private drawBase(ctx: Ctx2D, view: View, visible: Rect, background: string, hq: boolean): void {
    const tiles = this.tiles;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = view.scale;
    const ox = (x: number) => Math.round((x - view.x) * s);
    const oy = (y: number) => Math.round((y - view.y) * s);
    // Pixel-exact above 200%; best downsampling otherwise ('low' while moving keeps frames cheap).
    ctx.imageSmoothingEnabled = s < 2;
    ctx.imageSmoothingQuality = hq ? 'high' : 'low';
    if (!tiles) return;
    for (const t of tiles.tiles) {
      if (!rectsIntersect(t.rect, visible)) continue;
      const x0 = ox(t.rect.x);
      const y0 = oy(t.rect.y);
      const w = ox(t.rect.x + t.rect.w) - x0;
      const h = oy(t.rect.y + t.rect.h) - y0;
      const bmp = tiles.get(t.index);
      if (bmp) {
        ctx.drawImage(bmp, x0, y0, w, h);
      } else {
        ctx.fillStyle = background;
        ctx.fillRect(x0, y0, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.04)';
        ctx.fillRect(x0, y0, w, h);
      }
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
      const b = shapeBounds(sh, dpr);
      const p0 = imageToScreen(cam, { x: b.x, y: b.y });
      const p1 = imageToScreen(cam, { x: b.x + b.w, y: b.y + b.h });
      const lineLike = sh.kind === 'arrow' || sh.kind === 'underline' || sh.kind === 'highlight';
      if (!lineLike) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.strokeRect(
          Math.round(p0.x - 3) + 0.5,
          Math.round(p0.y - 3) + 0.5,
          Math.round(p1.x - p0.x + 6),
          Math.round(p1.y - p0.y + 6),
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
    this.unsubscribe();
    for (const m of this.mql) m.media.removeEventListener('change', m.listener);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const d of this.disposers.splice(0)) d();
    this.tiles?.dispose();
    this.tiles = null;
  }
}
