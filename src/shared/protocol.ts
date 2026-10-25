/**
 * Message protocol between the service worker (orchestrator) and the page agent, plus the storage
 * keys used for the SW → editor hand-off. Types and constants only (safe to import anywhere).
 * Runtime helpers for the hand-off are in `handoff.ts`.
 *
 * ## SW ↔ agent (both owned by A)
 *
 * 1. The SW injects `/agent.js` with `scripting.executeScript({ target: { tabId }, files: [AGENT_SCRIPT_PATH] })`
 *    into the main frame, ISOLATED world. A failure there means the page is restricted
 *    (`RESTRICTED` → visible-area fallback).
 * 2. The agent guards against double injection (`window[AGENT_GUARD]`) and opens
 *    `browser.runtime.connect({ name: AGENT_PORT_NAME })`. The SW identifies the tab by `port.sender.tab.id`.
 *    The open port keeps the SW alive (Chrome 114+).
 * 3. The SW sends `ToAgent` requests one at a time. Each request carries an `id`; the agent answers
 *    each with exactly one `FromAgent` reply carrying `re: id` (or an `error`).
 * 4. Planning lives in the agent (only it sees height changes and header jumps), so the SW says
 *    `step` and the agent answers with where it actually scrolled to, or `done`.
 * 5. Restore: on `restore`, on `port.onDisconnect` (SW died), on Esc and on `pagehide` the agent
 *    undoes every page mutation. Restore must be idempotent.
 *
 * The agent never draws anything into the page (anything visible would end up in the screenshot).
 * Progress is shown on the toolbar badge by the SW.
 */
import type { CaptureMode, SessionId, TargetGeometry } from './types';

/** `runtime.connect` port name used by the agent. */
export const AGENT_PORT_NAME = 'pagesnap/agent';

/** Path of the injected agent bundle (WXT unlisted script `src/entrypoints/agent.ts`). */
export const AGENT_SCRIPT_PATH = '/agent.js';

/** `window` property the agent sets to detect double injection. */
export const AGENT_GUARD = '__pagesnapAgent';

/** Options for one capture, resolved from settings by the SW and sent with `prepare`. */
export interface CaptureOptions {
  mode: CaptureMode;
  /** Stop after this many CSS px of content (session gets a `TRUNCATED` warning). */
  maxCssHeight: number;
  /** Pre-scroll to trigger lazy loaders. `auto` = pages taller than 3 viewports, ~3 s budget. */
  preScroll: 'auto' | 'on' | 'off';
  /** Fixed/sticky handling: `smart` = top floats in first slice only, bottom floats in last only. */
  floating: 'smart' | 'remove' | 'keep';
  /** Scroll target: `auto` picks the best inner scroller or the document; `page` forces the document. */
  target: 'auto' | 'page';
  /** Extra settle delay after each scroll, ms. */
  settleMs: number;
}

/** SW → agent. */
export type ToAgent =
  | { id: number; t: 'prepare'; session: SessionId; opts: CaptureOptions }
  /** Scroll to the next planned position, settle, and report. */
  | { id: number; t: 'step' }
  /**
   * The page was hidden and is visible again: let it repaint at the current position, then report
   * (`settled`). Nothing is scrolled.
   */
  | { id: number; t: 'settle' }
  /** Undo every page mutation and scroll back to where the user was. */
  | { id: number; t: 'restore' };

export type AgentErrorCode =
  | 'NO_SCROLL'
  | 'SCROLL_JACKED'
  | 'PINCH_ZOOM'
  | 'ABORTED_BY_USER'
  /** The agent's session was restored (Esc, hide, disconnect) while the request ran. */
  | 'ABORTED'
  /** The page's URL changed (SPA route change) since `prepare`. */
  | 'NAVIGATED'
  | 'INTERNAL';

