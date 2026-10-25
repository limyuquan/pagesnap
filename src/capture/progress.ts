/**
 * Capture progress for the action popup (owner: A). The orchestrator reports phases and stored
 * slices per tab; every popup port showing that tab gets the merged state, coalesced to one
 * message per task. Cheap by design: no images, no timers while nobody is watching.
 */
import { type Browser, browser } from 'wxt/browser';
import { POPUP_PORT_NAME, type PopupState, type PopupToSw, type SwToPopup } from './popupProtocol';

type Port = Browser.runtime.Port;

export interface PopupHandlers {
  /** A popup for `tabId` opened: start (or join) its capture. */
  open(tabId: number): void;
  /** Esc or Stop in the popup for `tabId`. */
  cancel(tabId: number, how: 'esc' | 'button'): void;
}

const viewers = new Map<Port, number>();
const states = new Map<number, PopupState>();
const dirty = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/** Last popup paint report (e2e perf budget). */
let lastPerf: Extract<PopupToSw, { t: 'perf' }> | null = null;
let installed = false;

function emptyState(tabId: number): PopupState {
  return {
    tabId,
    sessionId: null,
    phase: 'preparing',
    title: '',
    url: '',
    done: 0,
    total: 0,
    page: null,
    slices: [],
    cadenceMs: null,
    lastSliceAt: 0,
    message: null,
    code: null,
  };
}

/** Merge `patch` into the tab's state and push it to its popups (coalesced). */
export function setProgress(tabId: number, patch: Partial<PopupState>): void {
  const prev = states.get(tabId) ?? emptyState(tabId);
  states.set(tabId, { ...prev, ...patch, tabId });
  schedule(tabId);
}

/** Start over for a new capture of `tabId`. */
export function resetProgress(tabId: number, patch: Partial<PopupState>): void {
  states.set(tabId, { ...emptyState(tabId), ...patch, tabId });
  schedule(tabId);
}

/** Push the final state now, then forget it (the next popup on this tab starts a new capture). */
export function endProgress(tabId: number, patch: Partial<PopupState>): void {
  setProgress(tabId, patch);
  flush();
  states.delete(tabId);
}

export function clearProgress(tabId: number): void {
  states.delete(tabId);
  dirty.delete(tabId);
}

export function getProgress(tabId: number): PopupState | null {
  return states.get(tabId) ?? null;
}

/** Whether a popup is showing `tabId` right now. */
export function hasViewer(tabId: number): boolean {
  for (const t of viewers.values()) if (t === tabId) return true;
  return false;
}

export function viewerCount(): number {
  return viewers.size;
}

export function lastPopupPerf(): typeof lastPerf {
  return lastPerf;
}

function schedule(tabId: number): void {
  dirty.add(tabId);
  if (flushTimer === undefined) flushTimer = setTimeout(flush, 0);
}

function flush(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  for (const tabId of dirty) {
    const state = states.get(tabId);
    if (state) for (const [port, t] of viewers) if (t === tabId) send(port, state);
  }
  dirty.clear();
}

function send(port: Port, state: PopupState): void {
  try {
    port.postMessage({ t: 'state', state } satisfies SwToPopup);
  } catch {
    viewers.delete(port);
  }
}

/** Accept popup ports. Closing a popup only drops its port; the capture is not touched. */
export function installPopupHub(handlers: PopupHandlers): void {
  if (installed) return;
  installed = true;
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT_NAME) return;
    if (port.sender?.id !== browser.runtime.id) return port.disconnect();
    port.onMessage.addListener((msg: PopupToSw) => {
      if (msg.t === 'open' && typeof msg.tabId === 'number') {
        viewers.set(port, msg.tabId);
        const state = states.get(msg.tabId);
        if (state) send(port, state);
        handlers.open(msg.tabId);
      } else if (msg.t === 'cancel') {
        const tabId = viewers.get(port);
        if (tabId != null) handlers.cancel(tabId, msg.how === 'esc' ? 'esc' : 'button');
      } else if (msg.t === 'perf') {
        lastPerf = msg;
      }
    });
    port.onDisconnect.addListener(() => viewers.delete(port));
  });
}

/** Median of the last `n` values, or null with fewer than `min`. */
export function recentMedian(values: readonly number[], n = 6, min = 3): number | null {
  const last = values.slice(-n).filter((v) => v > 0);
  if (last.length < min) return null;
  const sorted = [...last].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
