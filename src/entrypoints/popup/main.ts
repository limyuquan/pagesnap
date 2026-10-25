/**
 * The action popup (owner: A): a live view of the capture of its tab. Opening it (toolbar click,
 * Alt+Shift+P, context menu) asks the SW to capture the tab; the SW owns the capture, so closing
 * the popup changes nothing. Esc or Stop cancels. See `capture/popupProtocol.ts`.
 *
 * Vanilla TS on purpose: the skeleton in index.html paints before this runs, and the bundle is a
 * few KB. Testing: `popup.html?tab=<id>` shows the popup for that tab in an ordinary tab.
 */
import { browser } from 'wxt/browser';
import {
  POPUP_PORT_NAME,
  type PopupPhase,
  type PopupSlice,
  type PopupState,
  type PopupToSw,
  type SwToPopup,
} from '@/capture/popupProtocol';
import { getSliceBlob } from '@/shared/db';

const scriptStart = performance.now();

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

const root = document.documentElement;
const ui = {
  phase: el('phase'),
  act: el<HTMLButtonElement>('act'),
  actLabel: el('act-label'),
  pct: el('pct-n'),
  msg: el('msg'),
  title: el('title'),
  host: el('host'),
  bar: el('bar'),
  fill: el('fill'),
  meta: el('meta'),
  film: el('film'),
  ghost: el('ghost'),
  edge: el('edge'),
};
const mini = ui.film.parentElement as HTMLElement;

const params = new URLSearchParams(location.search);
/** `?tab=<id>`: shown in a tab for tests, not as Chrome's popup. */
const testTab = params.has('tab') ? Number(params.get('tab')) : null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Phases that a Stop/Esc can still cancel. */
const CANCELLABLE: ReadonlySet<PopupPhase> = new Set([
  'queued',
  'preparing',
  'capturing',
  'paused',
]);
const FULL: ReadonlySet<PopupPhase> = new Set(['stitching', 'opening', 'done', 'visible']);

let state: PopupState | null = null;
let stopping = false;
let closed = false;

// ------------------------------------------------------------------------------------- port

const port = browser.runtime.connect({ name: POPUP_PORT_NAME });
const post = (msg: PopupToSw) => {
  try {
    port.postMessage(msg);
  } catch {
    // The SW went away; the disconnect handler explains.
  }
};
port.onMessage.addListener((msg: SwToPopup) => {
  if (msg.t === 'state') apply(msg.state);
});
port.onDisconnect.addListener(() => {
  if (closed || (state && !CANCELLABLE.has(state.phase))) return;
  apply({
    ...(state ?? blankState(-1)),
    phase: 'failed',
    code: 'INTERRUPTED',
    message: 'Page Snap stopped responding. Click it again to retry.',
  });
});

void (async () => {
  const tab =
    testTab != null
      ? await browser.tabs.get(testTab).catch(() => null)
      : ((await browser.tabs.query({ active: true, currentWindow: true }))[0] ?? null);
  if (tab?.id == null) {
    apply({
      ...blankState(-1),
      phase: 'failed',
      message: 'There’s no tab to capture in this window.',
    });
    return;
  }
  // Show the tab before the SW answers (activeTab makes its title readable).
  if (!state) setPage(tab.title ?? '', tab.url ?? '');
  post({ t: 'open', tabId: tab.id });
})();

