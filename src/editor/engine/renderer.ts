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
import type { Point, Rect } from '@/shared/types';
import { drawDoc, type View } from './draw';
import {
  groupHandles,
  type Handle,
  imageToScreen,
  inflate,
  interactiveHandles,
  isRotatable,
  rectCenter,
  rotatedCorners,
  rotateHandlePoint,
  shapeFrame,
  shapeOutline,
  shapeRotation,
  shapesBounds,
  visibleRect,
} from './geometry';
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
  /** The mark under the pointer (hover outline). */
  hover?: ShapeId | null;
  /** Hide the handles (while moving: the frame alone reads cleaner). */
  noHandles?: boolean;
}

/** After the last camera change, wait this long before the high-quality "rest" redraw. */
const REST_MS = 140;
const SELECTION_COLOR = '#0A84FF';
/** Hover outline: the system focus blue at 60%. */
const HOVER_COLOR = 'rgba(10,132,255,0.6)';
/** Square handle side, endpoint and rotation handle radii, CSS px. */
const HANDLE_SIZE_CSS = 8;
const ENDPOINT_R_CSS = 5;
const MID_R_CSS = 4;
const ROT_R_CSS = 4.5;
const HANDLE_RING = 'rgba(28,28,30,0.72)';

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
    this.drawOverlay(drawn, draft?.selection ?? s.selection, draft, s);
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

  /**
   * Hover outline, selection frames, handles and the marquee, in CSS px (fixed size at any zoom).
   * Lines are snapped to the device-pixel grid where they're axis-aligned, so they stay crisp.
   */
  private drawOverlay(
    doc: AnnotationDoc,
    selection: readonly ShapeId[],
    draft: Draft | null,
    s: EditorState,
  ): void {
    const marquee = draft?.marquee ?? null;
    const hoverId = draft?.hover ?? null;
    if (selection.length === 0 && !marquee && !hoverId) return;
    const ctx = this.ctx;
    const D = this.dpr;
    const cam = s.camera;
    const dpr = doc.image.dpr;
    const toS = (p: Point) => imageToScreen(cam, p);
    // A 1 CSS px line is crisp centred on a device pixel (odd device width) or on a boundary.
    const off = Math.round(D) % 2 === 1 ? 0.5 : 0;
    const snap = (v: number) => (Math.round(v * D - off) + off) / D;
    ctx.save();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.lineWidth = 1;
    ctx.lineJoin = 'miter';

    const poly = (pts: readonly Point[], closed: boolean, crisp: boolean) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = toS(p);
        const x = crisp ? snap(q.x) : q.x;
        const y = crisp ? snap(q.y) : q.y;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (closed) ctx.closePath();
      ctx.stroke();
    };

    /** A mark's outline; frames sit half a pixel outside the ink so the line never covers it. */
    const outline = (sh: (typeof doc.shapes)[number]) => {
      const rot = shapeRotation(sh);
      if (isRotatable(sh)) {
        const f = shapeFrame(sh);
        poly(rotatedCorners(inflate(f, 0.5 / cam.zoom), rectCenter(f), rot), true, rot === 0);
        return;
      }
      const o = shapeOutline(sh);
      poly(o.pts, o.closed, rot === 0);
    };

    const sel = new Set(selection);
    const shapes = doc.shapes.filter((sh) => sel.has(sh.id) && sh.id !== s.editingTextId);

    // Hover: trace the mark under the pointer (not one that's already selected).
    if (hoverId && !sel.has(hoverId) && hoverId !== s.editingTextId) {
      const h = doc.shapes.find((sh) => sh.id === hoverId);
      if (h) {
        ctx.strokeStyle = HOVER_COLOR;
        outline(h);
      }
    }

    if (shapes.length === 1) {
      const only = shapes[0] as (typeof shapes)[number];
      ctx.strokeStyle = SELECTION_COLOR;
      if (isRotatable(only)) {
        const rot = only.rotation ?? 0;
        outline(only);
        if (!draft?.noHandles) {
          // Hairline from the top edge to the rotation handle.
          const r = rotateHandlePoint(only, cam.zoom);
          poly([r.base, r.at], false, rot === 0);
        }
      }
      if (!draft?.noHandles) {
        for (const h of interactiveHandles(only, cam.zoom)) this.drawHandle(h, only, cam, snap);
      }
    } else if (shapes.length > 1) {
      ctx.strokeStyle = HOVER_COLOR;
      for (const sh of shapes) outline(sh);
      const g = shapesBounds(shapes, dpr);
      if (g) {
        ctx.strokeStyle = SELECTION_COLOR;
        poly(rotatedCorners(g, rectCenter(g), 0), true, true);
        if (!draft?.noHandles) {
          for (const h of groupHandles(g)) this.drawHandle(h, null, cam, snap);
        }
      }
    }
    if (marquee) {
      const p0 = toS(marquee);
      const p1 = toS({ x: marquee.x + marquee.w, y: marquee.y + marquee.h });
      ctx.fillStyle = 'rgba(10,132,255,0.08)';
      ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(snap(p0.x), snap(p0.y), snap(p1.x) - snap(p0.x), snap(p1.y) - snap(p0.y));
    }
    ctx.restore();
  }

  /** One handle: white fill, dark hairline ring, a soft drop shadow; squares turn with the shape. */
  private drawHandle(
    h: Handle,
    shape: AnnotationDoc['shapes'][number] | null,
    cam: EditorState['camera'],
    snap: (v: number) => number,
  ): void {
    const ctx = this.ctx;
    const p = imageToScreen(cam, h);
    const rot = shape ? shapeRotation(shape) : 0;
    ctx.save();
    ctx.beginPath();
    if (h.id === 'a' || h.id === 'b') {
      ctx.arc(p.x, p.y, ENDPOINT_R_CSS, 0, Math.PI * 2);
    } else if (h.id === 'mid') {
      ctx.arc(p.x, p.y, MID_R_CSS, 0, Math.PI * 2);
    } else if (h.id === 'rot') {
      ctx.arc(p.x, p.y, ROT_R_CSS, 0, Math.PI * 2);
    } else {
      // Text wrap handles (e/w) are upright pills; the rest are squares.
      const pill = shape?.kind === 'text' && (h.id === 'e' || h.id === 'w');
      const w = pill ? 5 : HANDLE_SIZE_CSS;
      const ht = pill ? 14 : HANDLE_SIZE_CSS;
      if (rot) {
        ctx.translate(p.x, p.y);
        ctx.rotate(rot);
        ctx.roundRect(-w / 2, -ht / 2, w, ht, pill ? 2.5 : 1.5);
      } else {
        const x = snap(p.x - w / 2);
        const y = snap(p.y - ht / 2);
        ctx.roundRect(x, y, w, ht, pill ? 2.5 : 1.5);
      }
    }
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 3 * this.dpr;
    ctx.shadowOffsetY = 0.5 * this.dpr;
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = HANDLE_RING;
    ctx.lineWidth = 1;
    ctx.stroke();
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
