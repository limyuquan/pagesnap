/**
 * The editor's single top bar: page identity on the left, tools / colour / size in the centre,
 * history / zoom / download / copy on the right.
 *
 * Performance: every control subscribes to the smallest slice of the store it needs and returns
 * primitives, so pointer moves and camera pans don't re-render the bar. Only the zoom label
 * re-renders on zoom changes, and only the two affected tool buttons re-render on a tool switch.
 */
import { memo, useEffect, useRef, useState } from 'react';
import {
  type DrawTool,
  type EditorState,
  selectIsFitWidth,
  selectIsReady,
  selectZoomPercent,
  TOOL_LABELS,
  TOOL_SHORTCUTS,
  TOOLS,
  type Tool,
  useEditorStore,
} from '@/editor/engine';
import { PALETTE, type Shape, type ShapeKind, SIZE_STEPS_CSS } from '@/shared/annotations';
import { CheckIcon, DownloadIcon, RedoIcon, SpinnerIcon, TOOL_ICONS, UndoIcon } from './icons';
import { combo } from './keys';
import { MenuButton } from './Menu';
import { innerScrollerNote } from './messages';
import { COLOR_NAMES } from './palette';
import { countRender } from './testHook';
import type { SessionMeta } from './useSessionMeta';

const actions = () => useEditorStore.getState().actions;

// ---------------------------------------------------------------- identity

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

export const Identity = memo(function Identity({ meta }: { meta: SessionMeta | null | undefined }) {
  countRender('Identity');
  if (!meta) return <span />;
  const host = hostOf(meta.url);
  const title = meta.title.trim() || host || 'Untitled page';
  const note = innerScrollerNote(meta);
  const tip = note ? `${meta.url}\n${note}` : meta.url;
  const body = (
    <>
      <span className="ps-ident-title" data-testid="page-title">
        {title}
      </span>
      {host && <span className="ps-ident-host">{host}</span>}
    </>
  );
  return host ? (
    <a
      className="ps-ident"
      href={meta.url}
      target="_blank"
      rel="noreferrer"
      title={tip}
      aria-label={`${title}, open the original page`}
    >
      {body}
    </a>
  ) : (
    <span className="ps-ident" title={tip}>
      {body}
    </span>
  );
});

// ---------------------------------------------------------------- tools

const ToolButton = memo(function ToolButton({ tool }: { tool: Tool }) {
  countRender('ToolButton');
  const active = useEditorStore((s) => s.tool === tool);
  const Icon = TOOL_ICONS[tool];
  const key = TOOL_SHORTCUTS[tool].toUpperCase();
  return (
    <button
      type="button"
      className="ps-btn"
      aria-pressed={active}
      aria-label={TOOL_LABELS[tool]}
      aria-keyshortcuts={key}
      data-tip={TOOL_LABELS[tool]}
      data-kbd={key}
      data-tool={tool}
      onClick={() => actions().setTool(tool)}
    >
      <Icon />
    </button>
  );
});

