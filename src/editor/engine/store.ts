/**
 * Editor store: the contract between the editor engine (B, implements) and the editor UI (C,
 * consumes). C reads state with `useEditorStore(selector)` and calls `actions.*`; C never writes
 * state directly and never imports engine internals (only `@/editor/engine`).
 *
 * B may add internal fields and actions (prefix them with `_`) and replace the implementation
 * freely. Renaming, removing or changing the meaning of anything below the "CONTRACT" markers
 * needs a note in docs/CONTRACTS.md first.
 *
 * Performance rule: the store holds committed state only (the doc, selection, tool, camera).
 * Per-frame drag state lives in the canvas controller and never goes through React.
 */
import { create } from 'zustand';
import { openCaptureSource } from '@/compositor';
import {
  type AnnotationDoc,
  type Color,
  DEFAULT_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_SIZES_CSS,
  emptyDoc,
  migrateDoc,
  PALETTE,
  type Shape,
  type ShapeId,
  type ShapeKind,
  SIZE_STEPS_CSS,
} from '@/shared/annotations';
import { getDoc } from '@/shared/db';
import { waitForFinalSession } from '@/shared/handoff';
import { DEFAULT_SETTINGS, getSettings, type Settings, watchSettings } from '@/shared/settings';
import type { CaptureSource } from '@/shared/source';
import type { CaptureSession, Point, SessionId, Size } from '@/shared/types';
import { Autosaver, readBackupDoc } from './autosave';
import { isNotFocusedError, writeImageToClipboard } from './clipboard';
import { Exporter } from './exporter';
import { exportFilename } from './filename';
import {
  clampCamera,
  fitWidthCamera,
  fitWidthZoom,
  visibleRect,
  zoomAround,
  zoomLimits,
} from './geometry';
import * as hist from './history';
import { perf } from './perf';
import { type ExportPlan, nativePlan, planCopy, planDownload, planKey } from './scope';

// ---------------------------------------------------------------- CONTRACT: types

/** Drawing tools map 1:1 to shape kinds. */
export type DrawTool = ShapeKind;
export type Tool = 'select' | DrawTool;

/** Toolbar order. */
export const TOOLS: readonly Tool[] = [
  'select',
  'arrow',
  'rect',
  'underline',
  'highlight',
  'pen',
  'text',
];

/** Single-key shortcuts (`e.key`, lower case). Shown in tooltips by C, handled by B. */
export const TOOL_SHORTCUTS: Readonly<Record<Tool, string>> = {
  select: 'v',
  arrow: 'a',
  rect: 'r',
  underline: 'u',
  highlight: 'h',
  pen: 'p',
  text: 't',
};

export const TOOL_LABELS: Readonly<Record<Tool, string>> = {
  select: 'Select',
  arrow: 'Arrow',
  rect: 'Rectangle',
  underline: 'Underline',
  highlight: 'Highlighter',
  pen: 'Pen',
  text: 'Text',
};

/** Per-tool style. `size` is in **CSS px** (converted to image px with `session.dpr` on creation). */
export interface ToolStyle {
  color: Color;
  size: number;
}

/**
 * Camera: `x`, `y` = image px shown at the canvas's top-left corner; `zoom` = CSS px per image px.
 * 100% (page at its natural CSS size) is `zoom = 1 / session.dpr`.
 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type LoadState =
  | { phase: 'idle' }
  /** The capture is still running; the editor was opened early. */
  | { phase: 'waiting'; progress: { done: number; total: number } }
  /** Session is final; opening the source and the first tiles. */
  | { phase: 'loading' }
  | { phase: 'ready' }
  | {
      phase: 'error';
      code: 'NO_SESSION' | 'CAPTURE_FAILED' | 'LOAD_FAILED';
      message: string;
    };

/** `default` = Cmd+C, `full` = Shift+Cmd+C. */
export type CopyRequest = 'default' | 'full';

