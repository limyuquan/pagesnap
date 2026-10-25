/**
 * e2e-only UI hook (owner: C): `window.__pagesnapUi` lets Playwright read the editor store and put
 * it into states that are hard to reach for real (a smart-region copy, a failed download), so the
 * UI tests don't depend on clipboard permissions or engine timing. Tree-shaken out of production
 * builds (`IS_E2E` is a compile-time constant). Product code never writes the store directly.
 */
import { type EditorState, useEditorStore } from '@/editor/engine';
import { IS_E2E } from '@/shared/e2e';

export interface UiTestHook {
  getState(): Omit<EditorState, 'actions' | 'source'>;
  setState(patch: Partial<EditorState>): void;
  /** Render counts per chrome component (perf test: pans and pointer moves must not re-render). */
  renders: Record<string, number>;
}

const renders: Record<string, number> = {};

/** Counts renders in e2e builds; compiles to nothing elsewhere. */
export function countRender(name: string): void {
  if (IS_E2E) renders[name] = (renders[name] ?? 0) + 1;
}

declare global {
  interface Window {
    __pagesnapUi?: UiTestHook;
  }
}

export function installUiTestHook(): void {
  if (!IS_E2E) return;
  window.__pagesnapUi = {
    getState: () => {
      const { actions: _a, source: _s, ...rest } = useEditorStore.getState();
      return rest;
    },
    setState: (patch) => useEditorStore.setState(patch),
    renders,
  };
}
