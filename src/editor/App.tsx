import { useEffect, useState } from 'react';
import { EditorCanvas, useEditorShortcuts, useEditorStore } from '@/editor/engine';
import { parseEditorHash } from '@/shared/handoff';
import { Dock, dismissHint } from './ui/Dock';
import { CaptureNotice, ErrorState, LoadingState } from './ui/StageStates';
import { useCaptureStalled, useOpenTimedOut } from './ui/stuck';
import { TopBar } from './ui/Toolbar';
import { TooltipLayer } from './ui/Tooltip';
import { countRender, installUiTestHook } from './ui/testHook';
import { useSessionMeta } from './ui/useSessionMeta';
import { type ViewPhase, viewPhase } from './ui/viewPhase';

installUiTestHook();

/**
 * Editor shell (owner: C). One top bar, an optional notice strip, and the stage: the engine's
 * canvas with the loading / error states and the hint / toast dock layered over it.
 *
 * Contract kept by C: the root element has `data-testid="editor-root"` and
 * `data-session="<sessionId>"` (e2e tests rely on both).
 */
export function App() {
  countRender('App');
  const [hashId] = useState(() => parseEditorHash(window.location.hash));
  const sessionId = useEditorStore((s) => s.sessionId) ?? hashId;
  const load = useEditorStore((s) => s.load);
  const init = useEditorStore((s) => s.actions.init);
  const meta = useSessionMeta(sessionId);
  const [stageKeys, setStageKeys] = useState(false);
  useEditorShortcuts();

  useEffect(() => {
    if (hashId) void init(hashId);
  }, [init, hashId]);

  const raw = viewPhase(!!sessionId, load, meta);
  const stalled = useCaptureStalled(raw.kind === 'waiting', meta?.updatedAt);
  const openTimedOut = useOpenTimedOut(raw.kind === 'loading');
  const phase: ViewPhase = openTimedOut
    ? {
        kind: 'error',
        code: 'LOAD_FAILED',
        message: 'It took too long to open. Reloading the tab usually fixes it.',
        captureCode: null,
      }
    : raw;
  const ready = phase.kind === 'ready';

  useEffect(() => {
    const t = meta?.title?.trim();
    document.title = t ? `${t} · Page Snap` : 'Page Snap';
  }, [meta?.title]);

  return (
    <div
      data-testid="editor-root"
      data-session={sessionId ?? ''}
      data-phase={phase.kind}
      className="ps-shell"
    >
      <TopBar meta={meta} tools={phase.kind !== 'error'} ready={ready} />
      {ready ? <CaptureNotice meta={meta} /> : <div />}
      {/*
       * The stage is one tab stop after the toolbar, so keyboard users can land on the capture
       * and scroll it (the engine's arrow / page / Space / Home / End keys are left alone while a
       * toolbar button has focus). Keyboard focus shows the keys in the dock.
       */}
      <main
        className="ps-stage"
        aria-label="Capture"
        aria-keyshortcuts="ArrowUp ArrowDown PageUp PageDown Space Home End"
        tabIndex={ready ? 0 : -1}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setStageKeys(e.currentTarget.matches(':focus-visible'));
        }}
        onBlur={(e) => {
          if (e.target === e.currentTarget) setStageKeys(false);
        }}
      >
        <div
          className="ps-canvas"
          data-hidden={phase.kind === 'error' || undefined}
          onPointerDownCapture={dismissHint}
        >
          <EditorCanvas />
        </div>
        {(phase.kind === 'loading' || phase.kind === 'waiting') && (
          <LoadingState phase={phase} stalled={stalled} />
        )}
        {phase.kind === 'error' && <ErrorState phase={phase} meta={meta} />}
        <Dock ready={ready} page={meta?.css ?? null} keys={stageKeys} />
      </main>
      <TooltipLayer />
    </div>
  );
}
