/**
 * Bottom-centre slot over the canvas: the first-open hint ("Drag to draw an arrow · ⌘C copies",
 * following the active tool) and the copy / download status toast. They share one place so they
 * never stack; the toast wins.
 *
 * The toast says exactly what went to the clipboard (full page, the area around the marks, or the
 * current view) with its pixel size, because Cmd+C on a tall page doesn't copy everything.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type CopyStatus, type DownloadStatus, type Tool, useEditorStore } from '@/editor/engine';
import { CheckIcon, InfoIcon, NoticeIcon, SpinnerIcon } from './icons';
import { combo } from './keys';
import { copyToast, downloadToast, type PageCss, type ToastContent } from './messages';
import { countRender } from './testHook';

const BUSY_DELAY_MS = 160;
const LINGER_MS = { ok: 3200, okWithNote: 5200, warn: 5600 } as const;

function statusKey(s: CopyStatus | DownloadStatus): string {
  return 'at' in s ? `${s.state}:${s.at}` : s.state;
}

/** Set by the engine when this tab adopted a doc edited in another tab (CONTRACTS §8, F2). */
const selectExternalEditAt = (s: object) =>
  (s as { externalEditAt?: number | null }).externalEditAt ?? 0;

function useToast(page: PageCss) {
  const copy = useEditorStore((s) => s.copy);
  const download = useEditorStore((s) => s.download);
  const externalAt = useEditorStore(selectExternalEditAt);
  const [shown, setShown] = useState<{ key: string; content: ToastContent } | null>(null);
  const [open, setOpen] = useState(false);
  const hideTimer = useRef(0);
  const pausedRef = useRef(false);
  const lingerRef = useRef(0);
  const last = useRef({ copy: statusKey(copy), download: statusKey(download) });

  const schedule = useCallback((ms: number) => {
    window.clearTimeout(hideTimer.current);
    lingerRef.current = ms;
    if (ms > 0 && !pausedRef.current)
      hideTimer.current = window.setTimeout(() => setOpen(false), ms);
  }, []);

  // React to whichever status changed most recently.
  useEffect(() => {
    const keys = { copy: statusKey(copy), download: statusKey(download) };
    const changed =
      keys.copy !== last.current.copy
        ? 'copy'
        : keys.download !== last.current.download
          ? 'download'
          : null;
    last.current = keys;
    if (!changed) return;
    const content = changed === 'copy' ? copyToast(copy, page) : downloadToast(download);
    if (!content) {
      // Back to idle (dismissed): the toast goes too.
      window.clearTimeout(hideTimer.current);
      setOpen(false);
      return;
    }
    const key = `${changed}:${keys[changed]}`;
    if (content.tone === 'busy') {
      // Most copies finish in a few ms; don't flash a "Copying" toast for those.
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        setShown({ key, content });
        setOpen(true);
      }, BUSY_DELAY_MS);
      return;
    }
    setShown({ key, content });
    setOpen(true);
    schedule(
      content.tone === 'warn' ? LINGER_MS.warn : content.note ? LINGER_MS.okWithNote : LINGER_MS.ok,
    );
  }, [copy, download, page, schedule]);

  // Another tab of the same capture saved newer marks, and this tab took them.
  useEffect(() => {
    if (!externalAt) return;
    setShown({
      key: `external:${externalAt}`,
      content: { tone: 'info', title: 'Updated from another tab', note: 'Undo starts over here.' },
    });
    setOpen(true);
    schedule(LINGER_MS.okWithNote);
  }, [externalAt, schedule]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const hover = (on: boolean) => {
    pausedRef.current = on;
    if (on) window.clearTimeout(hideTimer.current);
    else if (open) schedule(Math.min(lingerRef.current, 1800));
  };

  return { shown, open, hover };
}

function ToastIcon({ tone }: { tone: ToastContent['tone'] }) {
  if (tone === 'busy') return <SpinnerIcon className="ps-toast-icon ps-spin" />;
  if (tone === 'warn') return <NoticeIcon className="ps-toast-icon" data-tone="warn" />;
  if (tone === 'info') return <InfoIcon className="ps-toast-icon" />;
  return <CheckIcon className="ps-toast-icon" />;
}

// ---------------------------------------------------------------- first-open hint

