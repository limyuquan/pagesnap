/**
 * Capture orchestrator (owner: A). Runs in the service worker. The SW owns timing and truth: the
 * `captureVisibleTab` quota, tab integrity checks, persistence and the editor hand-off. The page
 * agent owns the DOM (CONTRACTS §4.4, 01 §5.1).
 *
 * Never stuck: every path ends with the session final (or its mirror final when IndexedDB itself
 * failed), the badge cleared or red, and the editor open.
 */
import { type Browser, browser } from 'wxt/browser';
import { getSession, listSessions, putSession, putSlice } from '@/shared/db';
import { editorUrl, publishSessionStatus } from '@/shared/handoff';
import { newSessionId } from '@/shared/ids';
import { CAPTURE_MIN_GAP_MS } from '@/shared/limits';
import {
  ACTIVE_CAPTURE_KEY,
  ACTIVE_CAPTURE_TAB_KEY,
  CAPTURE_HEARTBEAT_MS,
  type FromAgent,
  type SliceNotes,
} from '@/shared/protocol';
import { captureOptionsFrom, getSettings } from '@/shared/settings';
import type {
  CaptureError,
  CaptureErrorCode,
  CaptureSession,
  CaptureWarning,
  CaptureWarningCode,
  Point,
  SessionId,
  SliceMeta,
  TargetGeometry,
} from '@/shared/types';
import { AgentLink, InjectError, LoadTimeoutError } from './agentLink';
import { BADGE_PROGRESS, clearBadge, failedBadge, progressText, setBadge } from './badge';
import { buildLayout, type ColorRun, colorRuns, scrollerBitmapRect } from './layout';
import { createShooter, type Shooter } from './limiter';
import { dataUrlToBlob, pngBlobSize } from './png';
import type { PopupPhase, PopupSlice } from './popupProtocol';
import {
  clearProgress,
  endProgress,
  hasViewer,
  recentMedian,
  resetProgress,
  setProgress,
} from './progress';
import {
  classifyInjectError,
  classifyRestrictedUrl,
  type RestrictedKind,
  restrictedErrorMessage,
  visibleOnlyMessage,
} from './restricted';
import { runRetention } from './retention';
import { type CaptureTimings, saveTimings } from './timings';

type Tab = Browser.tabs.Tab;

/** Test-only switches (set through the e2e hook). */
export const testFlags = {
  forceRestricted: false,
  /** Make the next `putSlice` calls from this index on fail (slice write failure tests). */
  failSliceWritesFrom: -1,
  /** Make the final session write fail (final save failure tests). */
  failFinalSave: false,
  /** Override `PAUSE_LIMIT_MS` (pause tests), ms; 0 = default. */
  pauseLimitMs: 0,
  /** Make the visible-area screenshot fail too (restricted-page error tests). */
  failVisibleShot: false,
  /** Extra delay before each step (slow captures for popup tests), ms. */
  stepDelayMs: 0,
  /** Extra delay before the session is made final (popup "Stitching" tests), ms. */
  finalizeDelayMs: 0,
};

const WARNING_MESSAGES: Record<CaptureWarningCode, string> = {
  TRUNCATED: 'The page is very long, so the capture stops at the length limit.',
  VISIBLE_ONLY: 'Only the visible area was captured.',
  INNER_SCROLLER: 'The page scrolls inside a panel, so that panel was expanded in place.',
  HEIGHT_CHANGED:
    'The page changed while it was captured (content loaded or moved), so a few parts may be misaligned.',
  IMAGES_PENDING: 'Some images were still loading when they were captured.',
  NOT_SCROLLABLE:
    'The page couldn’t be scrolled (a cookie banner or dialog may be open), so one screen was captured. Close it and capture again for the full page.',
};

export function warning(
  code: CaptureWarningCode,
  message = WARNING_MESSAGES[code],
): CaptureWarning {
  return { code, message };
}

/** Thrown inside a job to stop it with a user-facing reason. */
class Stop extends Error {
  constructor(readonly error: CaptureError) {
    super(error.message);
  }
}

const stop = (code: CaptureErrorCode, message: string) => new Stop({ code, message });

export const MESSAGES = {
  switched: 'You switched tabs, so the capture stopped early.',
  navigated: 'The page navigated or reloaded, so the capture stopped early.',
  closed: 'The tab was closed during the capture.',
  hiddenTooLong:
    'The tab stayed hidden (or its window minimised) for too long, so the capture stopped early.',
  escape: 'You pressed Esc, so the capture stopped early.',
  stopped: 'You pressed Stop, so the capture stopped early.',
  resized: 'The window was resized or moved to another screen, so the capture stopped early.',
  pinch: 'The page is pinch-zoomed. Reset the zoom (pinch out) and capture again.',
  failed: 'Chrome refused to take a screenshot of this page.',
  loading: 'The page was still loading after 45 seconds. Try again once it has loaded.',
  storage: 'The capture couldn’t be saved (the disk may be full), so it stopped early.',
  storageFinal: 'The capture couldn’t be saved. Your disk may be full.',
} as const;

