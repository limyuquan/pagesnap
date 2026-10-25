/**
 * SW ↔ action popup (owner: A). Types and constants only: the popup bundle imports this, so it
 * must stay free of runtime dependencies.
 *
 * The popup is a viewer with two buttons. It opens a port named `POPUP_PORT_NAME`, says which tab
 * it belongs to (`open`), and the SW starts a capture of that tab unless one is already running
 * (the same `requestCapture` the e2e `clickAction` hook uses). The SW then pushes `state` on every
 * change. Closing the popup only disconnects the port: the capture carries on, with the badge.
 * `cancel` (Esc or the Stop button) is the only way the popup stops a capture.
 *
 * Thumbnails are not sent: `slices` lists the stored slices and the popup reads their PNGs from
 * IndexedDB (same origin) and decodes them at thumbnail size, so the SW does no extra work.
 */
import type { CaptureErrorCode, Rect, SessionId, Size } from '@/shared/types';

export const POPUP_PORT_NAME = 'pagesnap/popup';

export type PopupPhase =
  /** Another capture runs (in another window); this tab's starts when it ends. */
  | 'queued'
  | 'preparing'
  | 'capturing'
  /** The tab is hidden or its window minimised; resumes when it is visible again. */
  | 'paused'
  | 'stitching'
  | 'opening'
  /** Stopped early (Esc, Stop, tab switch…) with something captured: the editor opens next. */
  | 'stopped'
  /** Only the visible area could be captured (restricted page): the editor opens next. */
  | 'visible'
  /** Nothing was captured. With a popup open the editor does not open: the popup says why. */
  | 'failed'
  /** The editor tab is open. The popup closes itself. */
  | 'done';

/** One stored slice, as the miniature needs it. */
export interface PopupSlice {
  i: number;
  /** Bumped when a slice is taken again (same IDB key): reload it. */
  v: number;
  /** Where it goes in the output, CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The part of the stored PNG that shows the scrolled content, bitmap px. */
  crop: Rect;
}

export interface PopupState {
  tabId: number;
  sessionId: SessionId | null;
  phase: PopupPhase;
  title: string;
  url: string;
  /** Slices stored / expected (the estimate can grow with the page). */
  done: number;
  total: number;
  /** Size of the page being assembled, CSS px (null until the page is measured). */
  page: Size | null;
  slices: PopupSlice[];
  /** Median time between screenshots, ms, once a few were taken. */
  cadenceMs: number | null;
  /** `Date.now()` when the last slice was stored. */
  lastSliceAt: number;
  /** Why it stopped or failed, or the visible-only explanation. */
  message: string | null;
  code: CaptureErrorCode | null;
}

/** Popup → SW. */
export type PopupToSw =
  | { t: 'open'; tabId: number }
  | { t: 'cancel'; how: 'esc' | 'button' }
  /** First paint timings, for the perf budget (ms since the popup's navigation start). */
  | { t: 'perf'; fcp: number | null; firstFrame: number; openedAt: number };

/** SW → popup. */
export type SwToPopup = { t: 'state'; state: PopupState };
