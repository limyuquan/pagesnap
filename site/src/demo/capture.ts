/**
 * The demo's "capture": the same scroll-and-stitch result the extension produces, written to the
 * same IndexedDB schema (`@/shared/db`), so the real editor engine opens it exactly as it opens a
 * capture made in Chrome.
 *
 * The extension scrolls the tab and calls `captureVisibleTab` for each viewport. Here the "tab" is
 * a pre-rendered image of a fictional page, so each slice is that viewport cut from the image. The
 * pacing follows the extension's limiter (Chrome allows about two screenshots a second).
 */
import { deleteAllSessions, deleteSession, putSession, putSlice } from '@/shared/db';
import { newSessionId } from '@/shared/ids';
import type { CaptureSession, Placement, SessionId, SliceMeta } from '@/shared/types';
import type { PageLayout } from './page';

export interface SliceInfo {
  i: number;
  /** Top of the slice, page CSS px. */
  y: number;
  /** Height, page CSS px. */
  h: number;
}

export interface CaptureProgress {
  phase: 'preparing' | 'capturing' | 'stitching' | 'opening';
  done: number;
  total: number;
  slices: readonly SliceInfo[];
  /** Measured time between slices, ms (null until two have landed). */
  cadenceMs: number | null;
  /** `performance.now()` of the newest slice. */
  lastSliceAt: number;
}

export interface CaptureOptions {
  page: PageLayout;
  /** Visible height of the fake tab, page CSS px. */
  viewportCss: number;
  /** Scroll the fake tab to `y` (page CSS px): the extension scrolls the real tab. */
  scrollTo(y: number): void;
  onProgress(p: CaptureProgress): void;
  signal: AbortSignal;
  /** Minimum time between screenshots, ms. The extension's limiter uses about 530. */
  gapMs?: number;
  /** Let a scrolled page settle before the screenshot, ms. */
  settleMs?: number;
}

const decoded = new Map<string, Promise<ImageBitmap>>();

/** Decode the page image once (it is reused for every capture and for the thumbnails). */
export function pageBitmap(src: string): Promise<ImageBitmap> {
  let p = decoded.get(src);
  if (!p) {
    p = fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`Couldn’t load the demo page (${r.status})`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b));
    decoded.set(src, p);
    p.catch(() => decoded.delete(src));
  }
  return p;
}

/** Scroll positions: one viewport at a time, the last one bottom-aligned (like the extension). */
export function planSlices(pageH: number, vh: number): SliceInfo[] {
  const h = Math.max(1, Math.min(Math.round(vh), pageH));
  const maxY = pageH - h;
  const out: SliceInfo[] = [];
  for (let y = 0; y < maxY; y += h) out.push({ i: out.length, y, h });
  if (out.length === 0 || out[out.length - 1]?.y !== maxY) out.push({ i: out.length, y: maxY, h });
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Forget earlier demo captures (they live in this site's own IndexedDB). */
export async function clearDemoCaptures(): Promise<void> {
  try {
    await deleteAllSessions();
  } catch {
    // Private mode without IndexedDB: the capture itself reports the problem.
  }
}

export async function runCapture(opts: CaptureOptions): Promise<SessionId> {
  const { page, signal } = opts;
  const gap = opts.gapMs ?? 480;
  const settle = opts.settleMs ?? 120;
  const id = newSessionId();
  const dpr = page.dpr;
  const cssW = page.css.w;
  const cssH = page.css.h;
  const slices = planSlices(cssH, opts.viewportCss);
  const progress: CaptureProgress = {
    phase: 'preparing',
    done: 0,
    total: slices.length,
    slices: [],
    cadenceMs: null,
    lastSliceAt: performance.now(),
  };
  const report = () => opts.onProgress({ ...progress, slices: [...progress.slices] });
  report();

  try {
    const [bitmap] = await Promise.all([pageBitmap(page.src), sleep(380, signal)]);
    progress.phase = 'capturing';
    report();

    const bw = Math.round(cssW * dpr);
    const metas: SliceMeta[] = [];
    const parts: Placement[] = [];
    let last = 0;
    for (const s of slices) {
      opts.scrollTo(s.y);
      await sleep(Math.max(settle, last ? gap - (performance.now() - last) : 0), signal);
      const bh = Math.round(s.h * dpr);
      const canvas = new OffscreenCanvas(bw, bh);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D canvas here');
      ctx.drawImage(bitmap, 0, Math.round(s.y * dpr), bw, bh, 0, 0, bw, bh);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      signal.throwIfAborted();
      await putSlice({ sessionId: id, index: s.i, blob });
      const now = performance.now();
      if (last) {
        const d = now - last;
        progress.cadenceMs = progress.cadenceMs == null ? d : progress.cadenceMs * 0.6 + d * 0.4;
      }
      last = now;
      metas.push({
        index: s.i,
        scroll: { x: 0, y: s.y },
        bitmap: { w: bw, h: bh },
        target: {
          kind: 'document',
          clientRect: { x: 0, y: 0, w: cssW, h: s.h },
          range: { x0: 0, x1: 0, y0: 0, y1: cssH - s.h },
          content: { w: cssW, h: cssH },
        },
        capturedAt: Date.now(),
      });
      parts.push({
        slice: s.i,
        src: { x: 0, y: 0, w: bw, h: bh },
        dest: { x: 0, y: Math.round(s.y * dpr) },
      });
      progress.done = s.i + 1;
      progress.slices = [...progress.slices, s];
      progress.lastSliceAt = now;
      report();
    }

    progress.phase = 'stitching';
    report();
    const image = { w: bw, h: Math.round(cssH * dpr) };
    const now = Date.now();
    const session: CaptureSession = {
      v: 1,
      id,
      url: page.url,
      title: page.title,
      createdAt: now,
      updatedAt: now,
      mode: 'full',
      status: 'ready',
      error: null,
      warnings: [],
      progress: { done: slices.length, total: slices.length },
      viewport: { w: cssW, h: Math.round(opts.viewportCss) },
      dpr,
      css: { w: cssW, h: cssH },
      image,
      slices: metas,
      layout: { size: image, background: '#ffffff', fills: [], parts },
    };
    await putSession(session);
    await sleep(260, signal);
    progress.phase = 'opening';
    report();
    await sleep(240, signal);
    return id;
  } catch (err) {
    void deleteSession(id).catch(() => {});
    throw err;
  }
}