function blankState(tabId: number): PopupState {
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

// ------------------------------------------------------------------------------------- state

/** `performance.now()` when the newest slice landed (drives the bar's creep and the ETA). */
let sliceAt = performance.now();
/** `done` when `total` last changed: the ETA waits until the estimate has held for a while. */
let totalSince = 0;

function apply(next: PopupState): void {
  const prev = state;
  state = next;
  if (prev?.sessionId !== next.sessionId) resetFilm();
  if (next.done !== prev?.done && next.lastSliceAt > 0) {
    sliceAt = performance.now() - Math.max(0, Date.now() - next.lastSliceAt);
  }
  if (next.total !== prev?.total) totalSince = next.done;
  if (!CANCELLABLE.has(next.phase)) stopping = false;
  render();
  syncFilm();
  kick();
  if (next.phase === 'done') close();
  else if (next.phase === 'failed' && next.code === 'ABORTED_BY_USER') setTimeout(close, 1100);
}

function render(): void {
  const s = state ?? blankState(-1);
  root.dataset.phase = s.phase;
  if (s.title || s.url) setPage(s.title, s.url);
  const total = Math.max(s.total, s.done);
  let phase = '';
  let meta = '';
  let msg = '';
  switch (s.phase) {
    case 'queued':
      phase = 'Waiting for the other capture…';
      meta = 'Starts as soon as it finishes';
      break;
    case 'preparing':
      phase = 'Preparing the page…';
      break;
    case 'capturing':
      phase = 'Capturing';
      meta = captureLine(s, performance.now());
      break;
    case 'paused':
      phase = 'Paused';
      meta = 'Bring the tab back to continue';
      break;
    case 'stitching':
      phase = 'Stitching…';
      meta = sizeLine(s);
      break;
    case 'opening':
    case 'done':
      phase = 'Opening editor';
      meta = sizeLine(s);
      break;
    case 'stopped':
      phase = 'Stopped · opening what was captured';
      meta =
        s.code === 'ABORTED_BY_USER' || !s.message
          ? `Kept ${s.done} of ${total} ${plural(total, 'slice')}`
          : s.message;
      break;
    case 'visible':
      phase = 'Only the visible area';
      msg = s.message ?? 'This page can’t be scrolled by extensions.';
      meta = 'Opening the editor';
      break;
    case 'failed':
      if (s.code === 'ABORTED_BY_USER') {
        phase = 'Stopped';
        msg = 'Nothing was captured yet.';
      } else {
        phase = 'Can’t capture this page';
        msg = s.message ?? 'Chrome didn’t allow a screenshot of this page.';
      }
      break;
  }
  if (stopping && CANCELLABLE.has(s.phase)) phase = 'Stopping…';
  setText(ui.phase, phase);
  setText(ui.meta, meta || ' ');
  setText(ui.msg, msg);
  const cancellable = CANCELLABLE.has(s.phase) && !stopping;
  setText(ui.actLabel, s.phase === 'failed' ? 'Close' : 'Stop');
  ui.act.toggleAttribute('data-off', !cancellable);
  ui.act.setAttribute('aria-label', s.phase === 'failed' ? 'Close' : 'Stop capture');
  ui.bar.setAttribute('aria-valuenow', String(Math.round(fraction(s) * 100)));
}

function sliceLine(s: PopupState): string {
  const total = Math.max(s.total, s.done, 1);
  return `Slice ${Math.min(s.done + 1, total)} of ${total}`;
}

/** "Slice 7 of 12 · about 3 s left". */
function captureLine(s: PopupState, now: number): string {
  etaAt = now;
  const eta = etaText(s, now);
  return eta ? `${sliceLine(s)} · ${eta}` : sliceLine(s);
}

function sizeLine(s: PopupState): string {
  const n = s.slices.length || s.done;
  const tall = s.page ? ` · ${Math.round(s.page.h).toLocaleString('en-US')} px tall` : '';
  return `${n} ${plural(n, 'slice')}${tall}`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setPage(title: string, url: string): void {
  setText(ui.title, title || hostOf(url) || 'Untitled page');
  setText(ui.host, hostOf(url) || ' ');
  ui.title.title = title;
}

function hostOf(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'Local file';
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host.replace(/^www\./, '');
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------------------- progress bar

/** Where the bar is heading: stored slices, plus a creep toward the next one between updates. */
function fraction(s: PopupState, now = performance.now()): number {
  if (FULL.has(s.phase)) return 1;
  const total = Math.max(s.total, s.done);
  if (total <= 0) return 0;
  let f = s.done / total;
  if (s.phase === 'capturing' && !stopping && s.done < total && !reducedMotion.matches) {
    const cadence = s.cadenceMs ?? 560;
    const t = Math.min(1, (now - sliceAt) / cadence);
    // Ease out toward 85% of the next slice: never past it, never a visible stall.
    f += (0.85 * (1 - (1 - t) * (1 - t))) / total;
  }
  return Math.min(f, 0.995);
}

let shown = 0;
let lastFrame = 0;
let raf = 0;
let shownPct = -1;
let etaSecs: number | null = null;
let etaAt = 0;

function kick(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now: number): void {
  raf = 0;
  const s = state;
  if (!s) return;
  const target = fraction(s, now);
  const dt = Math.min(64, lastFrame ? now - lastFrame : 16);
  lastFrame = now;
  if (reducedMotion.matches) shown = target;
  else shown += (target - shown) * (1 - Math.exp(-dt / 110));
  if (Math.abs(target - shown) < 0.0005) shown = target;
  ui.fill.style.transform = `scaleX(${shown.toFixed(4)})`;
  const pct = FULL.has(s.phase) && shown >= 0.995 ? 100 : Math.min(99, Math.floor(shown * 100));
  if (pct !== shownPct) {
    shownPct = pct;
    ui.pct.textContent = String(pct);
    root.dataset.pct = String(pct);
  }
  if (s.phase === 'capturing' && now - etaAt > 250) setText(ui.meta, captureLine(s, now));
  const settling = shown !== target || (s.phase === 'capturing' && !stopping);
  if (settling && !closed) kick();
  else lastFrame = 0;
}

/**
 * "about 3 s left", from the measured cadence. Only once it means something: a cadence over a
 * few shots and a slice estimate that held for two slices. It never ticks up by one second from
 * jitter.
 */
function etaText(s: PopupState, now: number): string | null {
  const cadence = s.cadenceMs;
  const total = Math.max(s.total, s.done);
  if (cadence == null || s.done < 3 || s.done - totalSince < 2 || stopping) {
    etaSecs = null;
    return null;
  }
  const remaining = (total - s.done) * cadence - Math.min(cadence, now - sliceAt) + 250;
  if (remaining < 600) return etaSecs != null ? 'almost done' : null;
  let secs = Math.ceil(remaining / 1000);
  if (etaSecs != null && secs === etaSecs + 1) secs = etaSecs;
  etaSecs = secs;
  if (secs >= 60) return `about ${Math.round(secs / 60)} min left`;
  return `about ${secs} s left`;
}

// ---------------------------------------------------------------------------------- miniature

const MINI_W = 52;
interface Thumb {
  v: number;
  node: HTMLCanvasElement | null;
}
const thumbs = new Map<number, Thumb>();
const queue: PopupSlice[] = [];
let loading = 0;
let filmScale = 0;
let filmSession: string | null = null;

function resetFilm(): void {
  for (const t of thumbs.values()) t.node?.remove();
  thumbs.clear();
  queue.length = 0;
  filmSession = state?.sessionId ?? null;
  ui.film.style.transform = '';
  ui.edge.style.transform = '';
}

function syncFilm(): void {
  const s = state;
  if (!s?.page || !s.sessionId) {
    ui.ghost.style.height = '0';
    return;
  }
  const scale = MINI_W / Math.max(1, s.page.w);
  const filmH = s.page.h * scale;
  ui.ghost.style.height = `${filmH.toFixed(1)}px`;
  if (scale !== filmScale) {
    filmScale = scale;
    for (const sl of s.slices) place(thumbs.get(sl.i)?.node ?? null, sl);
  }
  for (const sl of s.slices) {
    const have = thumbs.get(sl.i);
    if (have && have.v === sl.v) continue;
    thumbs.set(sl.i, { v: sl.v, node: have?.node ?? null });
    queue.push(sl);
  }
  pump();
  // The developing edge sits at the bottom of the lowest slice; tall pages scroll to keep it in view.
  let edge = 0;
  for (const sl of s.slices) edge = Math.max(edge, (sl.y + sl.h) * scale);
  const viewH = mini.clientHeight;
  const offset = filmH > viewH ? Math.max(0, Math.min(edge - viewH * 0.72, filmH - viewH)) : 0;
  ui.film.style.transform = offset ? `translateY(${(-offset).toFixed(1)}px)` : '';
  mini.toggleAttribute('data-scrolled', offset > 0.5);
  ui.edge.style.transform = `translateY(${edge.toFixed(1)}px)`;
  root.dataset.thumbs = String([...thumbs.values()].filter((t) => t.node).length);
}

function place(node: HTMLCanvasElement | null, sl: PopupSlice): void {
  if (!node) return;
  const k = filmScale;
  node.style.left = `${(sl.x * k).toFixed(2)}px`;
  node.style.top = `${(sl.y * k).toFixed(2)}px`;
  node.style.width = `${(sl.w * k).toFixed(2)}px`;
  node.style.height = `${(sl.h * k).toFixed(2)}px`;
  node.style.zIndex = String(sl.i + 1);
}

/** Two decodes at a time; each slice PNG is decoded straight to thumbnail size. */
function pump(): void {
  while (loading < 2 && queue.length) {
    const sl = queue.shift() as PopupSlice;
    const session = filmSession;
    if (!session) return;
    loading++;
    void loadThumb(session, sl).finally(() => {
      loading--;
      pump();
    });
  }
}

async function loadThumb(session: string, sl: PopupSlice): Promise<void> {
  try {
    const blob = await getSliceBlob(session, sl.i);
    const dpr = Math.min(3, devicePixelRatio || 1);
    const k = filmScale || MINI_W / Math.max(1, sl.w);
    const bmp = await createImageBitmap(blob, sl.crop.x, sl.crop.y, sl.crop.w, sl.crop.h, {
      resizeWidth: Math.max(1, Math.round(sl.w * k * dpr)),
      resizeHeight: Math.max(1, Math.round(sl.h * k * dpr)),
      resizeQuality: 'medium',
    });
    const want = thumbs.get(sl.i);
    if (session !== filmSession || !want || want.v !== sl.v) {
      bmp.close();
      return;
    }
    const node = document.createElement('canvas');
    node.width = bmp.width;
    node.height = bmp.height;
    const ctx = node.getContext('bitmaprenderer');
    if (ctx) ctx.transferFromImageBitmap(bmp);
    else bmp.close();
    place(node, sl);
    // A retake replaces the old thumbnail in place, without the developing fade.
    if (want.node) {
      node.style.animation = 'none';
      want.node.replaceWith(node);
    } else ui.film.insertBefore(node, ui.edge);
    want.node = node;
    root.dataset.thumbs = String([...thumbs.values()].filter((t) => t.node).length);
  } catch (err) {
    // A missing slice (pruned, failed write) just stays undeveloped.
    console.debug('[pagesnap] thumbnail', sl.i, err);
  }
}

// ---------------------------------------------------------------------------------- actions

function cancel(how: 'esc' | 'button'): void {
  if (!state || !CANCELLABLE.has(state.phase) || stopping) return;
  stopping = true;
  post({ t: 'cancel', how });
  render();
}

function close(): void {
  if (closed) return;
  closed = true;
  window.close();
  // In a test tab `window.close()` may be refused: close the tab instead.
  if (testTab != null) {
    void browser.tabs
      .getCurrent()
      .then((t) => (t?.id != null ? browser.tabs.remove(t.id) : undefined))
      .catch(() => {});
  }
}

ui.act.addEventListener('click', () => {
  if (state?.phase === 'failed') close();
  else cancel('button');
});

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Chrome closes a popup on Esc by itself; we decide instead.
  e.preventDefault();
  if (!state || state.phase === 'failed') close();
  else if (CANCELLABLE.has(state.phase)) cancel('esc');
});

reducedMotion.addEventListener('change', kick);

// ------------------------------------------------------------------------------------- perf

let firstFrame = 0;
requestAnimationFrame(() => {
  firstFrame = performance.now();
  const send = (fcp: number | null) =>
    post({ t: 'perf', fcp, firstFrame, openedAt: performance.timeOrigin });
  const paint = performance.getEntriesByName('first-contentful-paint')[0];
  if (paint) return send(paint.startTime);
  let sent = false;
  const obs = new PerformanceObserver((list) => {
    const e = list.getEntriesByName('first-contentful-paint')[0];
    if (!e || sent) return;
    sent = true;
    obs.disconnect();
    send(e.startTime);
  });
  obs.observe({ type: 'paint', buffered: true });
  setTimeout(() => {
    if (sent) return;
    sent = true;
    obs.disconnect();
    send(null);
  }, 500);
});
console.debug('[pagesnap] popup script', Math.round(scriptStart), 'ms');
