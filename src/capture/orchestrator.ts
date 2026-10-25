/**
 * Capture orchestrator (owner: A). Runs in the service worker.
 *
 * PHASE-0 STUB: the signature is the contract the background entrypoint and the e2e hook use.
 */
import type { Browser } from 'wxt/browser';
import type { SessionId } from '@/shared/types';

/**
 * Capture `tab` as a full page: inject the agent, scroll and capture slices into IndexedDB,
 * then open the editor (`editorUrl(id)`) next to the tab. Resolves with the session id once the
 * session is final and the editor is open. Only one capture runs at a time; a second call while
 * one is running resolves with the running session's id.
 */
export async function startCapture(tab: Browser.tabs.Tab): Promise<SessionId> {
  throw new Error(`startCapture not implemented yet (tab ${tab.id ?? '?'})`);
}
