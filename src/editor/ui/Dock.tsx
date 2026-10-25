/**
 * Bottom-centre slot over the canvas: the first-open hint ("Draw on the page, ⌘C to copy") and the
 * copy / download status toast. They share one place so they never stack; the toast wins.
 *
 * The toast says exactly what went to the clipboard (full page, the area around the marks, or the
 * current view) with its pixel size, because Cmd+C on a tall page doesn't copy everything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CopyStatus, type DownloadStatus, useEditorStore } from '@/editor/engine';
import { CheckIcon, NoticeIcon, SpinnerIcon } from './icons';
import { combo } from './keys';
import { copyToast, downloadToast, type ToastContent } from './messages';
import { countRender } from './testHook';

const BUSY_DELAY_MS = 160;
const LINGER_MS = { ok: 3200, okWithNote: 5200, warn: 5600 } as const;

function statusKey(s: CopyStatus | DownloadStatus): string {
  return 'at' in s ? `${s.state}:${s.at}` : s.state;
}

function useToast(pageCssH: number | null) {
  const copy = useEditorStore((s) => s.copy);
  const download = useEditorStore((s) => s.download);
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
    const content = changed === 'copy' ? copyToast(copy, pageCssH) : downloadToast(download);
    if (!content) return;
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
  }, [copy, download, pageCssH, schedule]);

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
  return <CheckIcon className="ps-toast-icon" />;
}

export function Dock({ ready, pageCssH }: { ready: boolean; pageCssH: number | null }) {
  countRender('Dock');
  const { shown, open, hover } = useToast(pageCssH);
  const hasShapes = useEditorStore((s) => (s.doc ? s.doc.shapes.length > 0 : false));
  const docLoaded = useEditorStore((s) => s.doc != null);
  // The hint is for a fresh capture only: once anything is drawn it's gone for good.
  const [drew, setDrew] = useState(false);
  useEffect(() => {
    if (hasShapes) setDrew(true);
  }, [hasShapes]);
  const hintVisible = ready && docLoaded && !hasShapes && !drew && !open;
  const c = shown?.content;

  return (
    <div className="ps-dock">
      {ready && !drew && (
        <div
          className="ps-hint"
          data-testid="empty-hint"
          data-hidden={!hintVisible || undefined}
          aria-hidden={!hintVisible}
        >
          <span>Draw on the page</span>
          <span className="ps-hint-sep" aria-hidden="true" />
          <span>
            <kbd>{combo('mod+c')}</kbd> to copy
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
