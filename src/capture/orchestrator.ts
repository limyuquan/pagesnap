/**
 * Capture orchestrator (owner: A). Runs in the service worker. The SW owns timing and truth: the
 * `captureVisibleTab` quota, tab integrity checks, persistence and the editor hand-off. The page
 * agent owns the DOM (CONTRACTS §4.4, 01 §5.1).
 */
import { type Browser, browser } from 'wxt/browser';
import { getSession, listSessions, putSession, putSlice } from '@/shared/db';
import { editorUrl, publishSessionStatus } from '@/shared/handoff';
import { newSessionId } from '@/shared/ids';
import { CAPTURE_MIN_GAP_MS } from '@/shared/limits';
import { ACTIVE_CAPTURE_KEY, type FromAgent } from '@/shared/protocol';
import { captureOptionsFrom, getSettings } from '@/shared/settings';
import type {
  CaptureError,
  CaptureErrorCode,
  CaptureSession,
  CaptureWarning,
  CaptureWarningCode,
  SessionId,
  SliceMeta,
  TargetGeometry,
} from '@/shared/types';
import { AgentLink, InjectError } from './agentLink';
import { clearBadge, progressText, setBadge } from './badge';
import { buildLayout, type ColorRun, colorRuns, scrollerBitmapRect } from './layout';
import { createShooter, type Shooter } from './limiter';
import { dataUrlToBlob, pngBlobSize } from './png';
import {
  classifyInjectError,
  classifyRestrictedUrl,
  type RestrictedKind,
  restrictedErrorMessage,
  visibleOnlyMessage,
} from './restricted';
import { type CaptureTimings, saveTimings } from './timings';

type Tab = Browser.tabs.Tab;

/** Test-only switches (set through the e2e hook). */
export const testFlags = { forceRestricted: false };

const WARNING_MESSAGES: Record<CaptureWarningCode, string> = {
  TRUNCATED: 'The page is very long, so the capture stops at the length limit.',
  VISIBLE_ONLY: 'Only the visible area was captured.',
  INNER_SCROLLER: 'The page scrolls inside a panel, so that panel was expanded in place.',
  HEIGHT_CHANGED:
    'The page changed while it was captured (content loaded or moved), so a few parts may be misaligned.',
  IMAGES_PENDING: 'Some images were still loading when they were captured.',
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

const MESSAGES = {
  switched: 'You switched tabs, so the capture stopped early.',
  hidden: 'The tab was hidden or left, so the capture stopped early.',
  navigated: 'The page navigated or reloaded, so the capture stopped early.',
  closed: 'The tab was closed during the capture.',
  minimized: 'The window was minimised, so the capture stopped early.',
  cancelled: 'Capture cancelled. This is the part captured so far.',
  resized: 'The window was resized or moved to another screen, so the capture stopped early.',
  pinch: 'The page is pinch-zoomed. Reset the zoom (pinch out) and capture again.',
  failed: 'Chrome refused to take a screenshot of this page.',
} as const;

let active: CaptureJob | null = null;

export function activeCaptureId(): SessionId | null {
  return active?.id ?? null;
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
  }
}

/** Stop the running capture early (toolbar click during a capture). Returns whether one ran. */
export function cancelCapture(): boolean {
  if (!active) return false;
  active.fail(stop('ABORTED_BY_USER', MESSAGES.cancelled));
  return true;
}

/** True during the first moments of a capture, when a second click is more likely a double-click. */
export function captureJustStarted(ms = 800): boolean {
  return !!active && performance.now() - active.startedAt < ms;
}

class CaptureJob {
  readonly id = newSessionId();
  readonly startedAt = performance.now();
  private readonly ac = new AbortController();
  private stopped: Stop | null = null;
  private session: CaptureSession;
  private readonly slices: SliceMeta[] = [];
  private readonly blobs: Blob[] = [];
  private persist: Promise<void> = Promise.resolve();
  private link: AgentLink | null = null;
  private readonly shooter: Shooter;
  private windowId: number;
  private tabIndex: number;
  private scale = 0;
  private viewportW = 0;
  private estTotal = 1;
  private readonly timings: CaptureTimings;
  private readonly unlisten: (() => void)[] = [];

  constructor(
    private readonly tab: Tab,
    private readonly tabId: number,
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
    await this.save();
    await browser.storage.session.set({ [ACTIVE_CAPTURE_KEY]: this.id });
    void setBadge(this.tabId, '…');
    this.listen();
    try {
      await this.capture();
    } catch (err) {
      this.fail(err instanceof Stop ? err : stop('INTERNAL', `Capture failed: ${errText(err)}`));
    }
    await this.release();
    const tf = performance.now();
    await this.finalize();
    this.timings.finalizeMs = Math.round(performance.now() - tf);
    await browser.storage.session.remove(ACTIVE_CAPTURE_KEY);
    void clearBadge(this.tabId);
    await this.openEditor();
    this.timings.totalMs = Math.round(performance.now() - t0);
    this.timings.status = this.session.status;
    this.timings.slices = this.slices.length;
    await saveTimings(this.timings);
    console.info('[pagesnap] capture', this.timings);
    return this.id;
  }

