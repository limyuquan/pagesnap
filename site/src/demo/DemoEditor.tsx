/**
 * The editor inside the demo's browser frame. Everything here is the extension's own editor:
 * the engine's canvas and store (`@/editor/engine`) and the UI's toolbar controls, dock and
 * tooltips (`@/editor/ui/*`). Only the arrangement differs: the full top bar on wide frames, and a
 * two-row touch-sized bar on phones.
 */
import { useEffect, useMemo, useRef } from 'react';
import { EditorCanvas, useEditorStore } from '@/editor/engine';
import { Dock, dismissHint } from '@/editor/ui/Dock';
import {
  ColorWell,
  CopyButton,
  DownloadButton,
  HistoryButtons,
  SizeControl,
  ToolGroup,
  TopBar,
} from '@/editor/ui/Toolbar';
import type { SessionMeta } from '@/editor/ui/useSessionMeta';
import type { Box } from './page';

function CompactBar() {
  return (
    <header className="dm-cbar" data-testid="toolbar">
      <div className="dm-cbar-row" role="toolbar" aria-label="Annotation tools">
        <ToolGroup />
        <ColorWell />
      </div>
      <div className="dm-cbar-row">
        <HistoryButtons />
        <SizeControl />
        <span className="dm-cbar-gap" />
        <DownloadButton />
        <CopyButton />
      </div>
    </header>
  );
}

/** A soft ring around the thing the current hint is about, following the camera. */
function TargetRing({ box }: { box: Box | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !box) return;
    const place = () => {
      const s = useEditorStore.getState();
      const dpr = s.session?.dpr ?? 1;
      const z = s.camera.zoom;
      const pad = 8;
      const x = (box.x * dpr - s.camera.x) * z - pad;
      const y = (box.y * dpr - s.camera.y) * z - pad;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.width = `${(box.w * dpr * z + pad * 2).toFixed(1)}px`;
      el.style.height = `${(box.h * dpr * z + pad * 2).toFixed(1)}px`;
    };
    place();
    return useEditorStore.subscribe((s, p) => {
      if (s.camera !== p.camera || s.session !== p.session || s.viewport !== p.viewport) place();
    });
  }, [box]);
  if (!box) return null;
  return <div ref={ref} className="dm-ring" aria-hidden="true" />;
}

export function DemoEditor({ compact, target }: { compact: boolean; target: Box | null }) {
  const session = useEditorStore((s) => s.session);
  const ready = useEditorStore((s) => s.load.phase === 'ready');
  const meta = useMemo<SessionMeta | null>(
    // No URL: the fictional page has nowhere to link to.
    () => (session ? { ...session, url: '' } : null),
    [session],
  );
  return (
    <div className="dm-ed" data-testid="editor-root" data-phase={ready ? 'ready' : 'loading'}>
      {compact ? <CompactBar /> : <TopBar meta={meta} tools ready={ready} />}
      <main
        className="ps-stage"
        aria-label="Capture"
        aria-keyshortcuts="ArrowUp ArrowDown PageUp PageDown Space Home End"
        tabIndex={ready ? 0 : -1}
      >
        <div className="ps-canvas" onPointerDownCapture={dismissHint}>
          <EditorCanvas />
        </div>
        {ready && <TargetRing box={target} />}
        <Dock ready={ready} page={session?.css ?? null} />
      </main>
    </div>
  );
}
