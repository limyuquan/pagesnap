import { useEffect, useState } from 'react';
import { EditorCanvas, useEditorShortcuts, useEditorStore } from '@/editor/engine';
import { parseEditorHash } from '@/shared/handoff';
import { getSettings } from '@/shared/settings';
import { Dock } from './ui/Dock';
import { CaptureNotice, ErrorState, LoadingState } from './ui/StageStates';
import { TopBar } from './ui/Toolbar';
import { TooltipLayer } from './ui/Tooltip';
import { countRender, installUiTestHook } from './ui/testHook';
import { useSessionMeta } from './ui/useSessionMeta';
import { viewPhase } from './ui/viewPhase';

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
  useEditorShortcuts();

  useEffect(() => {
    if (hashId) void init(hashId);
  }, [init, hashId]);

  const phase = viewPhase(!!sessionId, load, meta);
  const ready = phase.kind === 'ready';
  useDefaultColor(ready);

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
      <main className="ps-stage" aria-label="Capture">
        <div className="ps-canvas" data-hidden={phase.kind === 'error' || undefined}>
          <EditorCanvas />
        </div>
        {(phase.kind === 'loading' || phase.kind === 'waiting') && <LoadingState phase={phase} />}
        {phase.kind === 'error' && <ErrorState phase={phase} meta={meta} />}
        <Dock ready={ready} pageCssH={meta?.css.h ?? null} />
      </main>
      <TooltipLayer />
    </div>
  );
}

/**
 * Applies `settings.editor.defaultColor` (set on the options page) as the starting ink colour,
 * once per editor, through the public `setColor` action. Arrow is the active tool at that point,
 * so this sets the shared ink colour and leaves the highlighter's yellow alone.
 */
function useDefaultColor(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void getSettings().then((s) => {
      const color = (s.editor as { defaultColor?: string }).defaultColor;
      const { tool, styles, actions } = useEditorStore.getState();
      if (!alive || !color || tool === 'select' || tool === 'highlight') return;
      if (styles[tool].color.toLowerCase() !== color.toLowerCase()) actions.setColor(color);
    });
    return () => {
      alive = false;
    };
  }, [ready]);
}
