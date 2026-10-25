/**
 * Test support: build a fake but realistic finished capture session (slices + layout) without a
 * real page, and store it in IndexedDB. Lets the editor (B, C) and e2e tests run without the
 * capture engine. Exposed in e2e builds as `__pagesnap.seedSyntheticSession()` on the SW.
 *
 * The content mimics `tests/fixtures/pages/bands.html`: horizontal bands `BAND_CSS` px tall in
 * `bandColor(i)` with a label, so pixel assertions can check placement.
 *
 * Needs `OffscreenCanvas` (SW, pages, workers, Vitest browser mode). No `browser` API use.
 */

import { putSession, putSlice } from '../db';
import { newSessionId } from '../ids';
import type { CaptureSession, Placement, SessionId, SliceMeta } from '../types';

export const BAND_CSS = 500;

const BAND_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#bcf60c',
];

/** Colour of band `i` (0-based, from the top). */
export function bandColor(i: number): string {
  return BAND_COLORS[
    ((i % BAND_COLORS.length) + BAND_COLORS.length) % BAND_COLORS.length
  ] as string;
}

export interface SyntheticOptions {
  /** Page size, CSS px. Default 1280 × 6000. */
  cssW?: number;
  cssH?: number;
  /** Viewport height, CSS px. Default 800. */
  viewportH?: number;
  /** Image px per CSS px. Default 2. */
  dpr?: number;
  title?: string;
  url?: string;
}

/** Create, store and return a `ready` session. */
export async function seedSyntheticSession(opts: SyntheticOptions = {}): Promise<SessionId> {
  const cssW = opts.cssW ?? 1280;
  const cssH = opts.cssH ?? 6000;
  const vh = Math.min(opts.viewportH ?? 800, cssH);
  const dpr = opts.dpr ?? 2;
  const id = newSessionId();
  const now = Date.now();

  // Scroll positions: step vh - 2 (2 px overlap), last slice bottom-aligned.
  const maxY = cssH - vh;
  const ys: number[] = [];
  for (let y = 0; y < maxY; y += vh - 2) ys.push(y);
  if (ys[ys.length - 1] !== maxY) ys.push(maxY);

  const bw = Math.round(cssW * dpr);
  const bh = Math.round(vh * dpr);
  const slices: SliceMeta[] = [];
  const parts: Placement[] = [];
  for (const [index, scrollY] of ys.entries()) {
    const blob = await renderSlice(cssW, vh, dpr, scrollY);
    await putSlice({ sessionId: id, index, blob });
    slices.push({
      index,
      scroll: { x: 0, y: scrollY },
      bitmap: { w: bw, h: bh },
      target: {
        kind: 'document',
        clientRect: { x: 0, y: 0, w: cssW, h: vh },
        range: { x0: 0, x1: 0, y0: 0, y1: maxY },
        content: { w: cssW, h: cssH },
      },
      capturedAt: now,
    });
    parts.push({
      slice: index,
      src: { x: 0, y: 0, w: bw, h: bh },
      dest: { x: 0, y: Math.round(scrollY * dpr) },
    });
  }

  const image = { w: bw, h: Math.round(cssH * dpr) };
  const session: CaptureSession = {
    v: 1,
    id,
    url: opts.url ?? 'http://localhost/synthetic.html',
    title: opts.title ?? 'Synthetic bands',
    createdAt: now,
    updatedAt: now,
    mode: 'full',
    status: 'ready',
    error: null,
    warnings: [],
    progress: { done: slices.length, total: slices.length },
    viewport: { w: cssW, h: vh },
    dpr,
    css: { w: cssW, h: cssH },
    image,
    slices,
    layout: { size: image, background: '#ffffff', fills: [], parts },
  };
  await putSession(session);
  return id;
}

async function renderSlice(cssW: number, vh: number, dpr: number, scrollY: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(Math.round(cssW * dpr), Math.round(vh * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context');
  ctx.scale(dpr, dpr);
  ctx.translate(0, -scrollY);
  const first = Math.floor(scrollY / BAND_CSS);
  const last = Math.floor((scrollY + vh) / BAND_CSS);
  for (let i = first; i <= last; i++) {
    ctx.fillStyle = bandColor(i);
    ctx.fillRect(0, i * BAND_CSS, cssW, BAND_CSS);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.fillText(`Band ${i} · y=${i * BAND_CSS}`, 24, i * BAND_CSS + 48);
  }
  return canvas.convertToBlob({ type: 'image/png' });
}