  // -------------------------------------------------------------------------------------------

  private async capture(): Promise<void> {
    const tp = performance.now();
    const opts = captureOptionsFrom(await getSettings());
    const fileAccess = await browser.extension.isAllowedFileSchemeAccess().catch(() => false);
    const kind = classifyRestrictedUrl(this.session.url, fileAccess);
    try {
      if (testFlags.forceRestricted) throw new InjectError('forced by test');
      this.link = await AgentLink.inject(this.tabId);
    } catch (err) {
      if (err instanceof InjectError) {
        return this.visibleOnly(kind === 'unknown' ? classifyInjectError(err.message) : kind);
      }
      throw err;
    }
    const link = this.link;
    link.onAbort = (code) =>
      this.fail(
        code === 'ABORTED_BY_USER'
          ? stop('ABORTED_BY_USER', MESSAGES.cancelled)
          : stop('TAB_CHANGED', MESSAGES.hidden),
      );
    link.onDisconnect = () => this.fail(stop('TAB_CHANGED', MESSAGES.navigated));

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
    this.estTotal = Math.max(1, prep.estSlices);
    this.session.viewport = { w: prep.viewport.w, h: prep.viewport.h };
    this.session.warnings = prep.warnings.map((c) => warning(c as CaptureWarningCode));
    this.session.progress = { done: 0, total: this.estTotal };
    this.timings.prepareMs = Math.round(performance.now() - tp);
    void this.save();

    const tc = performance.now();
    for (;;) {
      const r = await link.request({ t: 'step' }, 15_000, this.ac.signal);
      this.throwIfStopped();
      if (r.t === 'done') break;
      if (r.t !== 'positioned') throw this.agentError(r);
      await this.shoot(r);
      if (r.last) break;
    }
    this.timings.captureMs = Math.round(performance.now() - tc);
  }

  private async shoot(at: Extract<FromAgent, { t: 'positioned' }>): Promise<void> {
    const dataUrl = await this.shooter.shoot(this.ac.signal);
    // A slice that returns after an abort may show the restored page: drop it.
    this.throwIfStopped();
    await this.checkTab();
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await pngBlobSize(blob);
    const scale = bitmap.w / this.viewportW;
    if (this.scale === 0) this.scale = scale;
    else if (Math.abs(scale - this.scale) / this.scale > 0.005) {
      throw stop('SCALE_CHANGED', MESSAGES.resized);
    }
    this.addSlice(blob, bitmap, { x: at.scrollX, y: at.scrollY }, at.target);
  }

  private addSlice(
    blob: Blob,
    bitmap: { w: number; h: number },
    scroll: { x: number; y: number },
    target: TargetGeometry,
  ): void {
    const index = this.slices.length;
    this.slices.push({ index, scroll, bitmap, target, capturedAt: Date.now() });
    this.blobs.push(blob);
    const starts = this.shooter.starts;
    if (starts.length >= 2) {
      this.timings.frameGapsMs.push(Math.round((starts.at(-1) ?? 0) - (starts.at(-2) ?? 0)));
    }
    this.estTotal = Math.max(this.estTotal, this.slices.length);
    const progress = { done: this.slices.length, total: this.estTotal };
    void setBadge(this.tabId, progressText(progress.done, progress.total));
    // Persist in the background while the agent scrolls to the next position.
    this.persist = this.persist.then(async () => {
      await putSlice({ sessionId: this.id, index, blob });
      this.session.slices = [...this.slices];
      this.session.progress = progress;
      await this.save();
    });
  }

