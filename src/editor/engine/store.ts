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
import type { CaptureSession, Point, Rect, SessionId, Size } from '@/shared/types';
import { Autosaver, DocSync, readBackupDoc } from './autosave';
import { isNotFocusedError, writeImageToClipboard } from './clipboard';
import { Exporter, exportTimeoutMs } from './exporter';
import { exportFilename } from './filename';
import {
  clampCamera,
  fitWidthCamera,
  fitWidthZoom,
  translateShape,
  visibleRect,
  zoomAround,
  zoomLimits,
} from './geometry';
import * as hist from './history';
import { perf } from './perf';
import {
  type CopyScopeKind,
  type CopyScopeMode,
  type ExportPlan,
  nativePlan,
  planCopy,
  planDownload,
  planKey,
} from './scope';

export type { CopyScopeKind, CopyScopeMode } from './scope';

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

/** What a copy contained, for the toast (design review §4/§5). */
export interface CopyScopeInfo {
  kind: CopyScopeKind;
  /** `settings.editor.copyScope` in effect. */
  mode: CopyScopeMode;
  /** The copied region, image px (after edge snapping). */
  region: Rect;
  /** Its top and bottom edges and height, CSS px of the page (rounded). */
  cssTop: number;
  cssBottom: number;
  cssHeight: number;
  /** The whole page's height, CSS px (rounded). */
  pageCssHeight: number;
}

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
      /** Which part of the page was copied. Always set by the engine (optional for old literals). */
      scope?: CopyScopeInfo;
      at: number;
    }
  | {
      state: 'failed';
      request: CopyRequest;
      /**
       * `not-focused`: the page lost focus; UI should say "Click the page, then ⌘C again".
       * `loading`: the editor isn't ready yet ("Still loading…"). `timeout`: the export or the
       * clipboard write didn't finish in time.
       */
      reason: 'not-focused' | 'error' | 'loading' | 'timeout';
      message: string;
      at: number;
    };

export type DownloadStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; filename: string; size: Size; at: number }
  | { state: 'failed'; message: string; at: number; reason?: 'loading' | 'timeout' | 'error' };

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
  /** Move the selection by (dx, dy) image px; a burst of nudges is one undo step. */
  _nudge(dx: number, dy: number): void;
  /** Is the right-click composite the current default copy? */
  _compositeFresh(): boolean;
  /** Encode the right-click composite now, ahead of everything else. */
  _prepareComposite(): void;
  /** The canvas element's CSS size changed. */
  _setViewport(size: Size): void;
  /** Camera change from user input (wheel, pinch, pan). A zoom change leaves fit-width mode. */
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
  /**
   * When this tab last adopted a newer doc written by another editor tab of the same capture
   * (its undo history restarts there). `null` if never.
   */
  externalEditAt: number | null;

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
  /** Export key (session, rev, default-copy plan) of the composite; null when there is none. */
  _compositeKey: string | null;
  _engine: EngineActions;
}

// ---------------------------------------------------------------- CONTRACT: selectors

export const selectActiveStyle = (s: EditorState): ToolStyle | null =>
  s.tool === 'select' ? null : s.styles[s.tool];

/** Zoom as a percentage of the page's natural CSS size. */
export const selectZoomPercent = (s: EditorState): number =>
  Math.round(s.camera.zoom * (s.session?.dpr ?? 1) * 100);

export const selectIsReady = (s: EditorState): boolean => s.load.phase === 'ready';

/** True while the camera follows fit-width (the zoom label can say "Fit"). */
export const selectIsFitWidth = (s: EditorState): boolean => s._fit;

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
export const PREWARM_DELAY_MS = 250;
/** Keyboard nudges this close together are one undo step. */
const NUDGE_COALESCE_MS = 1_000;

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
let docSync: DocSync | null = null;
/** The last doc adopted from another tab (not re-broadcast). */
let adoptedDoc: AnnotationDoc | null = null;
let lastNudge: { at: number; ids: string } | null = null;

/** `settings.editor.copyScope`, read defensively (older settings don't have it). */
function copyScopeOf(settings: Settings): CopyScopeMode {
  const v = (settings.editor as { copyScope?: unknown } | undefined)?.copyScope;
  return v === 'tight' ? 'tight' : 'fill';
}

function scopeInfo(
  plan: ExportPlan,
  region: Rect,
  session: CaptureSession,
  mode: CopyScopeMode,
): CopyScopeInfo {
  const d = session.dpr || 1;
  const cssTop = Math.round(region.y / d);
  const cssBottom = Math.round((region.y + region.h) / d);
  return {
    kind: plan.kind,
    mode,
    region: { ...region },
    cssTop,
    cssBottom,
    cssHeight: cssBottom - cssTop,
    pageCssHeight: Math.round(session.image.h / d),
  };
}

function isTimeout(err: unknown): boolean {
  const n = (err as { name?: string })?.name;
  return n === 'TimeoutError';
}

