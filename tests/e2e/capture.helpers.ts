/**
 * Helpers for agent A's capture e2e specs (`capture.*.spec.ts`). They use the A-owned SW hook
 * `__pagesnapCapture` (e2e builds only) to read sessions and composite pixels with the same
 * `compositeRegion` the editor and export use.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { PNG } from 'pngjs';
// Type import so this program sees the `__pagesnapCapture` global declaration.
import type {} from '@/capture/testHook';
import type { CaptureTimings } from '@/capture/timings';
import type { CaptureSession, Rect } from '@/shared/types';
import type { PagesnapHelpers } from './fixtures';

export interface Img {
  width: number;
  height: number;
  /** `#rrggbb` at integer pixel (x, y). */
  hex(x: number, y: number): string;
  rgb(x: number, y: number): [number, number, number];
}

export function decodePng(base64: string): Img {
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const rgb = (x: number, y: number): [number, number, number] => {
    const xi = Math.min(png.width - 1, Math.max(0, Math.floor(x)));
    const yi = Math.min(png.height - 1, Math.max(0, Math.floor(y)));
    const i = (yi * png.width + xi) * 4;
    return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
  };
  return {
    width: png.width,
    height: png.height,
    rgb,
    hex: (x, y) =>
      `#${rgb(x, y)
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`,
  };
}

/** Colours equal within `tol` per channel. */
export function near(a: string, b: string, tol = 8): boolean {
  const pa = parse(a);
  const pb = parse(b);
  return pa.every((v, i) => Math.abs(v - (pb[i] ?? 0)) <= tol);
}

function parse(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

export async function getSession(sw: Worker, id: string): Promise<CaptureSession> {
  const s = await sw.evaluate((sid) => globalThis.__pagesnapCapture?.session(sid) ?? null, id);
  if (!s) throw new Error(`No session ${id}`);
  return s;
}

export async function getTimings(sw: Worker, id: string): Promise<CaptureTimings | null> {
  return sw.evaluate((sid) => globalThis.__pagesnapCapture?.timings(sid) ?? null, id);
}

/** The stitched base image (or a region of it, image px) at `scale`. */
export async function stitched(sw: Worker, id: string, region?: Rect, scale = 1): Promise<Img> {
  const b64 = await sw.evaluate(
    ([sid, r, s]) => {
      const hook = globalThis.__pagesnapCapture;
      if (!hook) throw new Error('__pagesnapCapture hook missing');
      return hook.compositePng(sid, r ?? undefined, s);
    },
    [id, region ?? null, scale] as const,
  );
  return decodePng(b64);
}

/** Where `dump` writes PNGs when `PAGESNAP_DUMP=1`. */
export const DUMP_DIR = '/tmp/pagesnap-qa/capture';

/** With `PAGESNAP_DUMP=1`, save the stitched image (at `scale`) as `<DUMP_DIR>/<name>.png`. */
export async function dump(sw: Worker, id: string, name: string, scale = 0.5): Promise<void> {
  if (!process.env.PAGESNAP_DUMP) return;
  await savePng(sw, id, path.join(DUMP_DIR, `${name}.png`), scale);
}

/** Save the stitched image at `scale`, split into parts at most `partOutH` output px tall. */
export async function savePng(
  sw: Worker,
  id: string,
  file: string,
  scale: number,
  partOutH = 16_000,
): Promise<string[]> {
  const session = await getSession(sw, id);
  mkdirSync(path.dirname(file), { recursive: true });
  const partH = Math.floor(partOutH / scale);
  const files: string[] = [];
  for (let y = 0, n = 0; y < session.image.h; y += partH, n++) {
    const h = Math.min(partH, session.image.h - y);
    const b64 = await sw.evaluate(
      ([sid, r, s]) => globalThis.__pagesnapCapture?.compositePng(sid, r, s) ?? '',
      [id, { x: 0, y, w: session.image.w, h }, scale] as const,
    );
    const out = session.image.h > partH ? file.replace(/\.png$/, `.part${n + 1}.png`) : file;
    writeFileSync(out, Buffer.from(b64, 'base64'));
    files.push(out);
  }
  return files;
}

export async function tile(sw: Worker, id: string, index: number): Promise<Img> {
  const b64 = await sw.evaluate(
    ([sid, i]) => {
      const hook = globalThis.__pagesnapCapture;
      if (!hook) throw new Error('__pagesnapCapture hook missing');
      return hook.tilePng(sid, i);
    },
    [id, index] as const,
  );
  return decodePng(b64);
}

/** Capture `page` and return the final session, its timings and the editor page. */
export async function captureFull(pagesnap: PagesnapHelpers, sw: Worker, page: Page) {
  const t0 = Date.now();
  const { sessionId, editor } = await pagesnap.capture(page);
  const wallMs = Date.now() - t0;
  const session = await getSession(sw, sessionId);
  const timings = await getTimings(sw, sessionId);
  if (session.status !== 'ready') {
    console.log(`[capture ${session.status}] ${JSON.stringify({ error: session.error, timings })}`);
  }
  return { sessionId, editor, session, timings, wallMs };
}

/** Start a capture without waiting for it (for abort tests). */
export async function startCaptureAsync(sw: Worker, tabId: number): Promise<void> {
  await sw.evaluate((id) => {
    void globalThis.__pagesnap?.startCapture(id).catch(() => {});
  }, tabId);
}

/** Wait until the running capture has stored at least `n` slices; returns its id. */
export async function waitForSlices(sw: Worker, n: number, timeoutMs = 20_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const state = await sw.evaluate(async () => {
      const hook = globalThis.__pagesnapCapture;
      const id = hook?.activeId();
      if (!hook || !id) return null;
      const s = await hook.session(id);
      return s ? { id, done: s.progress.done } : null;
    });
    if (state && state.done >= n) return state.id;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Capture didn't reach ${n} slices`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Wait for a session to reach a final status. */
export async function waitForFinal(sw: Worker, id: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await getSession(sw, id);
    if (s.status !== 'capturing') return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Session ${id} never finished`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Snapshot of everything the capture might leave behind in the page. */
export async function pageState(page: Page) {
  return page.evaluate(() => ({
    scrollX,
    scrollY,
    styleTags: document.querySelectorAll('style').length,
    pagesnapNodes: document.querySelectorAll('[data-pagesnap]').length,
    styledElements: [...document.querySelectorAll('[style]')].map(
      (el) => `${el.tagName}#${el.id}.${el.className}:${el.getAttribute('style')}`,
    ),
    htmlStyle: getComputedStyle(document.documentElement).scrollbarWidth,
  }));
}