  /** Fallback for pages the agent can't scroll: one visible-area screenshot (01 §3.10). */
  private async visibleOnly(kind: RestrictedKind): Promise<void> {
    const tab = await browser.tabs.get(this.tabId).catch(() => this.tab);
    const zoom = await browser.tabs.getZoom(this.tabId).catch(() => 1);
    let dataUrl: string;
    try {
      await this.checkTab();
      dataUrl = await this.shooter.shoot(this.ac.signal);
    } catch (err) {
      if (err instanceof Stop) throw err;
      console.warn('[pagesnap] visible capture failed', err);
      throw stop('RESTRICTED', restrictedErrorMessage(kind));
    }
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await pngBlobSize(blob);
    const w = (tab.width ?? bitmap.w) / (zoom || 1);
    const h = (tab.height ?? bitmap.h) / (zoom || 1);
    this.viewportW = w;
    this.scale = bitmap.w / w;
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

  private async checkTab(): Promise<void> {
    const [tab, win] = await Promise.all([
      browser.tabs.get(this.tabId).catch(() => null),
      browser.windows.get(this.windowId).catch(() => null),
    ]);
    if (!tab) throw stop('TAB_CHANGED', MESSAGES.closed);
    if (!tab.active || tab.windowId !== this.windowId) throw stop('TAB_CHANGED', MESSAGES.switched);
    if (win?.state === 'minimized') throw stop('TAB_CHANGED', MESSAGES.minimized);
    this.tabIndex = tab.index;
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

  /** Restore the page and stop listening. Never throws. */
  private async release(): Promise<void> {
    for (const off of this.unlisten.splice(0)) off();
    const link = this.link;
    this.link = null;
    if (link?.isOpen) {
      await link.request({ t: 'restore' }, 2000);
      link.close();
    }
    try {
      await this.persist;
    } catch (err) {
      this.fail(stop('INTERNAL', `Couldn’t store the capture: ${errText(err)}`));
    }
  }

  private async finalize(): Promise<void> {
    const s = this.session;
    s.slices = [...this.slices];
    s.dpr = this.scale || 1;
    if (this.slices.length > 0) {
      const sideRuns = await this.sideRuns().catch(() => undefined);
      const built = buildLayout({
        slices: this.slices,
        scale: s.dpr,
        ...(sideRuns && { sideRuns }),
      });
      s.css = built.css;
      s.image = built.image;
      if (heightChanged(this.slices) && !s.warnings.some((w) => w.code === 'HEIGHT_CHANGED')) {
        s.warnings.push(warning('HEIGHT_CHANGED'));
      }
      s.layout = built.layout;
    }
    s.progress = { done: this.slices.length, total: this.slices.length };
    if (this.stopped) {
      s.status = this.slices.length > 0 ? 'partial' : 'error';
      s.error = this.stopped.error;
    } else {
      s.status = this.slices.length > 0 ? 'ready' : 'error';
      s.error =
        this.slices.length > 0 ? null : { code: 'CAPTURE_FAILED', message: MESSAGES.failed };
    }
    await this.save();
  }

  /** For inner-scroller sessions: colour runs of slice 0's last row beside the scroller. */
  private async sideRuns(): Promise<{ left: ColorRun[]; right: ColorRun[] } | undefined> {
    const first = this.slices[0];
    const blob = this.blobs[0];
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

  private async openEditor(): Promise<void> {
    const tab = await browser.tabs.get(this.tabId).catch(() => null);
    const url = editorUrl(this.id);
    // Don't steal focus from a tab the user switched to.
    const activeTab = !!tab?.active;
    try {
      await browser.tabs.create(
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
      await browser.tabs.create({ url });
    }
  }

  private async save(): Promise<void> {
    this.session.updatedAt = Date.now();
    const snapshot = structuredClone(this.session);
    await putSession(snapshot);
    await publishSessionStatus(snapshot);
  }

  private throwIfStopped(): void {
    if (this.stopped) throw this.stopped;
  }

  private agentError(r: FromAgent): Stop {
    if (r.t !== 'error') return stop('INTERNAL', 'Unexpected reply from the page');
    if (r.code === 'SCROLL_JACKED') {
      return stop('SCROLL_JACKED', 'The page fights scrolling, so the capture stopped early.');
    }
    if (r.detail === 'disconnected') return stop('TAB_CHANGED', MESSAGES.navigated);
    return stop('INTERNAL', `The page stopped responding (${r.detail ?? r.code}).`);
  }
}

/** The page's content height moved by more than a couple of px between slices (lazy content). */
export function heightChanged(slices: readonly SliceMeta[]): boolean {
  const hs = slices.map((sl) => sl.target.content.h);
  return hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 2;
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/**
 * On SW start: a capture that was running when the SW died can never finish. Mark it
 * `INTERRUPTED` (partial if it has slices) so the editor can still open it.
 */
export async function recoverInterrupted(): Promise<void> {
  const got = await browser.storage.session.get(ACTIVE_CAPTURE_KEY);
  const id = got[ACTIVE_CAPTURE_KEY] as SessionId | undefined;
  if (!id || id === active?.id) return;
  await markInterrupted(id);
  await browser.storage.session.remove(ACTIVE_CAPTURE_KEY);
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
    // `dpr` is only written at the end: derive the scale from the first slice.
    const scale = s.viewport.w ? first.bitmap.w / s.viewport.w : 1;
    const built = buildLayout({ slices: s.slices, scale });
    next = { ...next, status: 'partial', dpr: scale, ...built };
  }
  await putSession(next);
  await publishSessionStatus(next);
}