/** Reject with a `TimeoutError` if `p` takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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
  externalEditAt: null,
  _history: null,
  _settings: DEFAULT_SETTINGS,
  _fit: true,
  _compositeUrl: null,
  _compositeRev: -1,
  _compositeKey: null,
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
      scope: copyScopeOf(s._settings),
    });
  };

  /** Cache key of the right-click composite: the default copy of this rev. */
  const compositeKey = (s = get()): string | null => {
    const plan = planFor('default', s);
    return plan && s.doc ? `${s.doc.sessionId}|${planKey(s.doc.rev, plan)}` : null;
  };

  const setComposite = (url: string | null, key: string | null, rev: number) => {
    const old = get()._compositeUrl;
    if (old === url) return;
    set({ _compositeUrl: url, _compositeKey: key, _compositeRev: url ? rev : -1 });
    // Give the <img> time to switch (or an open menu to finish) before freeing the old one.
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1_000);
  };

  /**
   * Pre-encode the default copy (03 §4.2). The same PNG backs the right-click "Copy image"
   * `<img>`, so it is small (≤ the AI budget) and ready soon after every edit.
   */
  const prewarm = (priority: 'low' | 'high' = 'low') => {
    const s = get();
    if (!s.doc || !s.session || (s.load.phase !== 'ready' && s.load.phase !== 'loading')) return;
    const ex = getExporter();
    ex.cancelStale(s.doc.rev);
    const def = planFor('default', s);
    const key = compositeKey(s);
    if (!def || !key || s._compositeKey === key) return;
    const doc = s.doc;
    ex.render(doc, def, { priority, timeoutMs: exportTimeoutMs(def.size) }).promise.then(
      (r) => {
        // Only if it is still what ⌘C would copy (no edit, no scroll meanwhile).
        if (compositeKey() !== key) return;
        setComposite(URL.createObjectURL(r.blob), key, doc.rev);
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
      lastNudge = null;
      commitShapes(doc.shapes, selection);
    },
    _nudge: (dx, dy) => {
      const { _history: h, selection, doc } = get();
      if (!h || !doc || selection.length === 0 || (dx === 0 && dy === 0)) return;
      const sel = new Set(selection);
      const shapes = doc.shapes.map((sh) => (sel.has(sh.id) ? translateShape(sh, dx, dy) : sh));
      const ids = [...selection].sort().join(',');
      const now = Date.now();
      const burst = lastNudge && lastNudge.ids === ids && now - lastNudge.at < NUDGE_COALESCE_MS;
      lastNudge = { at: now, ids };
      const next = { ...h.present, shapes };
      applyHistory(burst && hist.canUndo(h) ? hist.amend(h, next) : hist.commit(h, next));
    },
    _compositeFresh: () => {
      const s = get();
      return !!s._compositeUrl && s._compositeKey !== null && s._compositeKey === compositeKey(s);
    },
    _prepareComposite: () => {
      if (prewarmTimer) clearTimeout(prewarmTimer);
      prewarmTimer = null;
      prewarm('high');
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
    // Scrolling at the fit zoom keeps following fit-width (a window resize refits); any zoom
    // change leaves it.
    _panZoom: (camera) => setCam(camera, get()._fit && camera.zoom === get().camera.zoom),
    _setEditingText: (id) => set({ editingTextId: id }),
    _firstPaint: () => {
      if (get().load.phase !== 'loading') return;
      perf.markFirstTiles();
      set({ load: { phase: 'ready' } });
      // Usually already running since init; this makes sure (and is a no-op when it is).
      schedulePrewarm(0);
    },
    _planCopy: (request) => planFor(request),
    _exportNative: async (request) => {
      const s = get();
      const plan = planFor(request, s);
      if (!plan || !s.doc) throw new Error('NOT_READY');
      const native = nativePlan(plan);
      return (
        await getExporter().render(s.doc, native, {
          priority: 'high',
          timeoutMs: exportTimeoutMs(native.size),
        }).promise
      ).blob;
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
      docSync?.dispose();
      docSync = null;
      adoptedDoc = null;
      lastNudge = null;
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
      let fromBackup = false;
      if (backup && (!migrated || backup.rev > migrated.rev)) {
        migrated = backup;
        fromBackup = true;
      }
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
      // The sessionStorage mirror was newer than IDB (the tab reloaded before the IDB write
      // landed): write it back now, or closing the tab would lose it.
      if (fromBackup && doc === migrated) autosaver.schedule(doc);

      // Other editor tabs on this capture: the newest doc wins in every tab.
      docSync?.dispose();
      docSync = new DocSync(
        sessionId,
        () => get().doc,
        (remote) => {
          if (stale()) return;
          const cur = get();
          if (!cur.doc || remote.image.w !== cur.doc.image.w || remote.image.h !== cur.doc.image.h)
            return;
          adoptedDoc = remote;
          lastNudge = null;
          applyHistory(hist.reset(remote));
          set({ externalEditAt: Date.now() });
        },
      );

      unsubscribeStore?.();
      let lastDoc = doc;
      let lastCam = camera;
      unsubscribeStore = useEditorStore.subscribe((s) => {
        if (s.doc && s.doc !== lastDoc) {
          lastDoc = s.doc;
          // The right-click image must never show an older doc: drop it at once.
          if (s._compositeUrl && s._compositeRev !== s.doc.rev) setComposite(null, null, -1);
          autosaver?.schedule(s.doc);
          if (s.doc !== adoptedDoc) docSync?.publish(s.doc);
          schedulePrewarm();
        } else if (s.camera !== lastCam) {
          lastCam = s.camera;
          // "From here down" follows the view: re-warm once scrolling settles.
          if (s.load.phase === 'ready' && s._compositeKey !== compositeKey(s)) schedulePrewarm(300);
        }
      });
      // Start the default copy (and the right-click image) right away, while the first tiles
      // decode in their own worker: the first ⌘C on a huge page shouldn't wait for it.
      schedulePrewarm(0);
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
      const plan = s.load.phase === 'ready' ? planFor(request, s) : null;
      if (!plan || !s.doc || !s.session) {
        const failedLoad = s.load.phase === 'error';
        set({
          copy: {
            state: 'failed',
            request,
            reason: failedLoad ? 'error' : 'loading',
            message: failedLoad ? 'There is nothing to copy.' : 'Still loading',
            at: Date.now(),
          },
        });
        return;
      }
      const ex = getExporter();
      const doc = s.doc;
      const session = s.session;
      const mode = copyScopeOf(s._settings);
      const hit = ex.peek(doc, plan) !== null;
      const timeoutMs = exportTimeoutMs(plan.size);
      const handle = ex.render(doc, plan, { priority: 'high', timeoutMs });
      // The user is waiting: stop background prewarms (re-run once this copy is done).
      ex.cancelStale(Number.POSITIVE_INFINITY);
      const t0 = performance.now();
      const blob = handle.promise.then((r) => r.blob);
      set({ copy: { state: 'copying', request } });
      // Synchronous call inside the user's key/click handler: focus and activation are checked
      // now, the PNG may arrive later (03 §4.2). The write itself can hang (headless, a stuck
      // blob), so it gets a deadline too.
      withTimeout(
        writeImageToClipboard(blob).then(() => handle.promise),
        timeoutMs + 5_000,
        'Copying took too long',
      ).then(
        (r) => {
          perf.recordCopy({
            request,
            outcome: plan.outcome,
            ms: performance.now() - t0,
            cacheHit: hit,
            size: r.size,
            key: planKey(doc.rev, plan),
          });
          schedulePrewarm();
          if (seq !== copySeq) return;
          set({
            copy: {
              state: 'copied',
              request,
              outcome: plan.outcome,
              size: r.size,
              tall: plan.tall,
              scope: scopeInfo(plan, r.region ?? plan.region, session, mode),
              at: Date.now(),
            },
          });
        },
        (err: unknown) => {
          schedulePrewarm();
          if (seq !== copySeq) return;
          const notFocused = isNotFocusedError(err);
          const timedOut = isTimeout(err);
          set({
            copy: {
              state: 'failed',
              request,
              reason: notFocused ? 'not-focused' : timedOut ? 'timeout' : 'error',
              message: notFocused
                ? 'Click the page, then ⌘C again'
                : timedOut
                  ? 'Copying took too long.'
                  : errorCode(err),
              at: Date.now(),
            },
          });
        },
      );
    },

    download: () => {
      const s = get();
      if (s.download.state === 'saving') return;
      if (!s.session || !s.doc || s.load.phase !== 'ready') {
        const failedLoad = s.load.phase === 'error';
        set({
          download: {
            state: 'failed',
            reason: failedLoad ? 'error' : 'loading',
            message: failedLoad ? 'There is nothing to save.' : 'Still loading',
            at: Date.now(),
          },
        });
        return;
      }
      const plan = planDownload(s.session.image, s.session.dpr);
      const filename = exportFilename({
        url: s.session.url,
        title: s.session.title,
        capturedAt: s.session.createdAt,
      });
      set({ download: { state: 'saving' } });
      const ex = getExporter();
      const job = ex.render(s.doc, plan, {
        priority: 'high',
        timeoutMs: exportTimeoutMs(plan.size),
      });
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
            // The download holds its own reference once it starts; don't pin a 50 MB blob.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            set({ download: { state: 'saved', filename, size: r.size, at: Date.now() } });
          },
          (err: unknown) => {
            const timedOut = isTimeout(err);
            set({
              download: {
                state: 'failed',
                reason: timedOut ? 'timeout' : 'error',
                message: timedOut ? 'Saving took too long.' : errorCode(err),
                at: Date.now(),
              },
            });
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
