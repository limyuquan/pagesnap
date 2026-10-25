/**
 * Test-only hooks, present only in e2e builds (`import.meta.env.MODE === 'e2e'`). Production
 * builds tree-shake them away. Playwright reaches them through `serviceWorker.evaluate` and
 * `page.evaluate`.
 */
import type { SyntheticOptions } from './testing/synthetic';
import type { SessionId } from './types';

/** True in `pnpm build:e2e` builds only. */
export const IS_E2E = import.meta.env.MODE === 'e2e';

/** On the service worker global as `__pagesnap` (owner: A; Phase 0 wires the stub). */
export interface BackgroundTestHook {
  /**
   * Start a full-page capture of `tabId` without a user gesture (the e2e manifest grants
   * localhost host permissions). Resolves with the session id once the session is final and the
   * editor tab has been opened.
   */
  startCapture(tabId: number): Promise<SessionId>;
  /**
   * Exactly what the toolbar click (or Alt+Shift+P) does for `tabId` once its popup opens, minus
   * the popup: start a capture, or join the running one (it never cancels; Esc or Stop in the
   * popup do). Resolves with the session id once the editor is open (at once when joining), or
   * `null` if the request was dropped (queued behind another tab and replaced, or failed).
   */
  clickAction(tabId: number): Promise<SessionId | null>;
  /** Store a synthetic `ready` session (see `shared/testing/synthetic.ts`). */
  seedSyntheticSession(opts?: SyntheticOptions): Promise<SessionId>;
}

/** On the editor window as `__pagesnapTest` (owner: B). */
export interface EditorTestHook {
  /** True once the session is loaded and the first frame is drawn. */
  isReady(): boolean;
  /** Export like Cmd+C (`default`) or Shift+Cmd+C (`full`), at native resolution. Base64 PNG. */
  exportPng(scope: 'default' | 'full'): Promise<string>;
}

declare global {
  var __pagesnap: BackgroundTestHook | undefined;
  interface Window {
    __pagesnapTest?: EditorTestHook;
  }
}