export function ToolGroup() {
  return (
    <fieldset className="ps-group" aria-label="Tools">
      {TOOLS.map((t) => (
        <ToolButton key={t} tool={t} />
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------- style (colour, size)

/**
 * The draw tool whose style the colour and size controls show in Select mode with nothing
 * selected, so they read "inactive" rather than blank. Updated by a store subscription made at
 * module load, which runs before React's own listeners.
 */
let lastDrawTool: DrawTool = 'arrow';
useEditorStore.subscribe((s) => {
  if (s.tool !== 'select') lastDrawTool = s.tool;
});

function selectedShapes(s: EditorState): Shape[] {
  if (!s.doc || s.selection.length === 0) return [];
  const ids = new Set(s.selection);
  return s.doc.shapes.filter((sh) => ids.has(sh.id));
}

const selectStyleEnabled = (s: EditorState) => s.tool !== 'select' || s.selection.length > 0;

/** Colour of the active tool, or the shared colour of the selection (`null` if mixed). */
const selectActiveColor = (s: EditorState): string | null => {
  if (s.tool !== 'select') return s.styles[s.tool].color;
  const shapes = selectedShapes(s);
  if (shapes.length === 0) return s.styles[lastDrawTool].color;
  const first = shapes[0]?.color;
  return first && shapes.every((sh) => sh.color === first) ? first : null;
};

function shapeSizeImagePx(sh: Shape): number {
  switch (sh.kind) {
    case 'arrow':
    case 'rect':
    case 'underline':
      return sh.width;
    case 'highlight':
      return sh.thickness;
    case 'pen':
    case 'text':
      return sh.size;
  }
}

const selectSizeKind = (s: EditorState): ShapeKind =>
  s.tool !== 'select' ? s.tool : (selectedShapes(s)[0]?.kind ?? lastDrawTool);

const selectSize = (s: EditorState): number => {
  if (s.tool !== 'select') return s.styles[s.tool].size;
  const first = selectedShapes(s)[0];
  if (!first || !s.doc) return s.styles[lastDrawTool].size;
  return Math.round(shapeSizeImagePx(first) / (s.doc.image.dpr || 1));
};

/** Index of a colour in `PALETTE`, or -1. */
const paletteIndex = (c: string | null) =>
  c ? PALETTE.findIndex((p) => p.toLowerCase() === c.toLowerCase()) : -1;

/**
 * One colour well (the current colour) that opens the eight swatches as a row. Most sessions never
 * leave red, so the bar stays quiet; keys 1–8 work without opening it.
 */
export const ColorWell = memo(function ColorWell() {
  countRender('ColorWell');
  const active = useEditorStore(selectActiveColor);
  const enabled = useEditorStore(selectStyleEnabled);
  const idx = paletteIndex(active);
  const name = active == null ? 'Mixed' : (COLOR_NAMES[idx] ?? 'Custom');
  return (
    <MenuButton
      label={`Colour, ${name}`}
      tip="Colour"
      kbd="1–8"
      disabled={!enabled}
      className="ps-tbtn ps-well"
      testId="color-button"
      orientation="horizontal"
      popClassName="ps-pop-colors"
      button={
        <span
          className="ps-dot"
          data-tone={toneOf(active)}
          data-mixed={active == null || undefined}
          style={active ? ({ '--sw': active } as React.CSSProperties) : undefined}
          aria-hidden="true"
        />
      }
    >
      {(close) =>
        PALETTE.map((c, i) => (
          <button
            key={c}
            type="button"
            role="menuitemradio"
            aria-checked={i === idx}
            aria-label={COLOR_NAMES[i]}
            aria-keyshortcuts={String(i + 1)}
            className="ps-swatch-item"
            data-color={c}
            onClick={() => {
              actions().setColorIndex(i);
              close();
            }}
          >
            <span
              className="ps-dot"
              data-tone={toneOf(c)}
              style={{ '--sw': c } as React.CSSProperties}
            />
            <span className="ps-swatch-key" aria-hidden="true">
              {i + 1}
            </span>
          </button>
        ))
      }
    </MenuButton>
  );
});

/**
 * `black` / `white` for the swatches whose luminance is close to the chrome in one of the schemes
 * (they get a stronger rim there, so they don't read as an empty ring).
 */
function toneOf(c: string | null): 'black' | 'white' | undefined {
  if (!c) return undefined;
  const n = Number.parseInt(c.slice(1, 7), 16);
  if (Number.isNaN(n)) return undefined;
  const l = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return l < 0.15 ? 'black' : l > 0.92 ? 'white' : undefined;
}

/** Rank of a size among its tool's steps (0 = thinnest). */
function rankOf(kind: ShapeKind, size: number): number {
  const steps = SIZE_STEPS_CSS[kind];
  let rank = 0;
  let best = Number.POSITIVE_INFINITY;
  for (const [i, s] of steps.entries()) {
    const d = Math.abs(s - size);
    if (d < best) {
      best = d;
      rank = i;
    }
  }
  return rank / Math.max(1, steps.length - 1);
}

/** The bar's compact size glyph: a dot by rank, so every tool previews alike. */
function SizeDot({ kind, size }: { kind: ShapeKind; size: number }) {
  const d = 3 + rankOf(kind, size) * 9;
  return (
    <span className="ps-size-dot" aria-hidden="true">
      <span style={{ width: d, height: d }} />
    </span>
  );
}

/**
 * Menu preview: the real stroke, a 22 px line at the actual width (round caps) for strokes; a
 * band for the highlighter (scaled, it would not fit the row); a letter for text.
 */
function SizePreview({ kind, size }: { kind: ShapeKind; size: number }) {
  if (kind === 'text') {
    return (
      <span className="ps-size-prev" aria-hidden="true">
        <span className="ps-size-text" style={{ fontSize: 9 + rankOf(kind, size) * 11 }}>
          A
        </span>
      </span>
    );
  }
  const h = kind === 'highlight' ? Math.max(3, Math.round(size / 3.2)) : Math.min(size, 16);
  return (
    <span className="ps-size-prev" aria-hidden="true">
      <span
        className="ps-size-line"
        data-band={kind === 'highlight' || undefined}
        style={{ height: h, borderRadius: kind === 'highlight' ? 1 : h / 2 }}
      />
    </span>
  );
}

const SIZE_TIPS: Record<ShapeKind, string> = {
  arrow: 'Stroke width',
  rect: 'Stroke width',
  underline: 'Stroke width',
  highlight: 'Highlighter height',
  pen: 'Pen size',
  text: 'Text size',
};

/** Flashes the size glyph when the size changes for the same tool (`[` / `]`, menu). */
function useBump(kind: ShapeKind, size: number): number {
  const prev = useRef({ kind, size, n: 0 });
  if (prev.current.kind === kind && prev.current.size !== size) prev.current.n++;
  prev.current.kind = kind;
  prev.current.size = size;
  return prev.current.n;
}

export const SizeControl = memo(function SizeControl() {
  countRender('SizeControl');
  const kind = useEditorStore(selectSizeKind);
  const size = useEditorStore(selectSize);
  const enabled = useEditorStore(selectStyleEnabled);
  const bump = useBump(kind, size);
  const steps = SIZE_STEPS_CSS[kind];
  return (
    <MenuButton
      label={`${SIZE_TIPS[kind]}, ${size} px`}
      tip={SIZE_TIPS[kind]}
      kbd="[ ]"
      disabled={!enabled}
      className="ps-tbtn ps-size"
      testId="size-button"
      button={
        <>
          <span key={bump} className="ps-size-glyph" data-bump={bump > 0 || undefined}>
            <SizeDot kind={kind} size={size} />
          </span>
          <span className="ps-size-num tnum" data-testid="size-value">
            {size}
          </span>
        </>
      }
    >
      {(close) =>
        steps.map((n) => (
          <button
            key={n}
            type="button"
            role="menuitemradio"
            aria-checked={n === size}
            className="ps-menuitem"
            data-size={n}
            onClick={() => {
              actions().setSize(n);
              close();
            }}
          >
            <SizePreview kind={kind} size={n} />
            <span className="tnum">{n} px</span>
            {n === size && <CheckIcon className="ps-check ml-auto" />}
          </button>
        ))
      }
    </MenuButton>
  );
});

// ---------------------------------------------------------------- history, zoom

export const HistoryButtons = memo(function HistoryButtons() {
  countRender('HistoryButtons');
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  return (
    <fieldset className="ps-group" aria-label="History">
      <button
        type="button"
        className="ps-btn"
        aria-label="Undo"
        aria-keyshortcuts="Meta+Z"
        data-tip="Undo"
        data-kbd={combo('mod+z')}
        disabled={!canUndo}
        onClick={() => actions().undo()}
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        className="ps-btn"
        aria-label="Redo"
        aria-keyshortcuts="Shift+Meta+Z"
        data-tip="Redo"
        data-kbd={combo('mod+shift+z')}
        disabled={!canRedo}
        onClick={() => actions().redo()}
      >
        <RedoIcon />
      </button>
    </fieldset>
  );
});

/**
 * The zoom label says `Fit` until the user changes the zoom. Scrolling alone may end the
 * engine's fit-following, but the page is still at its fit-width zoom, so the label stays.
 */
let fitPct: number | null = null;
useEditorStore.subscribe((s) => {
  if (selectIsFitWidth(s)) fitPct = selectZoomPercent(s);
});
const selectIsFit = (s: EditorState) =>
  selectIsFitWidth(s) || (fitPct != null && selectZoomPercent(s) === fitPct);

export const ZoomControl = memo(function ZoomControl() {
  countRender('ZoomControl');
  const pct = useEditorStore(selectZoomPercent);
  const fit = useEditorStore(selectIsFit);
  const ready = useEditorStore(selectIsReady);
  const items: { label: string; kbd: string; on?: boolean; run: () => void }[] = [
    { label: 'Zoom in', kbd: combo('mod+='), run: () => actions().zoomBy(1.25) },
    { label: 'Zoom out', kbd: combo('mod+-'), run: () => actions().zoomBy(0.8) },
    { label: 'Fit width', kbd: combo('mod+0'), on: fit, run: () => actions().fitWidth() },
    {
      label: 'Actual size',
      kbd: combo('mod+1'),
      on: !fit && pct === 100,
      run: () => actions().zoomActual(),
    },
  ];
  return (
    <MenuButton
      label={fit ? `Zoom, fit width (${pct}%)` : `Zoom, ${pct}%`}
      tip="Zoom"
      disabled={!ready}
      align="end"
      testId="zoom-button"
      className="ps-tbtn ps-zoom"
      button={
        <span
          className="tnum ps-zoom-label"
          data-testid="zoom-value"
          data-fit={fit || undefined}
          style={ready ? undefined : { visibility: 'hidden' }}
        >
          {fit ? 'Fit' : `${pct}%`}
        </span>
      }
    >
      {(close) =>
        items.map((it, i) => (
          <div key={it.label}>
            {i === 2 && <div className="ps-menu-sep" />}
            {it.on === undefined ? (
              <button
                type="button"
                role="menuitem"
                className="ps-menuitem ps-menuitem-check"
                onClick={() => {
                  it.run();
                  close();
                }}
              >
                <span className="ps-menuitem-mark" aria-hidden="true" />
                {it.label}
                <span className="ps-menuitem-kbd">{it.kbd}</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={it.on}
                className="ps-menuitem ps-menuitem-check"
                onClick={() => {
                  it.run();
                  close();
                }}
              >
                <span className="ps-menuitem-mark" aria-hidden="true">
                  {it.on && <CheckIcon className="ps-check" />}
                </span>
                {it.label}
                <span className="ps-menuitem-kbd">{it.kbd}</span>
              </button>
            )}
          </div>
        ))
      }
    </MenuButton>
  );
});

// ---------------------------------------------------------------- output

export const DownloadButton = memo(function DownloadButton() {
  countRender('DownloadButton');
  const ready = useEditorStore(selectIsReady);
  const saving = useEditorStore((s) => s.download.state === 'saving');
  return (
    <button
      type="button"
      className="ps-btn"
      aria-label="Download PNG"
      aria-keyshortcuts="Meta+S"
      aria-busy={saving || undefined}
      data-tip="Download PNG"
      data-kbd={combo('mod+s')}
      data-testid="download-button"
      disabled={!ready}
      onClick={() => actions().download()}
    >
      {saving ? <SpinnerIcon className="ps-spin" /> : <DownloadIcon />}
    </button>
  );
});

/** Shows "Copied" with a check for a moment after each successful copy. */
function useJustCopied(): boolean {
  const at = useEditorStore((s) => (s.copy.state === 'copied' ? s.copy.at : 0));
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!at) return setOn(false);
    setOn(true);
    const t = window.setTimeout(() => setOn(false), 1600);
    return () => window.clearTimeout(t);
  }, [at]);
  return on;
}

export const CopyButton = memo(function CopyButton() {
  countRender('CopyButton');
  const ready = useEditorStore(selectIsReady);
  const copying = useEditorStore((s) => s.copy.state === 'copying');
  const copied = useJustCopied();
  return (
    <button
      type="button"
      className="ps-primary"
      aria-label="Copy image"
      aria-keyshortcuts="Meta+C"
      aria-busy={copying || undefined}
      data-state={copied ? 'copied' : copying ? 'copying' : 'idle'}
      data-tip={`Copy image. ${combo('mod+shift+c')} or Shift-click copies the full page`}
      data-testid="copy-button"
      disabled={!ready}
      // Must stay synchronous: the engine starts the clipboard write inside this handler.
      onClick={(e) => actions().copy(e.shiftKey ? 'full' : 'default')}
    >
      {copied && <CheckIcon />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
      <kbd className="ps-kbd ps-copy-kbd">{combo('mod+c')}</kbd>
    </button>
  );
});

// ---------------------------------------------------------------- bar

export function TopBar({
  meta,
  tools,
  ready,
}: {
  meta: SessionMeta | null | undefined;
  tools: boolean;
  ready: boolean;
}) {
  // Until the image is there, the controls keep their place but are inert (nothing to act on).
  const inactive = ready ? undefined : { inert: true, 'data-inactive': '' };
  return (
    <header className="ps-bar" data-testid="toolbar">
      <Identity meta={meta} />
      {tools ? (
        <div
          className="ps-group ps-bar-mid"
          role="toolbar"
          aria-label="Annotation tools"
          aria-orientation="horizontal"
          {...inactive}
        >
          <ToolGroup />
          <span className="ps-sep" aria-hidden="true" />
          <ColorWell />
          <span className="ps-sep" aria-hidden="true" />
          <SizeControl />
        </div>
      ) : (
        <span />
      )}
      {tools ? (
        <div className="ps-group ps-bar-end" {...inactive}>
          <HistoryButtons />
          <span className="ps-sep" aria-hidden="true" />
          <ZoomControl />
          <DownloadButton />
          <CopyButton />
        </div>
      ) : (
        <span />
      )}
    </header>
  );
}
