/**
 * The editor's single top bar: page identity on the left, tools / colour / size in the centre,
 * history / zoom / download / copy on the right.
 *
 * Performance: every control subscribes to the smallest slice of the store it needs and returns
 * primitives, so pointer moves and camera pans don't re-render the bar. Only the zoom label
 * re-renders on zoom changes, and only the two affected tool buttons re-render on a tool switch.
 */
import { memo, useEffect, useState } from 'react';
import {
  type EditorState,
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
      title={meta.url}
      aria-label={`${title}, open the original page`}
    >
      {body}
    </a>
  ) : (
    <span className="ps-ident" title={meta.url}>
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

function selectedShapes(s: EditorState): Shape[] {
  if (!s.doc || s.selection.length === 0) return [];
  const ids = new Set(s.selection);
  return s.doc.shapes.filter((sh) => ids.has(sh.id));
}

/** Colour of the active tool, or the shared colour of the selection, or `null`. */
const selectActiveColor = (s: EditorState): string | null => {
  if (s.tool !== 'select') return s.styles[s.tool].color;
  const shapes = selectedShapes(s);
  const first = shapes[0]?.color;
  return first && shapes.every((sh) => sh.color === first) ? first : null;
};

const selectStyleEnabled = (s: EditorState) => s.tool !== 'select' || s.selection.length > 0;

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

const selectSizeKind = (s: EditorState): ShapeKind | null =>
  s.tool !== 'select' ? s.tool : (selectedShapes(s)[0]?.kind ?? null);

const selectSize = (s: EditorState): number | null => {
  if (s.tool !== 'select') return s.styles[s.tool].size;
  const first = selectedShapes(s)[0];
  if (!first || !s.doc) return null;
  return Math.round(shapeSizeImagePx(first) / (s.doc.image.dpr || 1));
};

export const ColorSwatches = memo(function ColorSwatches() {
  countRender('ColorSwatches');
  const active = useEditorStore(selectActiveColor);
  const enabled = useEditorStore(selectStyleEnabled);
  return (
    <div
      className="ps-swatches"
      role="radiogroup"
      aria-label="Colour"
      aria-disabled={!enabled || undefined}
    >
      {PALETTE.map((c, i) => {
        const checked = active?.toLowerCase() === c.toLowerCase();
        return (
          // biome-ignore lint/a11y/useSemanticElements: a button with role="radio" is the ARIA radio-group pattern; native inputs can't render swatches
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={COLOR_NAMES[i]}
            aria-keyshortcuts={String(i + 1)}
            className="ps-swatch"
            data-light={c.toUpperCase() === '#FFFFFF' || undefined}
            data-color={c}
            data-tip={COLOR_NAMES[i]}
            data-kbd={String(i + 1)}
            tabIndex={checked || (!active && i === 0) ? 0 : -1}
            disabled={!enabled}
            style={{ '--sw': c } as React.CSSProperties}
            onClick={() => actions().setColorIndex(i)}
            onKeyDown={(e) => {
              const dir =
                e.key === 'ArrowRight' || e.key === 'ArrowDown'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (!dir) return;
              e.preventDefault();
              e.stopPropagation();
              const n = (i + dir + PALETTE.length) % PALETTE.length;
              actions().setColorIndex(n);
              const sib = e.currentTarget.parentElement?.children[n];
              if (sib instanceof HTMLElement) sib.focus();
            }}
          />
        );
      })}
    </div>
  );
});

/** Dot diameter for a size, by its rank in the tool's steps, so every tool previews alike. */
function dotFor(kind: ShapeKind, size: number): number {
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
  return 3 + (rank / Math.max(1, steps.length - 1)) * 9;
}

function SizeDot({ d }: { d: number }) {
  return (
    <span className="inline-grid h-4 w-4 place-items-center" aria-hidden="true">
      <span className="rounded-full bg-current" style={{ width: d, height: d }} />
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

export const SizeControl = memo(function SizeControl() {
  countRender('SizeControl');
  const kind = useEditorStore(selectSizeKind);
  const size = useEditorStore(selectSize);
  const enabled = kind != null && size != null;
  const k = kind ?? 'arrow';
  const steps = SIZE_STEPS_CSS[k];
  return (
    <MenuButton
      label={`${SIZE_TIPS[k]}${size != null ? `, ${size} px` : ''}`}
      tip={SIZE_TIPS[k]}
      kbd="[ ]"
      disabled={!enabled}
      testId="size-button"
      button={
        <>
          <SizeDot d={dotFor(k, size ?? steps[3] ?? 6)} />
          <span className="tnum w-[2ch] text-left" data-testid="size-value">
            {size ?? ''}
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
            <SizeDot d={dotFor(k, n)} />
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

export const ZoomControl = memo(function ZoomControl() {
  countRender('ZoomControl');
  const pct = useEditorStore(selectZoomPercent);
  const ready = useEditorStore(selectIsReady);
  const items: { label: string; kbd: string; run: () => void }[] = [
    { label: 'Zoom in', kbd: combo('mod+='), run: () => actions().zoomBy(1.25) },
    { label: 'Zoom out', kbd: combo('mod+-'), run: () => actions().zoomBy(0.8) },
    { label: 'Fit width', kbd: combo('mod+0'), run: () => actions().fitWidth() },
    { label: 'Actual size', kbd: combo('mod+1'), run: () => actions().zoomActual() },
  ];
  return (
    <MenuButton
      label={`Zoom, ${pct}%`}
      tip="Zoom"
      disabled={!ready}
      align="end"
      testId="zoom-button"
      button={
        <span
          className="tnum min-w-[4ch] text-right"
          data-testid="zoom-value"
          style={ready ? undefined : { visibility: 'hidden' }}
        >
          {pct}%
        </span>
      }
    >
      {(close) =>
        items.map((it, i) => (
          <div key={it.label}>
            {i === 2 && <div className="ps-menu-sep" />}
            <button
              type="button"
              role="menuitem"
              className="ps-menuitem"
              onClick={() => {
                it.run();
                close();
              }}
            >
              {it.label}
              <span className="ps-menuitem-kbd">{it.kbd}</span>
            </button>
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
      <kbd className="ps-kbd">{combo('mod+c')}</kbd>
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
          className="ps-group"
          role="toolbar"
          aria-label="Annotation tools"
          aria-orientation="horizontal"
          {...inactive}
        >
          <ToolGroup />
          <span className="ps-sep" aria-hidden="true" />
          <ColorSwatches />
          <span className="ps-sep" aria-hidden="true" />
          <SizeControl />
        </div>
      ) : (
        <span />
      )}
      {tools ? (
        <div className="ps-group justify-self-end" {...inactive}>
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
