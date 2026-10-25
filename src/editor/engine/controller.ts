/**
 * Canvas interaction controller (owner: B). Imperative on purpose: pointer and wheel input never
 * go through React. During a gesture the in-progress shape lives here and reaches the screen via
 * the renderer's draft provider (once per animation frame); the store only sees the result on
 * pointer-up, as one undo step.
 *
 * Also owns the text-editing <textarea> overlay and the hidden composite <img> that makes the
 * native right-click "Copy image" copy the annotated result (03 §4.3).
 */
import {
  type AnnotationDoc,
  DEFAULT_HIGHLIGHT_OPACITY,
  type Shape,
  type ShapeId,
  type TextShape,
} from '@/shared/annotations';
import { newId } from '@/shared/ids';
import type { Point, Rect } from '@/shared/types';
import {
  ARROW_HEAD_MIN_CSS,
  ARROW_HEAD_WIDTHS,
  type BoxHandle,
  boxPoint,
  dist,
  dragHandle,
  FONT_STACK,
  groupScale,
  type HandleId,
  HIT_TOLERANCE_CSS,
  handleAngle,
  hitGroupHandle,
  hitHandle,
  hitTestShapes,
  imageToScreen,
  interactiveHandles,
  pointInRect,
  rectFromPoints,
  scaleShape,
  screenToImage,
  shapesBounds,
  shapesInRect,
  snapAngle,
  squareFrom,
  TEXT_LINE_HEIGHT,
  TEXT_OUTLINE_RATIO,
  textLayout,
  translateShape,
  zoomAround,
  zoomLimits,
} from './geometry';
import { type Draft, Renderer } from './renderer';
import { isInteractiveTarget, pageBy } from './shortcuts';
import { type DrawTool, type EditorState, useEditorStore } from './store';

/** Below this on-screen length (CSS px) a drag is a click: no shape is created. */
const MIN_DRAG_CSS = 5;
/** A press on a mark moves it only once the pointer has travelled this far (CSS px). */
const MOVE_SLOP_CSS = 3;
/** Handle grab radius, CSS px. */
const HANDLE_HIT_CSS = 10;

type Gesture =
  | { kind: 'pan'; pointerId: number; start: Point; cam: { x: number; y: number } }
  | {
      kind: 'draw';
      pointerId: number;
      tool: DrawTool;
      start: Point;
      cur: Point;
      shift: boolean;
      alt: boolean;
      /** Highlighter with Shift at pointer-down: freehand marker. */
      marker: boolean;
      pts: [number, number, number][];
      id: ShapeId;
    }
  | {
      kind: 'move';
      pointerId: number;
      start: Point;
      cur: Point;
      ids: ReadonlySet<ShapeId>;
      shift: boolean;
      /** Past the slop: the marks follow the pointer. */
      moved: boolean;
      /** Alt-drag on the selection: original id → copy id (the copies move, the originals stay). */
      dup: ReadonlyMap<ShapeId, ShapeId> | null;
      /** Text tool pressed on the already-selected text: a click (no move) edits it. */
      editOnClick: TextShape | null;
    }
  | {
      kind: 'handle';
      pointerId: number;
      shape: Shape;
      handle: HandleId;
      start: Point;
      cur: Point;
      /** Handle position minus the press point: the handle keeps its offset from the pointer. */
      grab: Point;
      /** Past the slop (a click on a handle changes nothing). */
      moved: boolean;
      shift: boolean;
      alt: boolean;
    }
  | {
      kind: 'group';
      pointerId: number;
      /** The selected marks at the press, and their group box. */
      shapes: ReadonlyMap<ShapeId, Shape>;
      bounds: Rect;
      handle: BoxHandle;
      start: Point;
      cur: Point;
      grab: Point;
      moved: boolean;
      alt: boolean;
    }
  | { kind: 'marquee'; pointerId: number; start: Point; cur: Point; base: readonly ShapeId[] };

/** What a press at a point would grab. */
type HandleTarget =
  | { kind: 'shape'; shape: Shape; handle: HandleId; at: Point }
  | { kind: 'group'; shapes: Shape[]; bounds: Rect; handle: BoxHandle; at: Point };

interface TextEdit {
  shape: TextShape;
  isNew: boolean;
}

const isTypingTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'INPUT' ||
    t.tagName === 'SELECT');

/** Space on a page-down: it pages only if the key was tapped, not held for a drag. */
const SPACE_TAP_MS = 500;

const svgCursor = (svg: string, hot: number, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, ${fallback}`;
/** Pen: a 2 px dot with a white rim (design §6: drawing a stroke from a hairline is fiddly). */
const PEN_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="2.5" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>',
  8,
  'crosshair',
);
/** Highlighter: a short flat bar, like the band it draws, centred on the hot spot. */
const HIGHLIGHT_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="2.5" y="5.5" width="11" height="5" rx="1" fill="#000" fill-opacity=".55" stroke="#fff" stroke-width="1.5"/><rect x="7.25" y="7.25" width="1.5" height="1.5" fill="#fff"/></svg>',
  8,
  'crosshair',
);

const CSS_RESIZE = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const;
const cursorCache = new Map<string, string>();

/** Angle (radians) bucketed to 15°, as whole degrees in [0, 360). */
function bucketDeg(angle: number): number {
  const deg = Math.round((angle * 180) / Math.PI / 15) * 15;
  return ((deg % 360) + 360) % 360;
}

/**
 * A double-headed resize arrow pointing along `angle` (so handles of rotated marks get a cursor
 * that matches their direction), black with a white rim like the system's. Falls back to the
 * nearest of the four CSS resize cursors.
 */
function resizeCursor(angle: number): string {
  const deg = bucketDeg(angle) % 180;
  const key = `r${deg}`;
  const hit = cursorCache.get(key);
  if (hit) return hit;
  const fallback = CSS_RESIZE[Math.round(deg / 45) % 4] as string;
  const c = svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><g transform="rotate(${deg} 12 12)"><path d="M2.5 12 7.5 7v3.6h9V7l5 5-5 5v-3.6h-9V17z" fill="#000" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></g></svg>`,
    12,
    fallback,
  );
  cursorCache.set(key, c);
  return c;
}