/**
 * What a copy actually contained:
 * - `full`: the whole annotated image (Shift+Cmd+C, or Cmd+C when the page is at most
 *   `settings.copy.fullMaxCssHeight` CSS px tall);
 * - `smart`: the region around the annotations, full width, capped near 2576 CSS px tall;
 * - `viewport`: the current view (Cmd+C on a tall page with no annotations).
 */
export type CopyOutcome = 'full' | 'smart' | 'viewport';

export type CopyStatus =
  | { state: 'idle' }
  | { state: 'copying'; request: CopyRequest }
  | {
      state: 'copied';
      request: CopyRequest;
      outcome: CopyOutcome;
      /** Pixel size of the PNG on the clipboard. */
      size: Size;
      /** Tall result an AI will downscale noticeably (long edge > 2576 CSS px). */
      tall: boolean;
      at: number;
    }
  | {
      state: 'failed';
      request: CopyRequest;
      /** `not-focused`: the page lost focus; UI should say "Click the page, then ⌘C again". */
      reason: 'not-focused' | 'error';
      message: string;
      at: number;
    };

export type DownloadStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; filename: string; size: Size; at: number }
  | { state: 'failed'; message: string; at: number };

// ---------------------------------------------------------------- CONTRACT: actions

export interface EditorActions {
  /** Load a session (from `#s=<id>`). Drives `load`, then sets `session`, `source`, `doc`, `camera`. */
  init(sessionId: SessionId): Promise<void>;

  setTool(tool: Tool): void;
  /** Colour for the active tool family (all tools share one colour except the highlighter) and the selection. */
  setColor(color: Color): void;
  /** Keys 1–8: `PALETTE[index]`. */
  setColorIndex(index: number): void;
  /** Size in CSS px for the active tool and the selection. */
  setSize(sizeCss: number): void;
  /** `[` (-1) / `]` (+1): step through `SIZE_STEPS_CSS`. */
  stepSize(direction: -1 | 1): void;

  undo(): void;
  redo(): void;
  setSelection(ids: readonly ShapeId[]): void;
  selectAll(): void;
  clearSelection(): void;
  deleteSelection(): void;

  setCamera(camera: Partial<Camera>): void;
  /** Multiply zoom by `factor`, keeping `anchor` (CSS px relative to the canvas) fixed. Default anchor: canvas centre. */
  zoomBy(factor: number, anchor?: Point): void;
  /** Cmd+0: fit the image width (never above 100%). */
  fitWidth(): void;
  /** Cmd+1: 100% (`zoom = 1 / dpr`). */
  zoomActual(): void;

  /**
   * Copy to the clipboard. **Must be called synchronously inside the click/keydown handler** (it
   * calls `navigator.clipboard.write` with a Promise<Blob> before returning). Progress and result
   * are reported in `copy`.
   */
  copy(request: CopyRequest): void;
  /** Download the full annotated image at native resolution. Progress/result in `download`. */
  download(): void;
  /** Reset `copy` and `download` to idle (toast dismissed). */
  dismissStatus(): void;
}

/** Engine-internal actions (used by the canvas controller and shortcuts, not by C). */
export interface EngineActions {
  /** Commit a new doc as one undo step. Optionally replace the selection. */
  _commit(doc: AnnotationDoc, selection?: readonly ShapeId[]): void;
  /** The canvas element's CSS size changed. */
  _setViewport(size: Size): void;
  /** Camera change from user input (wheel, pinch, pan). Leaves fit-width mode. */
  _panZoom(camera: Camera): void;
  _setEditingText(id: ShapeId | null): void;
  /** The first frame with every visible tile has been painted. */
  _firstPaint(): void;
  /** What `copy(request)` would produce right now. */
  _planCopy(request: CopyRequest): ExportPlan | null;
  /** Export like `copy(request)` but at native resolution (e2e hook). */
  _exportNative(request: CopyRequest): Promise<Blob>;
  /** Tear down (tests). */
  _reset(): void;
}