/** Give up after the page has been hidden (tab hidden, window minimised) this long. */
export const PAUSE_LIMIT_MS = 30_000;
const PAUSE_POLL_MS = 250;
/** Badge text while paused. */
export const PAUSED_BADGE = 'II';
/** Badge text while waiting for a loading page or for the running capture (queued tab). */
export const WAITING_BADGE = '…';
/**
 * With a popup open, how long it shows the outcome before the editor tab (which closes it) opens:
 * long enough to read "Stopped · opening what was captured" or why only the visible area was
 * captured. No delay when nobody is watching.
 */
export const POPUP_HOLD_MS = { stopped: 700, visible: 1400 } as const;

let active: CaptureJob | null = null;
/** A capture requested for another tab while one runs: starts when the running one ends. */
let queued: {
  tab: Tab;
  promise: Promise<SessionId | null>;
  resolve: (id: SessionId | null) => void;
} | null = null;

export function activeCaptureId(): SessionId | null {
  return active?.id ?? null;
}

/** Tab id of the running capture, or `null`. */
export function activeCaptureTabId(): number | null {
  return active?.tabId ?? null;
}

/**
 * Capture `tab` as a full page: inject the agent, scroll and capture slices into IndexedDB,
 * then open the editor (`editorUrl(id)`) next to the tab. Resolves with the session id once the
 * session is final and the editor is open. Only one capture runs at a time; a second call while
 * one is running resolves with the running session's id.
 */
export async function startCapture(tab: Tab): Promise<SessionId> {
  if (active) return active.id;
  if (tab.id == null || tab.id < 0) throw new Error('This tab can’t be captured');
  const job = new CaptureJob(tab, tab.id);
  active = job;
  try {
    return await job.run();
  } finally {
    if (active === job) active = null;
    startQueued();
  }
}

/**
 * Capture `tab` once the running capture has finished (a click on another tab or window while
 * one runs). The latest request wins. Resolves with the new session id, or `null` if it was
 * replaced by a later request.
 */
export function queueCapture(tab: Tab): Promise<SessionId | null> {
  if (!active) return startCapture(tab);
  const prev = queued;
  // The same tab again (its popup reopened): keep its place.
  if (prev && prev.tab.id === tab.id) return prev.promise;
  if (prev && prev.tab.id != null) {
    void clearBadge(prev.tab.id);
    clearProgress(prev.tab.id);
  }
  prev?.resolve(null);
  if (tab.id != null) {
    void setBadge(tab.id, WAITING_BADGE);
    resetProgress(tab.id, { phase: 'queued', title: tab.title ?? '', url: tab.url ?? '' });
  }
  let resolve: (id: SessionId | null) => void = () => {};
  const promise = new Promise<SessionId | null>((r) => {
    resolve = r;
  });
  queued = { tab, promise, resolve };
  return promise;
}

/** Drop the queued capture of `tabId` (Esc or Stop in its popup). Returns whether one was queued. */
export function cancelQueued(tabId: number): boolean {
  const q = queued;
  if (!q || q.tab.id !== tabId) return false;
  queued = null;
  void clearBadge(tabId);
  endProgress(tabId, { phase: 'failed', code: 'ABORTED_BY_USER', message: null });
  q.resolve(null);
  return true;
}

function startQueued(): void {
  const next = queued;
  queued = null;
  if (!next) return;
  void (async () => {
    // The tab may have navigated or closed meanwhile: use its current state.
    const tab = next.tab.id != null ? await browser.tabs.get(next.tab.id).catch(() => null) : null;
    if (!tab) return next.resolve(null);
    next.resolve(await startCapture(tab).catch(() => null));
  })();
}

/**
 * Stop the running capture early: Esc or Stop in the popup (`how`). A toolbar click no longer
 * cancels; it reopens the popup. Returns whether one ran.
 */
export function cancelCapture(how: 'esc' | 'button' = 'button'): boolean {
  if (!active) return false;
  active.fail(stop('ABORTED_BY_USER', how === 'esc' ? MESSAGES.escape : MESSAGES.stopped));
  return true;
}

/**
 * True during the first moments of a capture, when a second click is more likely a double-click.
 * With `tabId`, only for the capture of that tab.
 */
export function captureJustStarted(ms = 800, tabId?: number): boolean {
  if (!active || (tabId != null && active.tabId !== tabId)) return false;
  return performance.now() - active.startedAt < ms;
}

