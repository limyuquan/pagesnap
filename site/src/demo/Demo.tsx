/**
 * The interactive demo: a browser window showing a fictional page. Click Page Snap's toolbar icon
 * (or press Alt+Shift+P) and the page is captured slice by slice, then the real editor opens in a
 * new tab with the arrow tool armed. ⌘C writes the real PNG to the clipboard.
 *
 * The demo owns the keyboard only while it's "active" (the last click or focus was inside it), so
 * Space, arrows and ⌘C keep working on the rest of the page. On touch screens a shield keeps a
 * finger on the capture from trapping the page scroll until the visitor taps into it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { setEditorKeyFilter, useEditorShortcuts, useEditorStore } from '@/editor/engine';
import { CheckIcon } from '@/editor/ui/icons';
import { combo, IS_MAC } from '@/editor/ui/keys';
import { TooltipLayer } from '@/editor/ui/Tooltip';
import { deleteSession } from '@/shared/db';
import type { SessionId } from '@/shared/types';
import { type CaptureProgress, clearDemoCaptures, pageBitmap, runCapture } from './capture';
import { DemoEditor } from './DemoEditor';
import { STEPS, type StepId, useDoneSteps } from './hints';
import { PasteCheck } from './PasteCheck';
import { ProgressPanel } from './ProgressPanel';
import { PAGE_HOST, PAGE_TITLE, PHONE_MAX_FRAME_W, pageLayout } from './page';

type Tab = 'page' | 'editor';
const ICON = `${import.meta.env.BASE_URL}icon/32.png`;
const FAVICON = `${import.meta.env.BASE_URL}demo/fernhill-favicon.svg`;

const coarse = () => matchMedia('(pointer: coarse)').matches;

export function Demo({ autoStart = false }: { autoStart?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const [frameW, setFrameW] = useState(0);
  const phone = frameW > 0 && frameW < PHONE_MAX_FRAME_W;
  const [layoutName, setLayoutName] = useState<'desktop' | 'mobile'>('desktop');
  const page = useMemo(() => pageLayout(layoutName), [layoutName]);
  const [tab, setTab] = useState<Tab>('page');
  const [hasEditor, setHasEditor] = useState(false);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const activeRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<SessionId | null>(null);
  const done = useDoneSteps(epoch);
  const copyFailed = useEditorStore((s) => s.copy.state === 'failed' && s.copy.reason === 'error');
  const capturing = progress !== null;

  // ---------------------------------------------------------------- size and page layout
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameW(el.clientWidth));
    ro.observe(el);
    setFrameW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    // The page reflows to the window it's in; a capture keeps the layout it was taken in.
    if (frameW > 0 && !capturing && !hasEditor) setLayoutName(phone ? 'mobile' : 'desktop');
  }, [frameW, phone, capturing, hasEditor]);

  // Start decoding the page early, so the first slice doesn't wait for it.
  useEffect(() => {
    void pageBitmap(page.src).catch(() => {});
    void clearDemoCaptures();
  }, [page.src]);

  // ---------------------------------------------------------------- active (keyboard, wheel)
  const setActiveBoth = useCallback((on: boolean) => {
    activeRef.current = on;
    setActive(on);
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const inside = (t: EventTarget | null) => t instanceof Node && root.contains(t);
    const onDown = (e: PointerEvent) => setActiveBoth(inside(e.target));
    const onFocus = (e: FocusEvent) => {
      if (inside(e.target)) setActiveBoth(true);
      else if (e.target !== document.body) setActiveBoth(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    // Scrolled away: the page gets its keys back.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry && entry.intersectionRatio < 0.2) setActiveBoth(false);
      },
      { threshold: [0, 0.2] },
    );
    io.observe(root);
    setEditorKeyFilter(() => activeRef.current);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus);
      io.disconnect();
      setEditorKeyFilter(null);
    };
  }, [setActiveBoth]);
  useEditorShortcuts();

  // Wheel over an inactive demo scrolls the page, not the capture.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current) e.stopPropagation();
    };
    view.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => view.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // ---------------------------------------------------------------- capture
  const startCapture = useCallback(async () => {
    if (abortRef.current) return;
    const el = pageRef.current;
    const restoreY = el?.scrollTop ?? 0;
    setTab('page');
    setError(null);
    setStopping(false);
    const ac = new AbortController();
    abortRef.current = ac;
    const scale = () => (el ? el.clientWidth / page.css.w : 1);
    try {
      const id = await runCapture({
        page,
        // The tab's visible height, in the page's CSS px.
        viewportCss: el ? (el.clientHeight * page.css.w) / Math.max(1, el.clientWidth) : 800,
        scrollTo: (y) => {
          if (el) el.scrollTop = y * scale();
        },
        onProgress: setProgress,
        signal: ac.signal,
      });
      // Like the extension: the page goes back to where you were, the editor opens next to it.
      if (el) el.scrollTop = restoreY;
      const store = useEditorStore.getState();
      store._engine._reset();
      if (sessionRef.current) void deleteSession(sessionRef.current).catch(() => {});
      sessionRef.current = id;
      setProgress(null);
      setHasEditor(true);
      setTab('editor');
      setEpoch((n) => n + 1);
      // A fresh editor: the arrow tool is armed.
      void useEditorStore.getState().actions.init(id);
    } catch (err) {
      if (el) el.scrollTop = restoreY;
      setProgress(null);
      if (!ac.signal.aborted) {
        setError(err instanceof Error ? err.message : 'The capture failed.');
      }
    } finally {
      abortRef.current = null;
      setStopping(false);
    }
  }, [page]);

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    setStopping(true);
    abortRef.current.abort(new DOMException('Stopped', 'AbortError'));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort(new DOMException('Reset', 'AbortError'));
    useEditorStore.getState()._engine._reset();
    if (sessionRef.current) void deleteSession(sessionRef.current).catch(() => {});
    sessionRef.current = null;
    setProgress(null);
    setHasEditor(false);
    setTab('page');
    setError(null);
    setEpoch((n) => n + 1);
    if (pageRef.current) pageRef.current.scrollTop = 0;
  }, []);

  // The stand-in's icon was clicked before this chunk loaded: carry on with that click.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    if (autoStart) {
      setActiveBoth(true);
      void startCapture();
    }
  }, []);

  // Esc stops a capture; Alt+Shift+P captures (the extension's shortcut), while active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (e.key === 'Escape' && abortRef.current) {
        e.preventDefault();
        stop();
        return;
      }
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyP') {
        e.preventDefault();
        void startCapture();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [startCapture, stop]);

  // ---------------------------------------------------------------- render
  const step = STEPS.find((s) => !done.has(s.id)) ?? null;
  const target = tab === 'editor' && step?.target ? page.targets[step.target] : null;
  const touch = coarse();
  const shield = touch && tab === 'editor' && !active;
  const copyKey = combo('mod+c');
  const badge = progress
    ? Math.min(99, Math.floor((progress.done / Math.max(1, progress.total)) * 100))
    : null;

  return (
    <div
      ref={rootRef}
      className="dm"
      data-testid="demo"
      data-tab={tab}
      data-layout={phone ? 'phone' : 'wide'}
      data-active={active || undefined}
      data-capturing={capturing || undefined}
    >
      <div className="dm-frame">
        <div className="dm-chrome">
          <div className="dm-tabs" role="tablist" aria-label="Browser tabs">
            <span className="dm-lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <button
              type="button"
              role="tab"
              className="dm-tab"
              aria-selected={tab === 'page'}
              onClick={() => setTab('page')}
            >
              <img src={FAVICON} alt="" width={16} height={16} />
              <span>{PAGE_TITLE}</span>
            </button>
            {hasEditor && (
              <button
                type="button"
                role="tab"
                className="dm-tab"
                aria-selected={tab === 'editor'}
                data-testid="editor-tab"
                onClick={() => setTab('editor')}
              >
                <img src={ICON} alt="" width={16} height={16} />
                <span>{PAGE_TITLE} · Page Snap</span>
              </button>
            )}
          </div>
          <div className="dm-toolbar">
            <div className="dm-omni">
              {tab === 'editor' ? (
                <>
                  <span className="dm-chip">Page Snap</span>
                  <span className="dm-url">editor.html</span>
                </>
              ) : (
                <span className="dm-url">
                  <span className="dm-url-host">{PAGE_HOST}</span>/pricing
                </span>
              )}
            </div>
            {!hasEditor && !capturing && (
              <span className="dm-cue" aria-hidden="true">
                Capture this page <span>→</span>
              </span>
            )}
            <button
              type="button"
              className="dm-ext"
              data-testid="demo-icon"
              aria-label={`Page Snap: capture full page (${IS_MAC ? '⌥⇧P' : 'Alt+Shift+P'})`}
              aria-expanded={capturing}
              data-tip="Capture full page"
              data-kbd={IS_MAC ? '⌥⇧P' : 'Alt+Shift+P'}
              data-pulse={(!hasEditor && !capturing) || undefined}
              onClick={() => (capturing ? stop() : void startCapture())}
            >
              <img src={ICON} alt="" width={18} height={18} />
              {badge !== null && <span className="dm-badge tnum">{badge}%</span>}
            </button>
          </div>
        </div>

        <div className="dm-view" ref={viewRef}>
          <section
            className="dm-page"
            ref={pageRef}
            hidden={tab !== 'page'}
            data-testid="demo-page"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the fake page scrolls by keyboard too
            tabIndex={0}
            aria-label="A fictional pricing page"
            // The top of the page paints at once; the full image lands over it.
            style={{ backgroundImage: `url("${page.poster}")` }}
          >
            <img
              src={page.src}
              alt="Plans and pricing for Fernhill, a fictional notes app: three plans, a comparison table, a changelog and questions."
              width={page.css.w}
              height={page.css.h}
              decoding="sync"
              draggable={false}
            />
          </section>
          {hasEditor && tab === 'editor' && <DemoEditor compact={phone} target={target} />}
          {progress && (
            <div className="dm-pop">
              <ProgressPanel progress={progress} page={page} stopping={stopping} onStop={stop} />
            </div>
          )}
          {shield && (
            <button
              type="button"
              className="dm-shield"
              onClick={() => setActiveBoth(true)}
              data-testid="demo-shield"
            >
              <span>Tap to draw</span>
            </button>
          )}
        </div>
      </div>

      <div className="dm-under">
        <p className="dm-hint" aria-live="polite" data-testid="demo-hint">
          {error
            ? error
            : copyFailed
              ? 'This browser can’t put images on the clipboard. Use Download instead.'
              : !hasEditor
                ? capturing
                  ? 'Capturing the whole page, one screen at a time.'
                  : `${touch ? 'Tap' : 'Click'} the Page Snap icon in the toolbar${touch ? '' : ' or press Alt+Shift+P'}.`
                : step
                  ? (touch ? step.touch : step.text).replace('⌘C', copyKey)
                  : 'That’s the whole loop. Keep drawing, or start over.'}
        </p>
        <ul className="dm-steps" aria-label="Things to try">
          {STEPS.map((s) => (
            <StepChip
              key={s.id}
              id={s.id}
              label={s.label}
              k={s.key}
              done={done.has(s.id)}
              next={hasEditor && step?.id === s.id}
            />
          ))}
        </ul>
        <button type="button" className="dm-reset" onClick={reset} data-testid="demo-reset">
          Start over
        </button>
      </div>
      <PasteCheck />
      <TooltipLayer />
    </div>
  );
}

function StepChip({
  id,
  label,
  k,
  done,
  next,
}: {
  id: StepId;
  label: string;
  k: string;
  done: boolean;
  next: boolean;
}) {
  const key = id === 'copy' ? combo('mod+c') : k;
  return (
    <li
      className="dm-step"
      data-done={done || undefined}
      data-next={next || undefined}
      data-step={id}
    >
      {done ? <CheckIcon className="dm-step-check" /> : key && <kbd>{key}</kbd>}
      <span>{label}</span>
      <span className="sr-only">{done ? ', done' : ''}</span>
    </li>
  );
}
