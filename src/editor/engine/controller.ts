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
  dist,
  dragHandle,
  FONT_STACK,
  type HandleId,
  HIT_TOLERANCE_CSS,
  hitHandle,
  hitTestShapes,
  imageToScreen,
  rectFromPoints,
  screenToImage,
  shapesInRect,
  snapAngle,
  squareFrom,
  TEXT_LINE_HEIGHT,
  TEXT_OUTLINE_RATIO,
  translateShape,
  zoomAround,
  zoomLimits,
} from './geometry';
import { type Draft, Renderer } from './renderer';
import { type DrawTool, type EditorState, useEditorStore } from './store';

/** Below this on-screen length (CSS px) a drag is a click: no shape is created. */
const MIN_DRAG_CSS = 5;
/** Handle grab radius, CSS px. */
const HANDLE_HIT_CSS = 9;

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
    }
  | {
      kind: 'handle';
      pointerId: number;
      shape: Shape;
      handle: HandleId;
      cur: Point;
      shift: boolean;
    }
  | { kind: 'marquee'; pointerId: number; start: Point; cur: Point; base: readonly ShapeId[] };

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

export class CanvasController {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly img: HTMLImageElement;
  readonly renderer: Renderer;
  private gesture: Gesture | null = null;
  private edit: TextEdit | null = null;
  private spaceHeld = false;
  private rect: DOMRect | null = null;
  private readonly cleanups: (() => void)[] = [];
  private lastHoverCursor = '';

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
    if (!doc || !g) return null;
    switch (g.kind) {
      case 'draw': {
        const shape = this.buildShape(g, s);
        return shape ? { doc: { ...doc, shapes: [...doc.shapes, shape] } } : null;
      }
      case 'move': {
        const dx = g.cur.x - g.start.x;
        const dy = g.cur.y - g.start.y;
        const [mx, my] = this.moveDelta(dx, dy, g.shift);
        return {
          doc: {
            ...doc,
            shapes: doc.shapes.map((sh) => (g.ids.has(sh.id) ? translateShape(sh, mx, my) : sh)),
          },
          selection: [...g.ids],
        };
      }
      case 'handle': {
        const next = dragHandle(g.shape, g.handle, g.cur, g.shift);
        return {
          doc: { ...doc, shapes: doc.shapes.map((sh) => (sh.id === g.shape.id ? next : sh)) },
          selection: [g.shape.id],
        };
      }
      case 'marquee': {
        const r = rectFromPoints(g.start, g.cur);
        return { marquee: r, selection: this.marqueeSelection(g, r, s) };
      }
      default:
        return null;
    }
  }

  private moveDelta(dx: number, dy: number, shift: boolean): [number, number] {
    // Shift constrains the move to the dominant axis.
    if (!shift) return [dx, dy];
    return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
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
          fill: 'none',
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

  private onPointerDown(e: PointerEvent): void {
    this.rect = this.canvas.getBoundingClientRect();
    const s = useEditorStore.getState();
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
      this.capture(id);
      this.gesture = {
        kind: 'pan',
        pointerId: id,
        start: this.local(e),
        cam: { x: s.camera.x, y: s.camera.y },
      };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;

    if (this.edit) {
      const wasText = s.tool === 'text';
      this.commitText();
      // A click away from the text box just finishes editing.
      if (wasText) return;
    }

    const doc = s.doc;
    const dpr = doc.image.dpr;

    // A handle of the single selected shape wins, whatever the tool.
    if (s.selection.length === 1) {
      const sel = doc.shapes.find((sh) => sh.id === s.selection[0]);
      const h = sel ? hitHandle(sel, p, this.tol(s, HANDLE_HIT_CSS)) : null;
      if (sel && h) {
        this.capture(id);
        this.gesture = {
          kind: 'handle',
          pointerId: id,
          shape: sel,
          handle: h,
          cur: p,
          shift: e.shiftKey,
        };
        return;
      }
    }

    if (s.tool === 'select') {
      const hit = hitTestShapes(doc.shapes, p, this.tol(s), dpr);
      if (hit) {
        let selection = s.selection;
        if (e.shiftKey) {
          selection = selection.includes(hit.id)
            ? selection.filter((x) => x !== hit.id)
            : [...selection, hit.id];
        } else if (!selection.includes(hit.id)) {
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
        };
      } else {
        if (!e.shiftKey) s.actions.clearSelection();
        this.capture(id);
        this.gesture = {
          kind: 'marquee',
          pointerId: id,
          start: p,
          cur: p,
          base: e.shiftKey ? s.selection : [],
        };
      }
      return;
    }

    if (s.tool === 'text') {
      const hit = hitTestShapes(doc.shapes, p, this.tol(s), dpr);
      if (hit?.kind === 'text') {
        this.startTextEdit(hit, false);
        e.preventDefault();
        return;
      }
      const style = s.styles.text;
      const size = style.size * s.session.dpr;
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

    if (s.selection.length > 0) s.actions.clearSelection();
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
        break;
      case 'handle':
        g.cur = this.toImage(e);
        g.shift = e.shiftKey;
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
        const [dx, dy] = this.moveDelta(g.cur.x - g.start.x, g.cur.y - g.start.y, g.shift);
        if (doc && (dx !== 0 || dy !== 0)) {
          s._engine._commit({
            ...doc,
            shapes: doc.shapes.map((sh) => (g.ids.has(sh.id) ? translateShape(sh, dx, dy) : sh)),
          });
        }
        break;
      }
      case 'handle': {
        const next = dragHandle(g.shape, g.handle, g.cur, g.shift);
        if (doc && next !== g.shape) {
          s._engine._commit(
            { ...doc, shapes: doc.shapes.map((sh) => (sh.id === g.shape.id ? next : sh)) },
            [g.shape.id],
          );
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
    this.updateCursor();
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

  private hover(e: PointerEvent): void {
    const s = useEditorStore.getState();
    if (!s.doc || this.spaceHeld) return;
    const p = this.toImage(e);
    let cursor = '';
    if (s.selection.length === 1) {
      const sel = s.doc.shapes.find((sh) => sh.id === s.selection[0]);
      const h = sel ? hitHandle(sel, p, this.tol(s, HANDLE_HIT_CSS)) : null;
      if (h) cursor = handleCursor(h);
    }
    if (!cursor && (s.tool === 'select' || s.tool === 'text')) {
      const hit = hitTestShapes(s.doc.shapes, p, this.tol(s), s.doc.image.dpr);
      if (hit)
        cursor =
          s.tool === 'text' && hit.kind === 'text' ? 'text' : s.tool === 'select' ? 'move' : '';
    }
    this.setCursor(cursor || this.toolCursor(s));
  }

  private toolCursor(s: EditorState): string {
    if (this.spaceHeld) return this.gesture?.kind === 'pan' ? 'grabbing' : 'grab';
    if (this.gesture?.kind === 'pan') return 'grabbing';
    switch (s.tool) {
      case 'select':
        return 'default';
      case 'text':
        return 'text';
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
      }
      return;
    }
    if (isTypingTarget(e.target) || this.edit) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (this.spaceHeld === down) return;
    this.spaceHeld = down;
    this.updateCursor();
  }

  // ------------------------------------------------------------------ text editing

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
    const lines = ta.value.split('\n');
    st.height = `${Math.max(1, lines.length) * fontPx * TEXT_LINE_HEIGHT}px`;
    st.width = '0px';
    st.width = `${Math.max(fontPx * 0.6, ta.scrollWidth + fontPx * 0.5)}px`;
  }

  private onTextKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
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
    else this.img.removeAttribute('src');
  }

  private armImg(): void {
    if (!this.img.getAttribute('src')) return;
    this.imgMenuOpen = false;
    this.img.style.pointerEvents = 'auto';
  }

  private releaseImg(): void {
    this.imgMenuOpen = false;
    this.img.style.pointerEvents = 'none';
  }
}

function handleCursor(h: HandleId): string {
  switch (h) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    default:
      return 'move';
  }
}

/** For the store-free doc type import in tests. */
export type { AnnotationDoc };