/** `measured` (bitmap / viewport width) snapped to the page's `devicePixelRatio` when it agrees. */
export function snapScale(measured: number, dprHint: number | undefined): number {
  if (!(measured > 0)) return 1;
  if (dprHint && dprHint > 0 && Math.abs(measured - dprHint) / dprHint < 0.01) {
    // devicePixelRatio under zoom is a float32 (2.2000000476837): drop the noise.
    return Math.round(dprHint * 1e4) / 1e4;
  }
  return measured;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

class CaptureJob {
  readonly id = newSessionId();
  readonly startedAt = performance.now();
  private readonly ac = new AbortController();
  private stopped: Stop | null = null;
  private session: CaptureSession;
  private readonly slices: SliceMeta[] = [];
  /** Only slice 0's blob is kept in memory (inner-scroller side rails); the rest go to IDB. */
  private firstBlob: Blob | null = null;
  private persist: Promise<void> = Promise.resolve();
  /** Slices `[0, persisted)` are stored: the layout never references anything beyond. */
  private persisted = 0;
  private persistFailed = false;
  private link: AgentLink | null = null;
  private readonly shooter: Shooter;
  private windowId: number;
  private tabIndex: number;
  private scale = 0;
  private dprHint: number | undefined;
  private viewportW = 0;
  private estTotal = 1;
  private readonly timings: CaptureTimings;
  private readonly unlisten: (() => void)[] = [];
  /** Last visibility the agent reported, and a counter bumped whenever it goes hidden. */
  private pageVisible = true;
  private hiddenEpoch = 0;
  private misaligned = false;
  private imagesPending = false;
  private truncatedLate = false;
  private retakes = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** What the popup's miniature needs about each stored slice. */
  private readonly popupSlices: PopupSlice[] = [];
  /** Content size of the page being captured, CSS px (capped at the length limit). */
  private pageSize: { w: number; h: number } | null = null;
  private maxCssH = Number.POSITIVE_INFINITY;

  constructor(
    private readonly tab: Tab,
    readonly tabId: number,
  ) {
    this.windowId = tab.windowId;
    this.tabIndex = tab.index;
    const now = Date.now();
    this.session = {
      v: 1,
      id: this.id,
      url: tab.url ?? '',
      title: tab.title ?? '',
      createdAt: now,
      updatedAt: now,
      mode: 'full',
      status: 'capturing',
      error: null,
      warnings: [],
      progress: { done: 0, total: 1 },
      viewport: { w: 0, h: 0 },
      dpr: 1,
      css: { w: 0, h: 0 },
      image: { w: 0, h: 0 },
      slices: [],
      layout: { size: { w: 0, h: 0 }, background: '#ffffff', fills: [], parts: [] },
      bytes: 0,
    };
    this.shooter = createShooter({
      capture: () => browser.tabs.captureVisibleTab(this.windowId, { format: 'png' }),
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      minGapMs: CAPTURE_MIN_GAP_MS,
    });
    this.timings = {
      id: this.id,
      url: this.session.url,
      startedAt: now,
      slices: 0,
      prepareMs: 0,
      captureMs: 0,
      finalizeMs: 0,
      totalMs: 0,
      frameGapsMs: [],
      status: 'capturing',
    };
  }

  fail(reason: Stop): void {
    if (this.stopped) return;
    this.stopped = reason;
    this.ac.abort(reason);
  }

  async run(): Promise<SessionId> {
    const t0 = performance.now();
    resetProgress(this.tabId, {
      sessionId: this.id,
      phase: 'preparing',
      title: this.session.title,
      url: this.session.url,
    });
    try {
      await this.save();
    } catch (err) {
      this.fail(stop('STORAGE_FAILED', MESSAGES.storageFinal));
      console.warn('[pagesnap] first session write failed', err);
    }
    await browser.storage.session
      .set({ [ACTIVE_CAPTURE_KEY]: this.id, [ACTIVE_CAPTURE_TAB_KEY]: this.tabId })
      .catch(() => {});
    void setBadge(this.tabId, progressText(0, 0));
    this.heartbeat = setInterval(() => void this.beat(), CAPTURE_HEARTBEAT_MS);
    let editor: Tab | null = null;
    try {
      this.listen();
      try {
        if (!this.stopped) await this.capture();
      } catch (err) {
        this.fail(err instanceof Stop ? err : stop('INTERNAL', `Capture failed: ${errText(err)}`));
      }
      if (!this.stopped) setProgress(this.tabId, { phase: 'stitching' });
      await this.release();
      if (testFlags.finalizeDelayMs > 0) await sleep(testFlags.finalizeDelayMs);
      const tf = performance.now();
      await this.finalize();
      this.timings.finalizeMs = Math.round(performance.now() - tf);
    } finally {
      clearInterval(this.heartbeat);
      await browser.storage.session
        .remove([ACTIVE_CAPTURE_KEY, ACTIVE_CAPTURE_TAB_KEY])
        .catch(() => {});
      editor = await this.handOff();
      await this.finishBadge(editor).catch(() => clearBadge(this.tabId));
    }
    this.timings.totalMs = Math.round(performance.now() - t0);
    this.timings.status = this.session.status;
    this.timings.slices = this.session.slices.length;
    this.timings.retakes = this.retakes;
    await saveTimings(this.timings);
    console.info('[pagesnap] capture', this.timings);
    void runRetention({ activeId: this.id, reason: 'capture' });
    return this.id;
  }

  // -------------------------------------------------------------------------------------------

  private async capture(): Promise<void> {
    const tp = performance.now();
    const opts = captureOptionsFrom(await getSettings());
    const fileAccess = await browser.extension.isAllowedFileSchemeAccess().catch(() => false);
    const own = browser.runtime.getURL('/');
    const kind = classifyRestrictedUrl(this.session.url, fileAccess, own);
    // Our own editor and options pages can't be scripted; say so rather than blame "other extensions".
    if (kind === 'own-page') return this.visibleOnly(kind);
    try {
      if (testFlags.forceRestricted) throw new InjectError('forced by test');
      this.link = await AgentLink.inject(this.tabId, { signal: this.ac.signal });
    } catch (err) {
      this.throwIfStopped();
      if (err instanceof InjectError) {
        return this.visibleOnly(kind === 'unknown' ? classifyInjectError(err.message, own) : kind);
      }
      if (err instanceof LoadTimeoutError) throw stop('CAPTURE_FAILED', MESSAGES.loading);
      throw err;
    }
    const link = this.link;
    link.onAbort = (code) =>
      this.fail(
        code === 'ABORTED_BY_USER'
          ? stop('ABORTED_BY_USER', MESSAGES.escape)
          : stop('TAB_CHANGED', MESSAGES.navigated),
      );
    link.onDisconnect = () => this.fail(stop('TAB_CHANGED', MESSAGES.navigated));
    link.onVisibility = (visible) => this.setVisible(visible);

    const prep = await link.request(
      { t: 'prepare', session: this.id, opts },
      20_000,
      this.ac.signal,
    );
    this.throwIfStopped();
    if (prep.t === 'error') {
      if (prep.code === 'PINCH_ZOOM') throw stop('PINCH_ZOOM', MESSAGES.pinch);
      // The agent can't scroll this page (PDF viewer, broken page): take what's visible.
      link.close();
      this.link = null;
      return this.visibleOnly(prep.detail === 'pdf' ? 'pdf' : 'unknown');
    }
    if (prep.t !== 'prepared') throw stop('INTERNAL', 'Unexpected reply from the page');
    this.viewportW = prep.viewport.w;
    this.dprHint = prep.dpr;
    this.estTotal = Math.max(1, prep.estSlices);
    this.session.viewport = { w: prep.viewport.w, h: prep.viewport.h };
    this.session.warnings = prep.warnings.map((c) => warning(c as CaptureWarningCode));
    this.session.progress = { done: 0, total: this.estTotal };
    this.timings.prepareMs = Math.round(performance.now() - tp);
    void this.save().catch(() => {});
    this.maxCssH = opts.maxCssHeight;
    this.notePageSize(prep.target);
    setProgress(this.tabId, { phase: 'capturing', total: this.estTotal, page: this.pageSize });

    const tc = performance.now();
    // Ask until the agent says `done`, even after the last slice: it may want to take a slice
    // again if the page moved while it was shot.
    for (;;) {
      if (testFlags.stepDelayMs > 0) await sleep(testFlags.stepDelayMs, this.ac.signal);
      const r = await link.request({ t: 'step' }, 15_000, this.ac.signal);
      this.throwIfStopped();
      if (r.t === 'done') {
        if (r.notes) this.note(r.notes);
        break;
      }
      if (r.t !== 'positioned') throw this.agentError(r);
      this.note(r.notes);
      this.notePageSize(r.target);
      if (!r.visible) this.setVisible(false);
      await this.shoot(r);
    }
    this.timings.captureMs = Math.round(performance.now() - tc);
  }

  private setVisible(visible: boolean): void {
    if (!visible && this.pageVisible) this.hiddenEpoch++;
    this.pageVisible = visible;
  }

  private note(notes: SliceNotes): void {
    if (notes.misaligned) this.misaligned = true;
    if (notes.imagesPending) this.imagesPending = true;
    if (notes.truncated) this.truncatedLate = true;
  }

  /**
   * Take the slice the agent positioned. Waits (paused) while the page is hidden or the window
   * minimised, checks the tab before shooting, and drops a frame taken while the page was hidden.
   */
  private async shoot(at: Extract<FromAgent, { t: 'positioned' }>): Promise<void> {
    let dataUrl: string;
    for (;;) {
      const resumed = await this.waitShootable();
      if (resumed && this.link) {
        const r = await this.link.request({ t: 'settle' }, 5000, this.ac.signal);
        this.throwIfStopped();
        if (r.t === 'settled' && !r.visible) {
          this.setVisible(false);
          continue;
        }
      }
      const epoch = this.hiddenEpoch;
      dataUrl = await this.shooter.shoot(this.ac.signal);
      // A slice that returns after an abort may show the restored page: drop it.
      this.throwIfStopped();
      if (epoch === this.hiddenEpoch && this.pageVisible) break;
      // The page went hidden while the screenshot was taken: it may be stale. Take it again.
    }
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await pngBlobSize(blob);
    const scale = bitmap.w / this.viewportW;
    if (this.scale === 0) {
      this.scale = scale;
      this.session.dpr = snapScale(scale, this.dprHint);
    } else if (Math.abs(scale - this.scale) / this.scale > 0.005) {
      throw stop('SCALE_CHANGED', MESSAGES.resized);
    }
    const replace = at.retake && at.i < this.slices.length ? at.i : undefined;
    this.addSlice(blob, bitmap, { x: at.scrollX, y: at.scrollY }, at.target, at.place, replace);
  }

  /**
   * Resolve when a screenshot can be taken: the tab is still there and active, and the page is
   * visible. While the page is hidden or the window minimised, pause (badge `II`) and poll; stop
   * after `PAUSE_LIMIT_MS`. Resolves `true` if it paused (the page needs a repaint first).
   */
  private async waitShootable(): Promise<boolean> {
    let pausedAt = 0;
    for (;;) {
      this.throwIfStopped();
      const [tab, win] = await Promise.all([
        browser.tabs.get(this.tabId).catch(() => null),
        browser.windows.get(this.windowId).catch(() => null),
      ]);
      this.throwIfStopped();
      if (!tab) throw stop('TAB_CHANGED', MESSAGES.closed);
      if (!tab.active || tab.windowId !== this.windowId) {
        throw stop('TAB_CHANGED', MESSAGES.switched);
      }
      this.tabIndex = tab.index;
      const hidden = win?.state === 'minimized' || !this.pageVisible;
      if (!hidden) {
        if (pausedAt) {
          console.info('[pagesnap] resumed after', Math.round(performance.now() - pausedAt), 'ms');
          void setBadge(this.tabId, progressText(this.slices.length, this.estTotal));
          setProgress(this.tabId, { phase: 'capturing' });
        }
        return pausedAt > 0;
      }
      if (!pausedAt) {
        pausedAt = performance.now();
        console.info('[pagesnap] paused', {
          state: win?.state,
          focused: win?.focused,
          visible: this.pageVisible,
        });
        void setBadge(this.tabId, PAUSED_BADGE, BADGE_PROGRESS);
        setProgress(this.tabId, { phase: 'paused' });
      } else if (performance.now() - pausedAt > (testFlags.pauseLimitMs || PAUSE_LIMIT_MS)) {
        throw stop('TAB_CHANGED', MESSAGES.hiddenTooLong);
      }
      await sleep(PAUSE_POLL_MS, this.ac.signal);
    }
  }

  private addSlice(
    blob: Blob,
    bitmap: { w: number; h: number },
    scroll: Point,
    target: TargetGeometry,
    place?: Point,
    replace?: number,
  ): void {
    const index = replace ?? this.slices.length;
    const meta: SliceMeta = { index, scroll, bitmap, target, capturedAt: Date.now() };
    if (place && (place.x !== scroll.x || place.y !== scroll.y)) meta.place = place;
    // A retake overwrites the slice (same IDB key) and its metadata.
    this.slices[index] = meta;
    if (replace != null) this.retakes++;
    if (index === 0) this.firstBlob = blob;
    const starts = this.shooter.starts;
    if (starts.length >= 2) {
      this.timings.frameGapsMs.push(Math.round((starts.at(-1) ?? 0) - (starts.at(-2) ?? 0)));
    }
    this.estTotal = Math.max(this.estTotal, this.slices.length);
    const progress = { done: this.slices.length, total: this.estTotal };
    void setBadge(this.tabId, progressText(progress.done, progress.total));
    // Persist in the background while the agent scrolls to the next position. The first failed
    // write stops the capture; nothing after it is stored, so the stored slices stay a prefix.
    this.persist = this.persist.then(async () => {
      if (this.persistFailed) return;
      try {
        if (testFlags.failSliceWritesFrom >= 0 && index >= testFlags.failSliceWritesFrom) {
          throw new Error('QuotaExceededError (test)');
        }
        await putSlice({ sessionId: this.id, index, blob });
      } catch (err) {
        this.persistFailed = true;
        console.warn('[pagesnap] slice write failed', err);
        this.fail(stop('STORAGE_FAILED', MESSAGES.storage));
        return;
      }
      if (replace == null) this.session.bytes = (this.session.bytes ?? 0) + blob.size;
      this.persisted = Math.max(this.persisted, index + 1);
      this.session.slices = this.slices.slice(0, this.persisted);
      this.session.progress = { done: this.persisted, total: progress.total };
      this.reportSlice(meta);
      await this.save().catch((err: unknown) => console.warn('[pagesnap] session write', err));
    });
  }

  /** Fallback for pages the agent can't scroll: one visible-area screenshot (01 §3.10). */
  private async visibleOnly(kind: RestrictedKind): Promise<void> {
    const tab = await browser.tabs.get(this.tabId).catch(() => this.tab);
    const zoom = await browser.tabs.getZoom(this.tabId).catch(() => 1);
    let dataUrl: string;
    try {
      await this.waitShootable();
      if (testFlags.failVisibleShot) throw new Error('Cannot access contents of the page (test)');
      dataUrl = await this.shooter.shoot(this.ac.signal);
    } catch (err) {
      if (err instanceof Stop) throw err;
      this.throwIfStopped();
      console.warn('[pagesnap] visible capture failed', err);
      throw stop('RESTRICTED', restrictedErrorMessage(kind));
    }
    this.throwIfStopped();
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await pngBlobSize(blob);
    const w = (tab.width ?? bitmap.w) / (zoom || 1);
    const h = (tab.height ?? bitmap.h) / (zoom || 1);
    this.viewportW = w;
    this.scale = bitmap.w / w;
    this.session.dpr = this.scale;
    this.session.viewport = { w, h };
    this.session.mode = 'visible';
    this.session.warnings = [warning('VISIBLE_ONLY', visibleOnlyMessage(kind))];
    const rect = { x: 0, y: 0, w, h };
    this.addSlice(
      blob,
      bitmap,
      { x: 0, y: 0 },
      {
        kind: 'document',
        clientRect: rect,
        range: { x0: 0, x1: 0, y0: 0, y1: 0 },
        content: { w, h },
      },
    );
  }

  private listen(): void {
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === this.windowId && info.tabId !== this.tabId) {
        this.fail(stop('TAB_CHANGED', MESSAGES.switched));
      }
    };
    const onRemoved = (tabId: number) => {
      if (tabId === this.tabId) this.fail(stop('TAB_CHANGED', MESSAGES.closed));
    };
    const onReplaced = (_added: number, removed: number) => {
      if (removed === this.tabId) this.fail(stop('TAB_CHANGED', MESSAGES.navigated));
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.onReplaced.addListener(onReplaced);
    this.unlisten.push(
      () => browser.tabs.onActivated.removeListener(onActivated),
      () => browser.tabs.onRemoved.removeListener(onRemoved),
      () => browser.tabs.onReplaced.removeListener(onReplaced),
    );
  }

  /** Restore the page, stop listening and wait for pending writes. Never throws. */
  private async release(): Promise<void> {
    for (const off of this.unlisten.splice(0)) off();
    const link = this.link;
    this.link = null;
    if (link?.isOpen) {
      await link.request({ t: 'restore' }, 2000);
      link.close();
    }
    await this.persist.catch(() => {});
  }

  /** Make the session final. Never throws: if IDB is broken the mirror still gets the verdict. */
  private async finalize(): Promise<void> {
    const s = this.session;
    try {
      const stored = this.slices.slice(0, this.persisted);
      s.slices = stored;
      s.dpr = snapScale(this.scale || 1, this.dprHint);
      if (stored.length > 0) {
        const sideRuns = await this.sideRuns().catch(() => undefined);
        const built = buildLayout({ slices: stored, scale: s.dpr, ...(sideRuns && { sideRuns }) });
        s.css = built.css;
        s.image = built.image;
        s.layout = built.layout;
        this.addWarning('TRUNCATED', this.truncatedLate);
        this.addWarning('HEIGHT_CHANGED', this.misaligned);
        this.addWarning('IMAGES_PENDING', this.imagesPending);
      }
      s.progress = { done: stored.length, total: stored.length };
      if (this.stopped) {
        s.status = stored.length > 0 ? 'partial' : 'error';
        s.error = this.stopped.error;
      } else {
        s.status = stored.length > 0 ? 'ready' : 'error';
        s.error = stored.length > 0 ? null : { code: 'CAPTURE_FAILED', message: MESSAGES.failed };
      }
    } catch (err) {
      console.warn('[pagesnap] finalize failed', err);
      s.status = 'error';
      s.error = { code: 'INTERNAL', message: `Capture failed: ${errText(err)}` };
    }
    try {
      if (testFlags.failFinalSave) throw new Error('QuotaExceededError (test)');
      await this.save();
    } catch (err) {
      console.warn('[pagesnap] final session write failed', err);
      s.status = 'error';
      s.error = { code: 'STORAGE_FAILED', message: MESSAGES.storageFinal };
      // The editor follows the mirror: give it the verdict even though IDB has an old record.
      s.updatedAt = Date.now();
      await publishSessionStatus(s).catch(() => {});
    }
  }

  private addWarning(code: CaptureWarningCode, on: boolean): void {
    if (on && !this.session.warnings.some((w) => w.code === code)) {
      this.session.warnings.push(warning(code));
    }
  }

  /** For inner-scroller sessions: colour runs of slice 0's last row beside the scroller. */
  private async sideRuns(): Promise<{ left: ColorRun[]; right: ColorRun[] } | undefined> {
    const first = this.slices[0];
    const blob = this.firstBlob;
    if (!first || !blob || first.target.kind !== 'element') return undefined;
    const r = scrollerBitmapRect(first.target.clientRect, this.scale, first.bitmap);
    const w = first.bitmap.w;
    const y = Math.max(0, r.y + r.h - 1);
    const bmp = await createImageBitmap(blob, 0, y, w, 1);
    const canvas = new OffscreenCanvas(w, 1);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const row = ctx.getImageData(0, 0, w, 1).data;
    const right0 = r.x + r.w;
    return {
      left: r.x > 0 ? colorRuns(row.subarray(0, r.x * 4), r.x, 0) : [],
      right: right0 < w ? colorRuns(row.subarray(right0 * 4), w - right0, right0) : [],
    };
  }

  /** Track the size of the page being assembled (it can grow), capped at the length limit. */
  private notePageSize(target: TargetGeometry): void {
    const w = Math.max(1, target.content.w - target.range.x0);
    const h = Math.max(1, Math.min(target.content.h - target.range.y0, this.maxCssH));
    if (this.pageSize?.w === w && this.pageSize.h === h) return;
    this.pageSize = { w, h };
  }

  /** A slice is stored: tell the popup where it goes and which part of the PNG to show. */
  private reportSlice(meta: SliceMeta): void {
    const t = meta.target;
    const at = meta.place ?? meta.scroll;
    const scale = this.scale || meta.bitmap.w / Math.max(1, this.viewportW);
    const r = t.clientRect;
    const cx = Math.max(0, Math.round(r.x * scale));
    const cy = Math.max(0, Math.round(r.y * scale));
    const crop = {
      x: cx,
      y: cy,
      w: Math.max(1, Math.min(meta.bitmap.w - cx, Math.round(r.w * scale))),
      h: Math.max(1, Math.min(meta.bitmap.h - cy, Math.round(r.h * scale))),
    };
    const prev = this.popupSlices[meta.index];
    this.popupSlices[meta.index] = {
      i: meta.index,
      v: (prev?.v ?? 0) + (prev ? 1 : 0),
      x: at.x - t.range.x0,
      y: at.y - t.range.y0,
      w: r.w,
      h: r.h,
      crop,
    };
    const bottom = at.y - t.range.y0 + r.h;
    const page = this.pageSize ?? { w: r.w, h: bottom };
    if (bottom > page.h) this.pageSize = { w: page.w, h: Math.min(bottom, this.maxCssH) };
    setProgress(this.tabId, {
      done: this.persisted,
      total: Math.max(this.estTotal, this.persisted),
      page: this.pageSize ?? page,
      slices: this.popupSlices.slice(0, this.persisted).filter(Boolean),
      cadenceMs: recentMedian(this.timings.frameGapsMs),
      lastSliceAt: Date.now(),
    });
  }

  /**
   * Tell the popup how it ended, then open the editor. With a popup open: hold a moment on
   * "stopped" / "visible area only" so it can be read, and when nothing was captured keep the
   * explanation in the popup instead of opening an editor that only repeats it.
   */
  private async handOff(): Promise<Tab | null> {
    const s = this.session;
    const outcome: PopupPhase =
      s.status === 'error'
        ? 'failed'
        : s.status === 'partial'
          ? 'stopped'
          : s.mode === 'visible'
            ? 'visible'
            : 'opening';
    const message =
      outcome === 'visible'
        ? (s.warnings.find((w) => w.code === 'VISIBLE_ONLY')?.message ?? null)
        : (s.error?.message ?? null);
    setProgress(this.tabId, {
      phase: outcome,
      message,
      code: s.error?.code ?? null,
      done: s.slices.length,
      total: Math.max(s.slices.length, outcome === 'opening' ? s.slices.length : this.estTotal),
    });
    const watched = hasViewer(this.tabId);
    if (watched && outcome === 'failed') {
      endProgress(this.tabId, {});
      return null;
    }
    const hold = outcome === 'stopped' || outcome === 'visible' ? POPUP_HOLD_MS[outcome] : 0;
    if (watched && hold) await sleep(hold);
    const editor = await this.openEditor().catch(() => null);
    endProgress(this.tabId, editor ? { phase: 'done' } : {});
    return editor;
  }

  private async openEditor(): Promise<Tab | null> {
    const tab = await browser.tabs.get(this.tabId).catch(() => null);
    const url = editorUrl(this.id);
    // Don't steal focus from a tab the user switched to.
    const activeTab = !!tab?.active;
    try {
      return await browser.tabs.create(
        tab
          ? {
              url,
              windowId: tab.windowId,
              index: tab.index + 1,
              openerTabId: tab.id,
              active: activeTab,
            }
          : { url, windowId: this.windowId, index: this.tabIndex + 1 },
      );
    } catch {
      return browser.tabs.create({ url }).catch(() => null);
    }
  }

  /**
   * Progress badge off. A failed or cut-short capture (not one the user cancelled) leaves a red
   * `!` on the captured tab until its editor tab is in front, where the reason is spelled out.
   */
  private async finishBadge(editor: Tab | null): Promise<void> {
    const s = this.session;
    const failed =
      s.status === 'error' || (s.status === 'partial' && s.error?.code !== 'ABORTED_BY_USER');
    if (!failed || editor?.active || editor?.id == null) {
      await clearBadge(this.tabId);
      return;
    }
    await failedBadge(this.tabId);
    const tabId = this.tabId;
    const editorId = editor.id;
    const done = () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      void clearBadge(tabId);
    };
    const onActivated = (info: { tabId: number }) => {
      if (info.tabId === editorId) done();
    };
    const onRemoved = (id: number) => {
      if (id === editorId || id === tabId) done();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onRemoved.addListener(onRemoved);
  }

  private async save(): Promise<void> {
    this.session.updatedAt = Date.now();
    const snapshot = structuredClone(this.session);
    await putSession(snapshot);
    await publishSessionStatus(snapshot);
  }

  /** Heartbeat: refresh the mirror's `updatedAt` so editors know the capture is alive. */
  private async beat(): Promise<void> {
    if (this.session.status !== 'capturing') return;
    try {
      await publishSessionStatus({ ...this.session, updatedAt: Date.now() });
    } catch {
      // Best effort.
    }
  }

  private throwIfStopped(): void {
    if (this.stopped) throw this.stopped;
  }

  private agentError(r: FromAgent): Stop {
    if (r.t !== 'error') return stop('INTERNAL', 'Unexpected reply from the page');
    if (r.code === 'SCROLL_JACKED') {
      return stop('SCROLL_JACKED', 'The page fights scrolling, so the capture stopped early.');
    }
    if (r.code === 'NAVIGATED' || r.detail === 'disconnected') {
      return stop('TAB_CHANGED', MESSAGES.navigated);
    }
    return stop('INTERNAL', `The page stopped responding (${r.detail ?? r.code}).`);
  }
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/**
 * On SW start: a capture that was running when the SW died can never finish. Mark it
 * `INTERRUPTED` (partial if it has slices) so the editor can still open it, and clear its badge.
 */
export async function recoverInterrupted(): Promise<void> {
  const got = await browser.storage.session.get([ACTIVE_CAPTURE_KEY, ACTIVE_CAPTURE_TAB_KEY]);
  const id = got[ACTIVE_CAPTURE_KEY] as SessionId | undefined;
  const tabId = got[ACTIVE_CAPTURE_TAB_KEY] as number | undefined;
  if (!id || id === active?.id) return;
  await markInterrupted(id);
  if (typeof tabId === 'number') await clearBadge(tabId);
  await browser.storage.session.remove([ACTIVE_CAPTURE_KEY, ACTIVE_CAPTURE_TAB_KEY]);
}

/** An editor asked: this `capturing` session looks dead. Recover it unless it's really running. */
export async function recoverSession(id: SessionId): Promise<void> {
  if (id === active?.id) return;
  await recoverInterrupted();
  await markInterrupted(id);
}

/** On browser start: any session still `capturing` was cut off by the restart. */
export async function recoverAllInterrupted(): Promise<void> {
  for (const s of await listSessions(50)) {
    if (s.status === 'capturing' && s.id !== active?.id) await markInterrupted(s.id);
  }
}

async function markInterrupted(id: SessionId): Promise<void> {
  const s = await getSession(id);
  if (s?.status !== 'capturing') return;
  const error: CaptureError = {
    code: 'INTERRUPTED',
    message: 'The capture was interrupted before it finished.',
  };
  let next: CaptureSession = { ...s, status: 'error', error, updatedAt: Date.now() };
  const first = s.slices[0];
  if (first) {
    // `dpr` may not have been written yet: derive the scale from the first slice.
    const measured = s.viewport.w ? first.bitmap.w / s.viewport.w : 1;
    const scale = snapScale(measured, s.dpr);
    const built = buildLayout({ slices: s.slices, scale });
    next = {
      ...next,
      status: 'partial',
      dpr: scale,
      progress: { done: s.slices.length, total: s.slices.length },
      ...built,
    };
  }
  await putSession(next);
  await publishSessionStatus(next);
}
