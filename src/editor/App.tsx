import { useEffect } from 'react';
import { EditorCanvas, useEditorShortcuts, useEditorStore } from '@/editor/engine';
import { parseEditorHash } from '@/shared/handoff';

/**
 * Editor shell (owner: C). PHASE-0 placeholder.
 *
 * Contract kept by C: the root element has `data-testid="editor-root"` and
 * `data-session="<sessionId>"` (e2e tests rely on both).
 */
export function App() {
  const sessionId = useEditorStore((s) => s.sessionId);
  const load = useEditorStore((s) => s.load);
  const init = useEditorStore((s) => s.actions.init);
  useEditorShortcuts();

  useEffect(() => {
    const id = parseEditorHash(window.location.hash);
    if (id) void init(id);
  }, [init]);

  return (
    <div data-testid="editor-root" data-session={sessionId ?? ''} className="flex h-full flex-col">
      <header className="flex h-12 items-center px-4 text-sm text-ink">
        Page Snap <span className="ml-3 opacity-50">{load.phase}</span>
      </header>
      <main className="relative min-h-0 flex-1">
        <EditorCanvas />
      </main>
    </div>
  );
}