/** Per-slice observations the SW turns into session warnings. */
export interface SliceNotes {
  /** The page grew past `maxCssHeight` (or the slice cap): the output stops at the limit. */
  truncated?: boolean;
  /** Content moved in a way the agent couldn't re-anchor: this seam may be misaligned. */
  misaligned?: boolean;
  /** Images in view still loading when the wait gave up. */
  imagesPending?: number;
}

/** Agent → SW. Every reply echoes the request id in `re`. */
export type FromAgent =
  | {
      re: number;
      t: 'prepared';
      /** Visible viewport, CSS px, measured after the capture stylesheet hid scrollbars. */
      viewport: { w: number; h: number };
      target: TargetGeometry;
      /** Planned number of slices (may change if the page grows). */
      estSlices: number;
      warnings: string[];
      /** `window.devicePixelRatio` (includes browser zoom), to snap the measured scale. */
      dpr: number;
    }
  | {
      re: number;
      t: 'positioned';
      /** Index of the slice the SW should take now. */
      i: number;
      /** Actual scroll offsets of the target, CSS px (read back after settling). */
      scrollX: number;
      scrollY: number;
      /** Where the slice goes in the output (see `SliceMeta.place`). */
      place: { x: number; y: number };
      last: boolean;
      target: TargetGeometry;
      /** `document.visibilityState === 'visible'` when the reply was sent. */
      visible: boolean;
      notes: SliceNotes;
      /**
       * Replace slice `i` with this one: the page moved while slice `i` was being shot, so that
       * screenshot may show either state.
       */
      retake?: boolean;
    }
  | { re: number; t: 'settled'; visible: boolean }
  | { re: number; t: 'done'; notes?: SliceNotes }
  | { re: number; t: 'restored' }
  | { re: number; t: 'error'; code: AgentErrorCode; detail?: string };

/**
 * Unsolicited agent → SW message (no `re`): the user pressed Esc or the page is going away.
 * The SW stops, marks the session `partial`/`error`, and still opens the editor if anything was captured.
 */
export interface AgentAbort {
  t: 'abort';
  code: 'ABORTED_BY_USER' | 'PAGEHIDE';
}

/** Unsolicited agent → SW message: the page became hidden or visible (occluded window, tab hidden). */
export interface AgentVisibility {
  t: 'visibility';
  visible: boolean;
}

export type FromAgentAny = FromAgent | AgentAbort | AgentVisibility;

// ---------------------------------------------------------------------------------------------
// SW → editor hand-off (see handoff.ts)

/** Editor page path. The session id travels in the hash: `/editor.html#s=<sessionId>`. */
export const EDITOR_PATH = '/editor.html';

/**
 * `chrome.storage.session` key mirroring a session's live status for the editor. Value type:
 * `SessionStatusSnapshot` (handoff.ts). IndexedDB stays the source of truth; this mirror only
 * exists so pages can watch progress with `storage.onChanged` instead of polling IDB.
 */
export const sessionStatusKey = (id: SessionId): string => `session-status:${id}`;

/** `chrome.storage.session` key holding the id of the capture in progress (one at a time). */
export const ACTIVE_CAPTURE_KEY = 'active-capture';

/** `chrome.storage.session` key holding the tab id of the capture in progress (badge cleanup). */
export const ACTIVE_CAPTURE_TAB_KEY = 'active-capture-tab';

/** `chrome.storage.session` key of a capture's timing report (A-private, see capture/timings.ts). */
export const timingsKey = (id: SessionId): string => `capture-timings:${id}`;

/**
 * A `capturing` session whose status mirror hasn't been refreshed for this long is presumed dead
 * (the SW was killed). The running SW refreshes `updatedAt` every `CAPTURE_HEARTBEAT_MS`.
 */
export const STALE_CAPTURE_MS = 20_000;
export const CAPTURE_HEARTBEAT_MS = 5_000;

/**
 * `runtime.sendMessage` from an extension page to the SW: "this session looks stale, recover it".
 * Sending any message wakes a terminated SW, whose start-up recovery then marks the session.
 */
export interface RecoverRequest {
  t: 'pagesnap/recover';
  id: SessionId;
}