/** A curved two-headed arrow for the rotation handle, turned with the mark. */
function rotateCursor(angle: number): string {
  const deg = bucketDeg(angle);
  const key = `o${deg}`;
  const hit = cursorCache.get(key);
  if (hit) return hit;
  const arc = 'M6.4 14.2Q12 6.6 17.6 14.2';
  const heads = 'M19.6 16.6 15.2 14.6 19.4 11.2zM4.4 16.6 8.8 14.6 4.6 11.2z';
  const c = svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><g transform="rotate(${deg} 12 12)"><path d="${arc}" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="${heads}" fill="#fff" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><path d="${arc}" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/><path d="${heads}" fill="#000"/></g></svg>`,
    12,
    'grab',
  );
  cursorCache.set(key, c);
  return c;
}

/** Cursor over a handle: a resize arrow along its direction, the rotate arrow, or a pointer. */
function handleCursor(shape: Shape | null, h: HandleId): string {
  if (h === 'rot') return rotateCursor(handleAngle(shape, h));
  if (h === 'a' || h === 'b') return 'crosshair';
  if (h === 'mid') return 'pointer';
  return resizeCursor(handleAngle(shape, h));
}

export class CanvasController {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly img: HTMLImageElement;
  readonly renderer: Renderer;
  private gesture: Gesture | null = null;
  private edit: TextEdit | null = null;
  private spaceHeld = false;
  /** Space went down at this time without a pan since (a tap pages down on key-up). */
  private spaceTap: { at: number; shift: boolean } | null = null;
  private rect: DOMRect | null = null;
  private readonly cleanups: (() => void)[] = [];
  private lastHoverCursor = '';
  /** The mark under the pointer (hover outline), and where the pointer last was. */
  private hoverId: ShapeId | null = null;
  private lastPointer: { clientX: number; clientY: number } | null = null;

  constructor(
    root: HTMLElement,
    canvas: HTMLCanvasElement,
    textarea: HTMLTextAreaElement,
    img: HTMLImageElement,
  ) {
    this.root = root;
    this.canvas = canvas;
    this.textarea = textarea;
    this.img = img;
    this.renderer = new Renderer(canvas);
    this.renderer.setDraftProvider(() => this.draft());
    if (import.meta.env.MODE === 'e2e') {
      const hook = (window as unknown as { __pagesnapEngine?: Record<string, unknown> })
        .__pagesnapEngine;
      if (hook) hook.hover = () => this.hoverId;
    }

    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window | Document,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    on(canvas, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onPointerCancel(e));
    on(canvas, 'lostpointercapture', (e: PointerEvent) => this.onPointerCancel(e));
    on(canvas, 'dblclick', (e: MouseEvent) => this.onDoubleClick(e));
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(
      root,
      'wheel',
      (e: WheelEvent) => {
        if (e.target !== canvas) this.onWheel(e);
      },
      { passive: false },
    );
    // Safari-style gesture events would zoom the page; Chrome sends ctrl+wheel instead.
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true), { capture: true });
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false), { capture: true });
    on(canvas, 'pointerleave', () => {
      if (!this.gesture) this.setHover(null);
    });
    on(window, 'blur', () => {
      this.spaceHeld = false;
      this.updateCursor();
    });

    // Text overlay.
    on(textarea, 'keydown', (e: KeyboardEvent) => this.onTextKey(e));
    on(textarea, 'input', () => this.layoutTextarea());
    on(textarea, 'blur', () => this.commitText());

    // Right-click: make the composite <img> the context-menu target.
    on(img, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 2) this.releaseImg();
    });
    on(img, 'contextmenu', () => {
      this.imgMenuOpen = true;
    });
    on(img, 'pointermove', () => {
      if (this.imgMenuOpen) this.releaseImg();
    });
    on(
      img,
      'wheel',
      (e: WheelEvent) => {
        this.releaseImg();
        this.onWheel(e);
      },
      { passive: false },
    );

    const ro = new ResizeObserver(() => this.measure());
    ro.observe(root);
    this.cleanups.push(() => ro.disconnect());
    this.measure();

    let prev = useEditorStore.getState();
    const unsub = useEditorStore.subscribe((s) => {
      const p = prev;
      prev = s;
      if (s._compositeUrl !== p._compositeUrl) this.setComposite(s._compositeUrl);
      if (s.tool !== p.tool) {
        if (this.edit && s.tool !== 'text') this.commitText();
        this.updateCursor();
      }
      if (this.edit && (s.camera !== p.camera || s.viewport !== p.viewport)) this.layoutTextarea();
      if (s.doc !== p.doc && this.gesture && this.gesture.kind !== 'pan') {
        // Undo/redo mid-gesture: drop the gesture rather than commit against a stale doc.
        this.gesture = null;
        this.renderer.invalidate();
      }
    });
    this.cleanups.push(unsub);
    this.setComposite(useEditorStore.getState()._compositeUrl);
    this.updateCursor();
  }

  private imgMenuOpen = false;

  dispose(): void {
    if (this.edit) this.commitText();
    for (const c of this.cleanups.splice(0)) c();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ geometry helpers

  private measure(): void {
    const r = this.root.getBoundingClientRect();
    this.rect = this.canvas.getBoundingClientRect();
    this.renderer.readBackdrop();
    useEditorStore
      .getState()
      ._engine._setViewport({ w: Math.round(r.width), h: Math.round(r.height) });
    this.renderer.invalidate();
  }

  private local(e: { clientX: number; clientY: number }): Point {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toImage(e: { clientX: number; clientY: number }): Point {
    return screenToImage(useEditorStore.getState().camera, this.local(e));
  }

  private tol(s: EditorState, css = HIT_TOLERANCE_CSS): number {
    return css / s.camera.zoom;
  }

  // ------------------------------------------------------------------ draft

  /** Called by the renderer once per frame. */
  private draft(): Draft | null {
    const s = useEditorStore.getState();
    const doc = s.doc;
    const g = this.gesture;
    if (!doc) return null;
    if (!g) return this.hoverId ? { hover: this.hoverId } : null;
    switch (g.kind) {
      case 'draw': {
        const shape = this.buildShape(g, s);
        return shape ? { doc: { ...doc, shapes: [...doc.shapes, shape] } } : null;
      }
      case 'move': {
        const next = this.movedShapes(g, doc);
        return {
          doc: { ...doc, shapes: next.shapes },
          selection: next.selection,
          noHandles: g.moved,
        };
      }
      case 'handle': {
        const next = this.handleShape(g, s);
        return {
          doc: { ...doc, shapes: doc.shapes.map((sh) => (sh.id === g.shape.id ? next : sh)) },
          selection: [g.shape.id],
        };
      }
      case 'group':
        return {
          doc: { ...doc, shapes: this.groupShapes(g, doc) },
          selection: [...g.shapes.keys()],
        };
      case 'marquee': {
        const r = rectFromPoints(g.start, g.cur);
        return { marquee: r, selection: this.marqueeSelection(g, r, s) };
      }
      default:
        return null;
    }
  }

  private moveDelta(g: Extract<Gesture, { kind: 'move' }>): [number, number] {
    if (!g.moved) return [0, 0];
    const dx = g.cur.x - g.start.x;
    const dy = g.cur.y - g.start.y;
    // Shift constrains the move to the dominant axis.
    if (!g.shift) return [dx, dy];
    return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
  }

  /** Shapes and selection of a move (or Alt-drag duplicate) at its current pointer position. */
  private movedShapes(
    g: Extract<Gesture, { kind: 'move' }>,
    doc: AnnotationDoc,
  ): { shapes: readonly Shape[]; selection: ShapeId[] } {
    const [dx, dy] = this.moveDelta(g);
    if (g.dup) {
      const dup = g.dup;
      const copies = doc.shapes
        .filter((sh) => dup.has(sh.id))
        .map((sh) => translateShape({ ...sh, id: dup.get(sh.id) as ShapeId }, dx, dy));
      return { shapes: [...doc.shapes, ...copies], selection: copies.map((c) => c.id) };
    }
    return {
      shapes: doc.shapes.map((sh) => (g.ids.has(sh.id) ? translateShape(sh, dx, dy) : sh)),
      selection: [...g.ids],
    };
  }

  /** The handle's own position now: where it was, plus how far the pointer has moved. */
  private grabbed(g: { cur: Point; grab: Point }): Point {
    return { x: g.cur.x + g.grab.x, y: g.cur.y + g.grab.y };
  }

  private handleShape(g: Extract<Gesture, { kind: 'handle' }>, s: EditorState): Shape {
    if (!g.moved) return g.shape;
    return dragHandle(g.shape, g.handle, this.grabbed(g), {
      shift: g.shift,
      alt: g.alt,
      zoom: s.camera.zoom,
      start: { x: g.start.x + g.grab.x, y: g.start.y + g.grab.y },
    });
  }

  private groupShapes(g: Extract<Gesture, { kind: 'group' }>, doc: AnnotationDoc): Shape[] {
    if (!g.moved) return doc.shapes.slice();
    const { anchor, k } = groupScale(g.bounds, g.handle, this.grabbed(g), g.alt);
    return doc.shapes.map((sh) => {
      const orig = g.shapes.get(sh.id);
      return orig ? scaleShape(orig, anchor, k) : sh;
    });
  }

  private marqueeSelection(
    g: Extract<Gesture, { kind: 'marquee' }>,
    r: Rect,
    s: EditorState,
  ): ShapeId[] {
    const doc = s.doc;
    if (!doc) return [];
    const hit = shapesInRect(doc.shapes, r, doc.image.dpr);
    return [...new Set([...g.base, ...hit])];
  }

  /** The shape a draw gesture would commit now, or null if it's still a click. */
  private buildShape(g: Extract<Gesture, { kind: 'draw' }>, s: EditorState): Shape | null {
    const session = s.session;
    if (!session) return null;
    const dpr = session.dpr;
    const style = s.styles[g.tool];
    const size = style.size * dpr;
    const shadow = s._settings.editor.shadow;
    const zoom = s.camera.zoom;
    const a = g.start;
    let b = g.cur;
    const tooShort = (p: Point, q: Point) => dist(p, q) * zoom < MIN_DRAG_CSS;
    switch (g.tool) {
      case 'arrow': {
        if (g.shift) b = snapAngle(a, b, 45);
        if (tooShort(a, b)) return null;
        // Shorter than 1.5 heads it would be a blob, not an arrow (design §3).
        const head = Math.max(ARROW_HEAD_WIDTHS * size, ARROW_HEAD_MIN_CSS * dpr);
        if (dist(a, b) < 1.5 * head) return null;
        return {
          id: g.id,
          kind: 'arrow',
          color: style.color,
          shadow,
          a,
          b,
          width: size,
          bend: 0,
          heads: 'end',
        };
      }
      case 'rect': {
        let p0 = a;
        if (g.shift) b = squareFrom(a, b);
        if (g.alt) p0 = { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
        const box = rectFromPoints(p0, b);
        if (box.w * zoom < MIN_DRAG_CSS && box.h * zoom < MIN_DRAG_CSS) return null;
        return {
          id: g.id,
          kind: 'rect',
          color: style.color,
          shadow,
          box,
          width: size,
          fill: style.fill ?? 'none',
        };
      }
      case 'underline': {
        if (!g.shift) b = { x: b.x, y: a.y };
        const ra = { x: Math.round(a.x), y: Math.round(a.y) };
        const rb = { x: Math.round(b.x), y: Math.round(b.y) };
        if (tooShort(ra, rb)) return null;
        return {
          id: g.id,
          kind: 'underline',
          color: style.color,
          shadow,
          a: ra,
          b: rb,
          width: size,
        };
      }
      case 'highlight': {
        if (g.marker) {
          if (g.pts.length < 2) return null;
          return {
            id: g.id,
            kind: 'pen',
            color: style.color,
            shadow: false,
            pts: g.pts.slice(),
            size,
            marker: true,
          };
        }
        b = { x: b.x, y: a.y };
        if (tooShort(a, b)) return null;
        return {
          id: g.id,
          kind: 'highlight',
          color: style.color,
          shadow: false,
          a,
          b,
          thickness: size,
          opacity: DEFAULT_HIGHLIGHT_OPACITY,
        };
      }
      case 'pen': {
        if (g.pts.length < 2) return null;
        const first = g.pts[0] as [number, number, number];
        const moved = g.pts.some(([x, y]) => Math.hypot(x - first[0], y - first[1]) * zoom >= 2);
        if (!moved) return null;
        return {
          id: g.id,
          kind: 'pen',
          color: style.color,
          shadow,
          pts: g.pts.slice(),
          size,
          marker: false,
        };
      }
      case 'text':
        return null;
    }
  }

  // ------------------------------------------------------------------ pointer

  /** Handle of the selection under `p`: the single mark's own handles, or the group's corners. */
  private handleAt(s: EditorState, p: Point): HandleTarget | null {
    const doc = s.doc;
    if (!doc || s.selection.length === 0) return null;
    const tol = this.tol(s, HANDLE_HIT_CSS);
    if (s.selection.length === 1) {
      const sel = doc.shapes.find((sh) => sh.id === s.selection[0]);
      if (!sel || sel.id === s.editingTextId) return null;
      const h = hitHandle(sel, p, tol, s.camera.zoom);
      const at = h && interactiveHandles(sel, s.camera.zoom).find((x) => x.id === h);
      return h && at ? { kind: 'shape', shape: sel, handle: h, at: { x: at.x, y: at.y } } : null;
    }
    const shapes = this.selectedShapes(s);
    const bounds = shapesBounds(shapes, doc.image.dpr);
    if (!bounds) return null;
    const h = hitGroupHandle(bounds, p, tol);
    return h ? { kind: 'group', shapes, bounds, handle: h, at: boxPoint(bounds, h) } : null;
  }

  private selectedShapes(s: EditorState): Shape[] {
    if (!s.doc || s.selection.length === 0) return [];
    const sel = new Set(s.selection);
    return s.doc.shapes.filter((sh) => sel.has(sh.id));
  }

  /** Inside the group box of a multi-selection (a press there moves the group). */
  private inGroupBox(s: EditorState, p: Point): boolean {
    if (!s.doc || s.selection.length < 2) return false;
    const b = shapesBounds(this.selectedShapes(s), s.doc.image.dpr);
    return !!b && pointInRect(p, b);
  }

  /**
   * Press, with any tool:
   * 1. on a handle of the selection: resize / rotate / bend it;
   * 2. on a mark: select it (Shift toggles it in the selection) and move it. The tool stays, so
   *    after deselecting you keep drawing with it;
   * 3. on empty page: deselect and draw with the tool (V: marquee).
   * Alt/Option forces drawing on top of a mark: Alt+press on an unselected mark draws (case 3),
   * while Alt+drag on a selected mark duplicates the selection (the Figma convention).
   */
  private onPointerDown(e: PointerEvent): void {
    this.rect = this.canvas.getBoundingClientRect();
    let s = useEditorStore.getState();
    if (e.button === 2) {
      this.armImg();
      return;
    }
    this.releaseImg();
    if (!s.doc || !s.session || s.load.phase !== 'ready') return;
    if (this.gesture) return;
    // Keep keyboard shortcuts working after clicking the canvas (focus left a toolbar button).
    if (
      !this.edit &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
    ) {
      if (!isTypingTarget(document.activeElement)) document.activeElement.blur();
    }

    const p = this.toImage(e);
    const id = e.pointerId;

    if (e.button === 1 || this.spaceHeld) {
      e.preventDefault();
      this.spaceTap = null;
      this.capture(id);
      this.gesture = {
        kind: 'pan',
        pointerId: id,
        start: this.local(e),
        cam: { x: s.camera.x, y: s.camera.y },
      };
      this.setHover(null);
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;

    if (this.edit) {
      const wasText = s.tool === 'text';
      this.commitText();
      // A click away from the text box just finishes editing.
      if (wasText) return;
      s = useEditorStore.getState();
    }

    const doc = s.doc;
    const session = s.session;
    if (!doc || !session) return;
    const dpr = doc.image.dpr;
    this.setHover(null);

    // 1. A handle of the selection wins, whatever the tool.
    const target = this.handleAt(s, p);
    if (target) {
      this.capture(id);
      const grab = { x: target.at.x - p.x, y: target.at.y - p.y };
      this.gesture =
        target.kind === 'shape'
          ? {
              kind: 'handle',
              pointerId: id,
              shape: target.shape,
              handle: target.handle,
              start: p,
              cur: p,
              grab,
              moved: false,
              shift: e.shiftKey,
              alt: e.altKey,
            }
          : {
              kind: 'group',
              pointerId: id,
              shapes: new Map(target.shapes.map((sh) => [sh.id, sh])),
              bounds: target.bounds,
              handle: target.handle,
              start: p,
              cur: p,
              grab,
              moved: false,
              alt: e.altKey,
            };
      this.renderer.invalidate();
      return;
    }

    // 2. A mark.
    const hit = hitTestShapes(doc.shapes, p, this.tol(s), dpr);
    const hitSelected = !!hit && s.selection.includes(hit.id);
    if (hit && e.altKey && hitSelected) {
      // Alt-drag the selection: duplicate it.
      this.capture(id);
      this.gesture = {
        kind: 'move',
        pointerId: id,
        start: p,
        cur: p,
        ids: new Set(s.selection),
        shift: e.shiftKey,
        moved: false,
        dup: new Map(s.selection.map((sid) => [sid, newId()])),
        editOnClick: null,
      };
      return;
    }
    if (hit && !e.altKey) {
      let selection = s.selection;
      if (e.shiftKey) {
        selection = hitSelected ? selection.filter((x) => x !== hit.id) : [...selection, hit.id];
      } else if (!hitSelected) {
        selection = [hit.id];
      }
      s.actions.setSelection(selection);
      if (!selection.includes(hit.id)) return;
      this.capture(id);
      this.gesture = {
        kind: 'move',
        pointerId: id,
        start: p,
        cur: p,
        ids: new Set(selection),
        shift: false,
        moved: false,
        dup: null,
        editOnClick:
          s.tool === 'text' &&
          hit.kind === 'text' &&
          hitSelected &&
          !e.shiftKey &&
          selection.length === 1
            ? hit
            : null,
      };
      if (hit.kind === 'text' && s.tool === 'text') e.preventDefault();
      return;
    }

    // Inside a multi-selection's box: move the group.
    if (!e.altKey && !e.shiftKey && this.inGroupBox(s, p)) {
      this.capture(id);
      this.gesture = {
        kind: 'move',
        pointerId: id,
        start: p,
        cur: p,
        ids: new Set(s.selection),
        shift: false,
        moved: false,
        dup: null,
        editOnClick: null,
      };
      return;
    }

    // 3. Empty page (or Alt over an unselected mark): the tool's own gesture.
    if (s.tool === 'select') {
      if (!e.shiftKey) s.actions.clearSelection();
      this.capture(id);
      this.gesture = {
        kind: 'marquee',
        pointerId: id,
        start: p,
        cur: p,
        base: e.shiftKey ? s.selection : [],
      };
      return;
    }

    if (s.selection.length > 0) s.actions.clearSelection();

    if (s.tool === 'text') {
      const style = s.styles.text;
      const size = style.size * session.dpr;
      const shape: TextShape = {
        id: newId(),
        kind: 'text',
        color: style.color,
        shadow: s._settings.editor.shadow,
        // The click lands in the middle of the first line.
        at: { x: p.x, y: p.y - (size * TEXT_LINE_HEIGHT) / 2 },
        text: '',
        size,
        weight: 700,
        style: 'outline',
      };
      e.preventDefault(); // keep focus on the textarea we're about to show
      this.startTextEdit(shape, true);
      return;
    }

    this.capture(id);
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    this.gesture = {
      kind: 'draw',
      pointerId: id,
      tool: s.tool,
      start: p,
      cur: p,
      shift: e.shiftKey,
      alt: e.altKey,
      marker: s.tool === 'highlight' && e.shiftKey,
      pts: [[p.x, p.y, pressure]],
      id: newId(),
    };
    this.renderer.invalidate();
  }

  private capture(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      // synthetic events in tests may have no active pointer
    }
  }

  private onPointerMove(e: PointerEvent): void {
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY };
    const g = this.gesture;
    if (!g) {
      this.hover(e);
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    const s = useEditorStore.getState();
    switch (g.kind) {
      case 'pan': {
        const l = this.local(e);
        const z = s.camera.zoom;
        s._engine._panZoom({
          x: g.cam.x - (l.x - g.start.x) / z,
          y: g.cam.y - (l.y - g.start.y) / z,
          zoom: z,
        });
        return;
      }
      case 'draw': {
        g.shift = e.shiftKey;
        g.alt = e.altKey;
        if (g.tool === 'pen' || g.marker) {
          const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const ce of events.length ? events : [e]) {
            const q = this.toImage(ce);
            g.pts.push([q.x, q.y, ce.pointerType === 'pen' ? ce.pressure || 0.5 : 0.5]);
          }
        }
        g.cur = this.toImage(e);
        break;
      }
      case 'move':
        g.cur = this.toImage(e);
        g.shift = e.shiftKey;
        if (!g.moved && dist(g.start, g.cur) * s.camera.zoom >= MOVE_SLOP_CSS) {
          g.moved = true;
          this.setCursor(g.dup ? 'copy' : 'move');
        }
        if (!g.moved) return;
        break;
      case 'handle':
      case 'group':
        g.cur = this.toImage(e);
        if (g.kind === 'handle') g.shift = e.shiftKey;
        g.alt = e.altKey;
        if (!g.moved && dist(g.start, g.cur) * s.camera.zoom >= MOVE_SLOP_CSS) g.moved = true;
        if (!g.moved) return;
        break;
      case 'marquee':
        g.cur = this.toImage(e);
        break;
    }
    this.renderer.invalidate();
  }

  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    const s = useEditorStore.getState();
    const doc = s.doc;
    switch (g.kind) {
      case 'pan':
        break;
      case 'draw': {
        if (g.tool === 'pen' || g.marker) {
          const q = this.toImage(e);
          const last = g.pts[g.pts.length - 1];
          if (!last || last[0] !== q.x || last[1] !== q.y) g.pts.push([q.x, q.y, 0.5]);
        }
        g.cur = this.toImage(e);
        const shape = this.buildShape(g, s);
        if (shape && doc) s._engine._commit({ ...doc, shapes: [...doc.shapes, shape] });
        break;
      }
      case 'move': {
        if (!doc) break;
        if (!g.moved) {
          // A click: the mark stays selected (with the Text tool, a click on the selected text
          // edits it).
          if (g.editOnClick && doc.shapes.includes(g.editOnClick)) {
            this.startTextEdit(g.editOnClick, false);
          }
          break;
        }
        const next = this.movedShapes(g, doc);
        s._engine._commit({ ...doc, shapes: next.shapes }, next.selection);
        break;
      }
      case 'handle': {
        const next = this.handleShape(g, s);
        if (doc && next !== g.shape) {
          s._engine._commit(
            { ...doc, shapes: doc.shapes.map((sh) => (sh.id === g.shape.id ? next : sh)) },
            [g.shape.id],
          );
        }
        break;
      }
      case 'group': {
        if (!doc) break;
        const shapes = this.groupShapes(g, doc);
        if (shapes.some((sh, i) => sh !== doc.shapes[i])) {
          s._engine._commit({ ...doc, shapes }, [...g.shapes.keys()]);
        }
        break;
      }
      case 'marquee': {
        const r = rectFromPoints(g.start, g.cur);
        if (r.w * s.camera.zoom > 2 || r.h * s.camera.zoom > 2) {
          s.actions.setSelection(this.marqueeSelection(g, r, s));
        }
        break;
      }
    }
    this.lastHoverCursor = '';
    this.hover(e);
    this.renderer.invalidate();
  }

  private onPointerCancel(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    // lostpointercapture also fires after a normal pointerup (gesture already null then).
    this.gesture = null;
    this.renderer.invalidate();
    this.updateCursor();
  }

  private onDoubleClick(e: MouseEvent): void {
    const s = useEditorStore.getState();
    if (!s.doc || s.load.phase !== 'ready' || this.edit) return;
    const p = this.toImage(e);
    const hit = hitTestShapes(s.doc.shapes, p, this.tol(s), s.doc.image.dpr);
    if (hit?.kind === 'text') {
      e.preventDefault();
      this.startTextEdit(hit, false);
    }
  }

  /** The mark under the pointer gets an outline; the cursor says what a press would do. */
  private hover(e: { clientX: number; clientY: number; altKey: boolean }): void {
    const s = useEditorStore.getState();
    if (!s.doc || this.spaceHeld || s.load.phase !== 'ready' || this.gesture) {
      this.setHover(null);
      if (!this.gesture) this.updateCursor();
      return;
    }
    const p = this.toImage(e);
    const target = this.handleAt(s, p);
    if (target) {
      this.setHover(null);
      this.setCursor(handleCursor(target.kind === 'shape' ? target.shape : null, target.handle));
      return;
    }
    const hit = hitTestShapes(s.doc.shapes, p, this.tol(s), s.doc.image.dpr);
    const selected = !!hit && s.selection.includes(hit.id);
    if (hit && (!e.altKey || selected)) {
      this.setHover(hit.id === s.editingTextId ? null : hit.id);
      this.setCursor(e.altKey ? 'copy' : 'move');
      return;
    }
    this.setHover(null);
    if (!e.altKey && this.inGroupBox(s, p)) {
      this.setCursor('move');
      return;
    }
    this.setCursor(this.toolCursor(s));
  }

  private setHover(id: ShapeId | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.renderer.invalidate();
  }

  /** Modifier keys change what a press would do: re-run hover (and update a drag). */
  private onModifier(e: KeyboardEvent): void {
    const g = this.gesture;
    if (
      g &&
      (g.kind === 'handle' || g.kind === 'draw' || g.kind === 'move' || g.kind === 'group')
    ) {
      if (g.kind !== 'group') g.shift = e.shiftKey;
      if (g.kind !== 'move') g.alt = e.altKey;
      this.renderer.invalidate();
      return;
    }
    const lp = this.lastPointer;
    if (!g && lp) this.hover({ ...lp, altKey: e.altKey });
  }

  private toolCursor(s: EditorState): string {
    if (this.spaceHeld) return this.gesture?.kind === 'pan' ? 'grabbing' : 'grab';
    if (this.gesture?.kind === 'pan') return 'grabbing';
    switch (s.tool) {
      case 'select':
        return 'default';
      case 'text':
        return 'text';
      case 'highlight':
        return HIGHLIGHT_CURSOR;
      case 'pen':
        return PEN_CURSOR;
      default:
        return 'crosshair';
    }
  }

  private updateCursor(): void {
    this.setCursor(this.toolCursor(useEditorStore.getState()));
  }

  private setCursor(c: string): void {
    if (c === this.lastHoverCursor) return;
    this.lastHoverCursor = c;
    this.canvas.style.cursor = c;
  }

  // ------------------------------------------------------------------ wheel / keys

  private onWheel(e: WheelEvent): void {
    const s = useEditorStore.getState();
    if (!s.session) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? s.viewport.h : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    const cam = s.camera;
    if (e.ctrlKey || e.metaKey) {
      // Pinch (ctrl+wheel with small deltas) or Cmd+wheel: zoom around the cursor.
      const k = e.ctrlKey && !e.metaKey && Math.abs(dy) < 50 ? 0.01 : 0.0025;
      const factor = Math.exp(-dy * k);
      const { min, max } = zoomLimits(s.session.dpr);
      const zoom = Math.max(min, Math.min(max, cam.zoom * factor));
      s._engine._panZoom(zoomAround(cam, zoom, this.local(e)));
      return;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    s._engine._panZoom({ x: cam.x + dx / cam.zoom, y: cam.y + dy / cam.zoom, zoom: cam.zoom });
    if (this.edit) this.layoutTextarea();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'Space' && e.key !== ' ') {
      if (down && e.key === 'Escape' && this.gesture && !isTypingTarget(e.target)) {
        // Esc cancels the gesture in progress (before the global shortcut sees it).
        e.preventDefault();
        e.stopImmediatePropagation();
        this.gesture = null;
        this.renderer.invalidate();
        this.updateCursor();
        return;
      }
      if (e.key === 'Alt' || e.key === 'Shift') {
        this.onModifier(e);
        return;
      }
      if (
        down &&
        e.key === 'Enter' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !this.edit &&
        !this.gesture &&
        !isInteractiveTarget(e.target) &&
        this.editSelectedText()
      ) {
        // Enter on a single selected text edits it (Figma).
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (isTypingTarget(e.target) || this.edit) return;
    // Space activates a focused button, link or menu item: leave it to the control.
    if (isInteractiveTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (down && !e.repeat && !this.spaceHeld) {
      this.spaceTap = { at: performance.now(), shift: e.shiftKey };
    }
    if (!down) {
      // A tap (no drag, not held) pages like a browser: Space down, Shift+Space up.
      const tap = this.spaceTap;
      this.spaceTap = null;
      if (tap && performance.now() - tap.at < SPACE_TAP_MS && this.gesture?.kind !== 'pan') {
        pageBy(tap.shift || e.shiftKey ? -1 : 1);
      }
    }
    if (this.spaceHeld === down) return;
    this.spaceHeld = down;
    this.updateCursor();
  }

  // ------------------------------------------------------------------ text editing

  /** Edit the selected text, if exactly one text is selected. */
  editSelectedText(): boolean {
    const s = useEditorStore.getState();
    if (!s.doc || s.selection.length !== 1 || s.load.phase !== 'ready') return false;
    const sh = s.doc.shapes.find((x) => x.id === s.selection[0]);
    if (sh?.kind !== 'text') return false;
    this.startTextEdit(sh, false);
    return true;
  }

  private startTextEdit(shape: TextShape, isNew: boolean): void {
    const s = useEditorStore.getState();
    this.edit = { shape, isNew };
    s._engine._setEditingText(shape.id);
    if (!isNew && !s.selection.includes(shape.id)) s.actions.setSelection([]);
    const ta = this.textarea;
    ta.value = shape.text;
    ta.style.display = 'block';
    this.layoutTextarea();
    ta.focus({ preventScroll: true });
    // Re-editing selects the old text (type to replace, arrows to keep); new text has a caret.
    ta.setSelectionRange(0, ta.value.length);
    // The pointer event in progress may move focus back to the canvas; restore it next frame
    // without touching the selection (the user may already be typing).
    requestAnimationFrame(() => {
      if (this.edit?.shape.id === shape.id && document.activeElement !== ta) {
        ta.focus({ preventScroll: true });
      }
    });
  }

  private layoutTextarea(): void {
    const edit = this.edit;
    if (!edit) return;
    const s = useEditorStore.getState();
    const cam = s.camera;
    const sh = edit.shape;
    const fontPx = sh.size * cam.zoom;
    const p = imageToScreen(cam, sh.at);
    const ta = this.textarea;
    const st = ta.style;
    st.left = `${p.x}px`;
    st.top = `${p.y}px`;
    st.font = `${sh.weight} ${fontPx}px ${FONT_STACK}`;
    st.lineHeight = String(TEXT_LINE_HEIGHT);
    st.color = sh.color;
    st.caretColor = sh.color;
    const outline = Math.max(1, sh.size * TEXT_OUTLINE_RATIO * cam.zoom);
    st.setProperty('-webkit-text-stroke', `${outline}px #ffffff`);
    st.setProperty('paint-order', 'stroke fill');
    if (sh.maxW !== undefined) {
      // Fixed-width text wraps like the canvas does.
      ta.wrap = 'soft';
      st.whiteSpace = 'pre-wrap';
      st.overflowWrap = 'anywhere';
      st.width = `${Math.max(sh.maxW, sh.size) * cam.zoom}px`;
      st.height = '0px';
      st.height = `${Math.max(fontPx * TEXT_LINE_HEIGHT, ta.scrollHeight)}px`;
    } else {
      ta.wrap = 'off';
      st.whiteSpace = 'pre';
      st.overflowWrap = 'normal';
      const lines = ta.value.split('\n');
      st.height = `${Math.max(1, lines.length) * fontPx * TEXT_LINE_HEIGHT}px`;
      st.width = '0px';
      st.width = `${Math.max(fontPx * 0.6, ta.scrollWidth + fontPx * 0.5)}px`;
    }
    // A rotated text is edited in place, turned about the centre of its box.
    const rot = sh.rotation ?? 0;
    if (rot) {
      const b = textLayout(sh).box;
      st.transformOrigin = `${(b.w / 2) * cam.zoom}px ${(b.h / 2) * cam.zoom}px`;
      st.transform = `rotate(${rot}rad)`;
    } else {
      st.transform = '';
    }
  }

  private onTextKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    const ta = this.textarea;
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      e.key.toLowerCase() === 'c' &&
      ta.selectionStart === ta.selectionEnd
    ) {
      // "Type a note, then ⌘C": nothing selected to copy as text, so finish the note and copy
      // the image (synchronously, inside this keydown, as the clipboard needs).
      e.preventDefault();
      if (e.repeat) return;
      this.commitText();
      useEditorStore.getState().actions.copy(e.shiftKey ? 'full' : 'default');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.commitText();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelText();
    }
  }

  /** Enter / click-away / tool change: keep the text (empty text deletes the shape). */
  private commitText(): void {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    const text = this.textarea.value.replace(/\s+$/, '');
    this.hideTextarea();
    const s = useEditorStore.getState();
    s._engine._setEditingText(null);
    const doc = s.doc;
    if (!doc) return;
    const exists = doc.shapes.some((sh) => sh.id === edit.shape.id);
    if (!text.trim()) {
      if (exists)
        s._engine._commit(
          { ...doc, shapes: doc.shapes.filter((sh) => sh.id !== edit.shape.id) },
          [],
        );
      return;
    }
    if (exists) {
      if (text === edit.shape.text) return;
      const next = { ...edit.shape, text };
      s._engine._commit({
        ...doc,
        shapes: doc.shapes.map((sh) => (sh.id === next.id ? next : sh)),
      });
    } else {
      s._engine._commit({ ...doc, shapes: [...doc.shapes, { ...edit.shape, text }] });
    }
  }

  /** Esc: drop the edit (a new text box disappears, an existing one keeps its old text). */
  private cancelText(): void {
    if (!this.edit) return;
    this.edit = null;
    this.hideTextarea();
    useEditorStore.getState()._engine._setEditingText(null);
  }

  private hideTextarea(): void {
    const ta = this.textarea;
    ta.style.display = 'none';
    if (document.activeElement === ta) ta.blur();
    this.renderer.invalidate();
  }

  /** Is a text box open (for shortcuts)? */
  get editingText(): boolean {
    return this.edit !== null;
  }

  // ------------------------------------------------------------------ right-click composite

  private setComposite(url: string | null): void {
    if (url) this.img.src = url;
    else {
      this.img.removeAttribute('src');
      this.releaseImg();
    }
  }

  /**
   * Right mouse down: make the composite <img> the native menu's target, but only when it is
   * exactly what ⌘C would copy now. Otherwise the menu opens on the canvas (no "Copy image",
   * never a stale one) and the encode jumps the queue, so the next right-click has it.
   */
  private armImg(): void {
    const s = useEditorStore.getState();
    if (!this.img.getAttribute('src') || !s._engine._compositeFresh()) {
      s._engine._prepareComposite();
      return;
    }
    this.imgMenuOpen = false;
    this.img.style.pointerEvents = 'auto';
  }

  private releaseImg(): void {
    this.imgMenuOpen = false;
    this.img.style.pointerEvents = 'none';
  }
}

/** For the store-free doc type import in tests. */
export type { AnnotationDoc };