const HINTS: Record<Tool, string> = {
  select: 'Pick a tool to draw',
  arrow: 'Drag to draw an arrow',
  rect: 'Drag to draw a rectangle',
  underline: 'Drag under text to underline it',
  highlight: 'Drag across text to highlight it',
  pen: 'Drag to draw freehand',
  text: 'Click to add text',
};
/** The hint steps aside after this long without a tool change. */
const HINT_IDLE_MS = 8000;

/** Pointer down on the canvas: the user has found it, so the hint goes (until the tool changes). */
let hintDismissals = 0;
const hintListeners = new Set<() => void>();
export function dismissHint(): void {
  hintDismissals++;
  for (const l of hintListeners) l();
}
const subscribeHint = (l: () => void) => {
  hintListeners.add(l);
  return () => hintListeners.delete(l);
};
const hintSnapshot = () => hintDismissals;

function useHint(ready: boolean, toastOpen: boolean) {
  const tool = useEditorStore((s) => s.tool);
  const hasShapes = useEditorStore((s) => (s.doc ? s.doc.shapes.length > 0 : false));
  const docLoaded = useEditorStore((s) => s.doc != null);
  const dismissals = useSyncExternalStore(subscribeHint, hintSnapshot);
  // Once anything is drawn the hint is gone for good (undo back to empty doesn't bring it back).
  const [drew, setDrew] = useState(false);
  useEffect(() => {
    if (hasShapes) setDrew(true);
  }, [hasShapes]);
  // Pointer down or 8 s idle hide it; a tool change shows it again with the new wording.
  const [quiet, setQuiet] = useState(false);
  const seen = useRef(dismissals);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts on every tool change, by design
  useEffect(() => {
    setQuiet(false);
    const t = window.setTimeout(() => setQuiet(true), HINT_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [tool]);
  useEffect(() => {
    if (dismissals !== seen.current) {
      seen.current = dismissals;
      setQuiet(true);
    }
  }, [dismissals]);
  const mounted = ready && !drew;
  const visible = mounted && docLoaded && !hasShapes && !quiet && !toastOpen;
  return { mounted, visible, text: HINTS[tool] };
}

// ---------------------------------------------------------------- dock

export function Dock({
  ready,
  page,
  keys = false,
}: {
  ready: boolean;
  page: PageCss;
  /** The stage has keyboard focus: show how to move around instead of the first-open hint. */
  keys?: boolean;
}) {
  countRender('Dock');
  const { shown, open, hover } = useToast(page);
  const hint = useHint(ready, open || keys);
  const c = shown?.content;

  return (
    <div className="ps-dock">
      {hint.mounted && (
        <div
          className="ps-hint"
          data-testid="empty-hint"
          data-hidden={!hint.visible || undefined}
          aria-hidden={!hint.visible}
        >
          <span data-testid="hint-text">{hint.text}</span>
          <span className="ps-hint-sep" aria-hidden="true" />
          <span>
            <kbd>{combo('mod+c')}</kbd> copies
          </span>
        </div>
      )}
      {ready && (
        <div
          className="ps-hint"
          data-testid="keys-hint"
          data-hidden={!keys || open || undefined}
          aria-hidden={!keys || open}
        >
          <span>
            <kbd>↑ ↓</kbd> scroll
          </span>
          <span className="ps-hint-sep" aria-hidden="true" />
          <span>
            <kbd>Space</kbd> next screen
          </span>
          <span className="ps-hint-sep" aria-hidden="true" />
          <span>
            <kbd>Home</kbd> <kbd>End</kbd> top, bottom
          </span>
        </div>
      )}
      <div
        className="ps-toast"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="toast"
        data-tone={c?.tone}
        data-hidden={!open || undefined}
        onPointerEnter={() => hover(true)}
        onPointerLeave={() => hover(false)}
      >
        {c && (
          <>
            <ToastIcon tone={c.tone} />
            <div className="ps-toast-body">
              <div className="ps-toast-title">
                <span data-testid="toast-title">{c.title}</span>
                {c.size && (
                  <span className="ps-dim" data-testid="toast-size">
                    {c.size}
                  </span>
                )}
              </div>
              {c.note && <div className="ps-toast-note">{c.note}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