// ---------------------------------------------------------------- CONTRACT: state

export interface EditorState {
  sessionId: SessionId | null;
  /** Set once the session is final. */
  session: CaptureSession | null;
  source: CaptureSource | null;
  load: LoadState;

  /** Current (present) document. `null` until loaded. */
  doc: AnnotationDoc | null;
  canUndo: boolean;
  canRedo: boolean;
  selection: readonly ShapeId[];
  /** Text shape being edited in the overlay, if any (single-key shortcuts are off meanwhile). */
  editingTextId: ShapeId | null;

  tool: Tool;
  styles: Readonly<Record<DrawTool, ToolStyle>>;

  camera: Camera;
  /** Size of the canvas element, CSS px (set by the engine's canvas). */
  viewport: Size;

  copy: CopyStatus;
  download: DownloadStatus;

  actions: EditorActions;

  // ---- engine internals (not for C)
  _history: hist.History | null;
  _settings: Settings;
  /** Camera follows fit-width on resize until the user zooms. */
  _fit: boolean;
  /** Object URL of the latest full composite for native right-click "Copy image". */
  _compositeUrl: string | null;
  /** Doc rev the composite was rendered from. */
  _compositeRev: number;
  _engine: EngineActions;
}

// ---------------------------------------------------------------- CONTRACT: selectors

export const selectActiveStyle = (s: EditorState): ToolStyle | null =>
  s.tool === 'select' ? null : s.styles[s.tool];

/** Zoom as a percentage of the page's natural CSS size. */
export const selectZoomPercent = (s: EditorState): number =>
  Math.round(s.camera.zoom * (s.session?.dpr ?? 1) * 100);

export const selectIsReady = (s: EditorState): boolean => s.load.phase === 'ready';

// ---------------------------------------------------------------- defaults

export const DEFAULT_STYLES: Readonly<Record<DrawTool, ToolStyle>> = {
  arrow: { color: DEFAULT_COLOR, size: DEFAULT_SIZES_CSS.arrow },
  rect: { color: DEFAULT_COLOR, size: DEFAULT_SIZES_CSS.rect },
  underline: { color: DEFAULT_COLOR, size: DEFAULT_SIZES_CSS.underline },
  highlight: { color: DEFAULT_HIGHLIGHT_COLOR, size: DEFAULT_SIZES_CSS.highlight },
  pen: { color: DEFAULT_COLOR, size: DEFAULT_SIZES_CSS.pen },
  text: { color: DEFAULT_COLOR, size: DEFAULT_SIZES_CSS.text },
};

/**
 * Tool styles with the shared ink colour set to `settings.editor.defaultColor` (options page).
 * The highlighter keeps its own colour. Unknown or malformed values are ignored.
 */
export function seedStyles(
  styles: Readonly<Record<DrawTool, ToolStyle>>,
  color: string | undefined,
): Readonly<Record<DrawTool, ToolStyle>> {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return styles;
  const next = { ...styles };
  for (const tool of Object.keys(next) as DrawTool[]) {
    if (tool !== 'highlight') next[tool] = { ...next[tool], color };
  }
  return next;
}

/** Idle delay before pre-encoding the copy after a commit (03 §4.2). */
export const PREWARM_DELAY_MS = 400;

// ---------------------------------------------------------------- helpers

/** The size property of a shape, in image px. */
export function shapeSize(s: Shape): number {
  switch (s.kind) {
    case 'arrow':
    case 'rect':
    case 'underline':
      return s.width;
    case 'highlight':
      return s.thickness;
    case 'pen':
      return s.size;
    case 'text':
      return s.size;
  }
}

export function withShapeSize(s: Shape, px: number): Shape {
  switch (s.kind) {
    case 'arrow':
    case 'rect':
    case 'underline':
      return { ...s, width: px };
    case 'highlight':
      return { ...s, thickness: px };
    case 'pen':
      return { ...s, size: px };
    case 'text':
      return { ...s, size: px };
  }
}

