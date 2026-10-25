/**
 * Editor store: the contract between the editor engine (B, implements) and the editor UI (C,
 * consumes). C reads state with `useEditorStore(selector)` and calls `actions.*`; C never writes
 * state directly and never imports engine internals (only `@/editor/engine`).
 *
 * B may add internal fields and actions (prefix them with `_`) and replace the implementation
 * freely. Renaming, removing or changing the meaning of anything below the "CONTRACT" markers
 * needs a note in docs/CONTRACTS.md first.
 *
 * PHASE-0 STUB: state and the simple setters work so C can build against it; engine actions
 * (init, undo/redo, copy, download, camera) are placeholders until B lands.
 */
import { create } from 'zustand';
import {
  type AnnotationDoc,
  type Color,
  DEFAULT_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_SIZES_CSS,
  PALETTE,
  type ShapeId,
  type ShapeKind,
} from '@/shared/annotations';
import type { CaptureSource } from '@/shared/source';
import type { CaptureSession, Point, SessionId, Size } from '@/shared/types';

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

// ---------------------------------------------------------------- PHASE-0 stub implementation

const notImplemented = (name: string) => () => {
  console.warn(`[pagesnap] editor action "${name}" is not implemented yet`);
};

export const useEditorStore = create<EditorState>()((set, get) => ({
  sessionId: null,
  session: null,
  source: null,
  load: { phase: 'idle' },
  doc: null,
  canUndo: false,
  canRedo: false,
  selection: [],
  editingTextId: null,
  tool: 'arrow',
  styles: DEFAULT_STYLES,
  camera: { x: 0, y: 0, zoom: 0.5 },
  viewport: { w: 0, h: 0 },
  copy: { state: 'idle' },
  download: { state: 'idle' },
  actions: {
    init: async (sessionId) => {
      set({ sessionId, load: { phase: 'loading' } });
    },
    setTool: (tool) => set({ tool }),
    setColor: (color) => {
      const { tool, styles } = get();
      if (tool === 'select') return;
      set({ styles: { ...styles, [tool]: { ...styles[tool], color } } });
    },
    setColorIndex: (index) => {
      const color = PALETTE[index];
      if (color) get().actions.setColor(color);
    },
    setSize: (size) => {
      const { tool, styles } = get();
      if (tool === 'select') return;
      set({ styles: { ...styles, [tool]: { ...styles[tool], size } } });
    },
    stepSize: notImplemented('stepSize'),
    undo: notImplemented('undo'),
    redo: notImplemented('redo'),
    setSelection: (ids) => set({ selection: ids }),
    selectAll: notImplemented('selectAll'),
    clearSelection: () => set({ selection: [] }),
    deleteSelection: notImplemented('deleteSelection'),
    setCamera: (camera) => set({ camera: { ...get().camera, ...camera } }),
    zoomBy: notImplemented('zoomBy'),
    fitWidth: notImplemented('fitWidth'),
    zoomActual: notImplemented('zoomActual'),
    copy: notImplemented('copy'),
    download: notImplemented('download'),
    dismissStatus: () => set({ copy: { state: 'idle' }, download: { state: 'idle' } }),
  },
}));