/** The tool whose sizes apply to a shape (marker strokes size like the highlighter). */
function sizeKindOf(s: Shape): ShapeKind {
  return s.kind === 'pen' && s.marker ? 'highlight' : s.kind;
}

/** Next size step from `current` (CSS px) in `steps`, snapping to the nearest step first. */
export function stepSizeValue(steps: readonly number[], current: number, dir: -1 | 1): number {
  let nearest = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs((steps[i] as number) - current) < Math.abs((steps[nearest] as number) - current)) {
      nearest = i;
    }
  }
  const snapped = steps[nearest] as number;
  let i = nearest;
  if (Math.abs(snapped - current) < 0.01 || (dir > 0 ? snapped <= current : snapped >= current)) {
    i = nearest + dir;
  }
  i = Math.max(0, Math.min(steps.length - 1, i));
  return steps[i] as number;
}

function errorCode(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------- runtime singletons

let exporter: Exporter | null = null;
let autosaver: Autosaver | null = null;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let unwatchSettings: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
let copySeq = 0;
let initToken = 0;

function getExporter(): Exporter {
  exporter ??= new Exporter();
  return exporter;
}

const INITIAL = {
  sessionId: null,
  session: null,
  source: null,
  load: { phase: 'idle' } as LoadState,
  doc: null,
  canUndo: false,
  canRedo: false,
  selection: [] as readonly ShapeId[],
  editingTextId: null,
  tool: 'arrow' as Tool,
  styles: DEFAULT_STYLES,
  camera: { x: 0, y: 0, zoom: 0.5 },
  viewport: { w: 0, h: 0 },
  copy: { state: 'idle' } as CopyStatus,
  download: { state: 'idle' } as DownloadStatus,
  _history: null,
  _settings: DEFAULT_SETTINGS,
  _fit: true,
  _compositeUrl: null,
  _compositeRev: -1,
} satisfies Partial<EditorState>;

export const useEditorStore = create<EditorState>()((set, get) => {
  /** Apply a history change: present doc, flags, selection pruned to existing shapes. */
  const applyHistory = (h: hist.History, selection?: readonly ShapeId[]) => {
    const ids = new Set(h.present.shapes.map((s) => s.id));
    const sel = (selection ?? get().selection).filter((id) => ids.has(id));
    set({
      _history: h,
      doc: h.present,
      canUndo: hist.canUndo(h),
      canRedo: hist.canRedo(h),
      selection: sel,
    });
  };

  const commitShapes = (shapes: readonly Shape[], selection?: readonly ShapeId[]) => {
    const { _history: h } = get();
    if (!h) return;
    applyHistory(hist.commit(h, { ...h.present, shapes }), selection);
  };

  const setCam = (cam: Camera, fit: boolean) => {
    const { session, viewport } = get();
    const next = session && viewport.w > 0 ? clampCamera(cam, session.image, viewport) : cam;
    const prev = get().camera;
    if (prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom && get()._fit === fit) {
      return;
    }
    set({ camera: next, _fit: fit });
  };

  const zoomTo = (zoom: number, anchor?: Point, fit = false) => {
    const { session, viewport, camera } = get();
    if (!session) return;
    const { min, max } = zoomLimits(session.dpr);
    const z = Math.max(min, Math.min(max, zoom));
    const a = anchor ?? { x: viewport.w / 2, y: viewport.h / 2 };
    setCam(zoomAround(camera, z, a), fit);
  };

  const planFor = (request: CopyRequest, s = get()): ExportPlan | null => {
    if (!s.session || !s.doc) return null;
    return planCopy({
      request,
      image: s.session.image,
      dpr: s.session.dpr,
      shapes: s.doc.shapes,
      view: visibleRect(s.camera, s.viewport),
      fullMaxCssHeight: s._settings.copy.fullMaxCssHeight,
      resolution: s._settings.copy.resolution,
    });
  };

  /** Pre-encode the default copy and the right-click composite for the current rev (03 §4.2). */
  const prewarm = () => {
    const s = get();
    if (!s.doc || !s.session || s.load.phase !== 'ready') return;
    const ex = getExporter();
    ex.cancelStale(s.doc.rev);
    const def = planFor('default', s);
    const full = planFor('full', s);
    if (!def || !full) return;
    void ex.render(s.doc, def, { priority: 'low' }).promise.catch(() => {});
    // The hidden right-click <img>: the full copy-resolution composite.
    const doc = s.doc;
    ex.render(doc, full, { priority: 'low' }).promise.then(
      (r) => {
        if (get().doc?.rev !== doc.rev) return;
        const old = get()._compositeUrl;
        set({ _compositeUrl: URL.createObjectURL(r.blob), _compositeRev: doc.rev });
        // Give the <img> time to switch before freeing the old one.
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1_000);
      },
      () => {},
    );
  };

  const schedulePrewarm = (delay = PREWARM_DELAY_MS) => {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null;
      prewarm();
    }, delay);
  };

  const engine: EngineActions = {
    _commit: (doc, selection) => {
      commitShapes(doc.shapes, selection);
    },
    _setViewport: (size) => {
      const prev = get().viewport;
      if (prev.w === size.w && prev.h === size.h) return;
      set({ viewport: size });
      const { session, _fit, camera } = get();
      if (!session || size.w <= 0) return;
      if (_fit) {
        // Keep the image row at the top of the view while refitting.
        const zoom = fitWidthZoom(session.image, size, session.dpr);
        const wasInitial = prev.w <= 0;
        const fitted = wasInitial
          ? fitWidthCamera(session.image, size, session.dpr)
          : { ...camera, zoom };
        setCam(fitted, true);
      } else {
        setCam(camera, false);
      }
    },
    _panZoom: (camera) => setCam(camera, false),
    _setEditingText: (id) => set({ editingTextId: id }),
    _firstPaint: () => {
      if (get().load.phase !== 'loading') return;
      perf.markFirstTiles();
      set({ load: { phase: 'ready' } });
      schedulePrewarm(50);
    },
    _planCopy: (request) => planFor(request),
    _exportNative: async (request) => {
      const s = get();
      const plan = planFor(request, s);
      if (!plan || !s.doc) throw new Error('NOT_READY');
      return (await getExporter().render(s.doc, nativePlan(plan), { priority: 'high' }).promise)
        .blob;
    },
    _reset: () => {
      initToken++;
      if (prewarmTimer) clearTimeout(prewarmTimer);
      prewarmTimer = null;
      autosaver?.dispose();
      autosaver = null;
      exporter?.dispose();
      exporter = null;
      unwatchSettings?.();
      unwatchSettings = null;
      unsubscribeStore?.();
      unsubscribeStore = null;
      get().source?.dispose();
      const url = get()._compositeUrl;
      if (url) URL.revokeObjectURL(url);
      set({ ...INITIAL });
    },
  };

  const actions: EditorActions = {
    init: async (sessionId) => {
      const cur = get();
      // React StrictMode mounts effects twice; a second init for the same session is a no-op.
      if (cur.sessionId === sessionId && cur.load.phase !== 'idle' && cur.load.phase !== 'error') {
        return;
      }
      const token = ++initToken;
      perf.markInit();
      set({ sessionId, load: { phase: 'loading' } });
      const stale = () => token !== initToken;

      let session: CaptureSession;
      try {
        session = await waitForFinalSession(sessionId, {
          onProgress: (snap) => {
            if (!stale() && snap.status === 'capturing') {
              set({ load: { phase: 'waiting', progress: snap.progress } });
            }
          },
        });
      } catch (err) {
        if (stale()) return;
        const code = errorCode(err) === 'NO_SESSION' ? 'NO_SESSION' : 'LOAD_FAILED';
        set({
          load: {
            phase: 'error',
            code,
            message: code === 'NO_SESSION' ? 'This capture no longer exists.' : errorCode(err),
          },
        });
        return;
      }
      if (stale()) return;
      if (session.status === 'error') {
        set({
          session,
          load: {
            phase: 'error',
            code: 'CAPTURE_FAILED',
            message: session.error?.message ?? 'The capture failed.',
          },
        });
        return;
      }
      set({ session, load: { phase: 'loading' } });

      const [settings, source, stored] = await Promise.all([
        getSettings().catch(() => DEFAULT_SETTINGS),
        openCaptureSource(sessionId).catch((err: unknown) => err as Error),
        getDoc(sessionId).catch(() => undefined),
      ]);
      if (stale()) {
        if (!(source instanceof Error)) source.dispose();
        return;
      }
      if (source instanceof Error) {
        const capFailed = source.message === 'CAPTURE_FAILED';
        set({
          load: {
            phase: 'error',
            code: capFailed
              ? 'CAPTURE_FAILED'
              : source.message === 'NO_SESSION'
                ? 'NO_SESSION'
                : 'LOAD_FAILED',
            message: capFailed ? (session.error?.message ?? 'The capture failed.') : source.message,
          },
        });
        return;
      }

      const image = { ...session.image, dpr: session.dpr };
      const backup = migrateDoc(readBackupDoc(sessionId));
      let migrated = migrateDoc(stored);
      if (backup && (!migrated || backup.rev > migrated.rev)) migrated = backup;
      const doc =
        migrated &&
        migrated.sessionId === sessionId &&
        migrated.image.w === image.w &&
        migrated.image.h === image.h
          ? migrated
          : emptyDoc(sessionId, image);
      const history = hist.createHistory(doc);
      const { viewport } = get();
      const camera =
        viewport.w > 0 ? fitWidthCamera(session.image, viewport, session.dpr) : get().camera;

      set({
        session,
        source,
        doc,
        _history: history,
        canUndo: false,
        canRedo: false,
        selection: [],
        editingTextId: null,
        _settings: settings,
        _fit: true,
        camera,
        styles: seedStyles(get().styles, settings.editor.defaultColor),
      });

      unwatchSettings?.();
      try {
        unwatchSettings = watchSettings((next) => {
          set({ _settings: next });
          schedulePrewarm();
        });
      } catch {
        unwatchSettings = null;
      }

      autosaver?.dispose();
      autosaver = new Autosaver();
      unsubscribeStore?.();
      let lastDoc = doc;
      let lastCam = camera;
      unsubscribeStore = useEditorStore.subscribe((s) => {
        if (s.doc && s.doc !== lastDoc) {
          lastDoc = s.doc;
          autosaver?.schedule(s.doc);
          schedulePrewarm();
        } else if (s.camera !== lastCam) {
          lastCam = s.camera;
          // The `viewport` copy outcome follows the view: re-warm once scrolling settles.
          if (s.load.phase === 'ready' && planFor('default', s)?.outcome === 'viewport') {
            schedulePrewarm(600);
          }
        }
      });
    },

    setTool: (tool) => {
      const s = get();
      if (s.tool === tool) return;
      set({ tool, selection: tool === 'select' ? s.selection : [] });
    },

    setColor: (color) => {
      const { tool, styles, selection, doc } = get();
      let nextStyles = styles;
      const family = (k: DrawTool) => (k === 'highlight' ? 'highlight' : 'ink');
      if (tool !== 'select') {
        const fam = family(tool);
        const updated = { ...styles };
        for (const k of Object.keys(updated) as DrawTool[]) {
          if (family(k) === fam) updated[k] = { ...updated[k], color };
        }
        nextStyles = updated;
      }
      set({ styles: nextStyles });
      if (doc && selection.length > 0) {
        const sel = new Set(selection);
        const shapes = doc.shapes.map((s) =>
          sel.has(s.id) && s.color !== color ? { ...s, color } : s,
        );
        if (shapes.some((s, i) => s !== doc.shapes[i])) commitShapes(shapes);
      }
    },

    setColorIndex: (index) => {
      const color = PALETTE[index];
      if (color) get().actions.setColor(color);
    },

    setSize: (sizeCss) => {
      const { tool, styles, selection, doc, session } = get();
      if (tool !== 'select')
        set({ styles: { ...styles, [tool]: { ...styles[tool], size: sizeCss } } });
      if (doc && session && selection.length > 0) {
        const sel = new Set(selection);
        const px = sizeCss * session.dpr;
        const shapes = doc.shapes.map((s) => (sel.has(s.id) ? withShapeSize(s, px) : s));
        if (shapes.some((s, i) => s !== doc.shapes[i])) commitShapes(shapes);
      }
    },

    stepSize: (direction) => {
      const { tool, styles, selection, doc, session } = get();
      if (tool !== 'select') {
        const size = stepSizeValue(SIZE_STEPS_CSS[tool], styles[tool].size, direction);
        set({ styles: { ...styles, [tool]: { ...styles[tool], size } } });
      }
      if (doc && session && selection.length > 0) {
        const sel = new Set(selection);
        const dpr = session.dpr;
        const shapes = doc.shapes.map((s) => {
          if (!sel.has(s.id)) return s;
          const css = stepSizeValue(SIZE_STEPS_CSS[sizeKindOf(s)], shapeSize(s) / dpr, direction);
          return withShapeSize(s, css * dpr);
        });
        commitShapes(shapes);
      }
    },

    undo: () => {
      const h = get()._history;
      if (h && hist.canUndo(h)) applyHistory(hist.undo(h));
    },
    redo: () => {
      const h = get()._history;
      if (h && hist.canRedo(h)) applyHistory(hist.redo(h));
    },

    setSelection: (ids) => {
      const doc = get().doc;
      const exist = new Set(doc?.shapes.map((s) => s.id) ?? []);
      set({ selection: ids.filter((id) => exist.has(id)) });
    },
    selectAll: () => {
      const doc = get().doc;
      if (!doc || doc.shapes.length === 0) return;
      set({ tool: 'select', selection: doc.shapes.map((s) => s.id) });
    },
    clearSelection: () => {
      if (get().selection.length > 0) set({ selection: [] });
    },
    deleteSelection: () => {
      const { doc, selection } = get();
      if (!doc || selection.length === 0) return;
      const sel = new Set(selection);
      commitShapes(
        doc.shapes.filter((s) => !sel.has(s.id)),
        [],
      );
    },

    setCamera: (camera) => {
      const cur = get().camera;
      const next = { ...cur, ...camera };
      setCam(next, get()._fit && next.zoom === cur.zoom);
    },
    zoomBy: (factor, anchor) => zoomTo(get().camera.zoom * factor, anchor),
    fitWidth: () => {
      const { session, viewport, camera } = get();
      if (!session || viewport.w <= 0) return;
      const zoom = fitWidthZoom(session.image, viewport, session.dpr);
      // Keep the image row at the vertical centre of the view.
      const midY = camera.y + viewport.h / 2 / camera.zoom;
      setCam({ x: 0, y: midY - viewport.h / 2 / zoom, zoom }, true);
    },
    zoomActual: () => {
      const { session } = get();
      if (session) zoomTo(1 / session.dpr);
    },

    copy: (request) => {
      const s = get();
      const seq = ++copySeq;
      const plan = planFor(request, s);
      if (!plan || !s.doc || s.load.phase !== 'ready') {
        set({
          copy: {
            state: 'failed',
            request,
            reason: 'error',
            message: 'Nothing to copy yet.',
            at: Date.now(),
          },
        });
        return;
      }
      const ex = getExporter();
      const hit = ex.peek(s.doc, plan) !== null;
      const handle = ex.render(s.doc, plan, { priority: 'high' });
      // The user is waiting: stop background prewarms (re-run once this copy is done).
      ex.cancelStale(Number.POSITIVE_INFINITY);
      const t0 = performance.now();
      const blob = handle.promise.then((r) => r.blob);
      set({ copy: { state: 'copying', request } });
      // Synchronous call inside the user's key/click handler: focus and activation are checked
      // now, the PNG may arrive later (03 §4.2).
      writeImageToClipboard(blob).then(
        () => {
          perf.recordCopy({
            request,
            outcome: plan.outcome,
            ms: performance.now() - t0,
            cacheHit: hit,
            size: plan.size,
            key: planKey(s.doc?.rev ?? 0, plan),
          });
          schedulePrewarm();
          if (seq !== copySeq) return;
          set({
            copy: {
              state: 'copied',
              request,
              outcome: plan.outcome,
              size: plan.size,
              tall: plan.tall,
              at: Date.now(),
            },
          });
        },
        (err: unknown) => {
          if (seq !== copySeq) return;
          const notFocused = isNotFocusedError(err);
          set({
            copy: {
              state: 'failed',
              request,
              reason: notFocused ? 'not-focused' : 'error',
              message: notFocused ? 'Click the page, then ⌘C again' : errorCode(err),
              at: Date.now(),
            },
          });
        },
      );
    },

    download: () => {
      const s = get();
      if (!s.session || !s.doc || s.load.phase !== 'ready') return;
      if (s.download.state === 'saving') return;
      const plan = planDownload(s.session.image, s.session.dpr);
      const filename = exportFilename({
        url: s.session.url,
        title: s.session.title,
        capturedAt: s.session.createdAt,
      });
      set({ download: { state: 'saving' } });
      const ex = getExporter();
      const job = ex.render(s.doc, plan, { priority: 'high' });
      ex.cancelStale(Number.POSITIVE_INFINITY);
      job.promise
        .finally(() => schedulePrewarm())
        .then(
          (r) => {
            const url = URL.createObjectURL(r.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.rel = 'noopener';
            a.style.display = 'none';
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            set({ download: { state: 'saved', filename, size: r.size, at: Date.now() } });
          },
          (err: unknown) => {
            set({ download: { state: 'failed', message: errorCode(err), at: Date.now() } });
          },
        );
    },

    dismissStatus: () => set({ copy: { state: 'idle' }, download: { state: 'idle' } }),
  };

  return { ...INITIAL, actions, _engine: engine };
});

/** Flush the pending autosave right away (page hide). */
export function flushAutosave(): Promise<void> {
  return autosaver?.flush() ?? Promise.resolve();
}

// ---------------------------------------------------------------- e2e hooks

if (import.meta.env.MODE === 'e2e' && typeof window !== 'undefined') {
  const store = useEditorStore;
  window.__pagesnapTest = {
    isReady: () => store.getState().load.phase === 'ready',
    exportPng: async (scope) => blobToBase64(await store.getState()._engine._exportNative(scope)),
  };
  (window as unknown as { __pagesnapEngine: unknown }).__pagesnapEngine = {
    state: () => store.getState(),
    perf,
    flushAutosave,
    plan: (request: CopyRequest) => store.getState()._engine._planCopy(request),
    /** Base64 of the cached/rendered PNG the copy would use (copy resolution). */
    exportCopyPng: async (request: CopyRequest) => {
      const s = store.getState();
      const plan = s._engine._planCopy(request);
      if (!plan || !s.doc) throw new Error('NOT_READY');
      return blobToBase64((await getExporter().render(s.doc, plan).promise).blob);
    },
  };
}
