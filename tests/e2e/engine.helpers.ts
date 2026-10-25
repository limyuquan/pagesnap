/**
 * Helpers for agent B's e2e specs (editor engine). Not a spec file.
 */
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect } from './fixtures';

export interface EngineSnapshot {
  shapes: { id: string; kind: string; color: string; [k: string]: unknown }[];
  rev: number;
  selection: string[];
  tool: string;
  editingTextId: string | null;
  camera: { x: number; y: number; zoom: number };
  viewport: { w: number; h: number };
  canUndo: boolean;
  canRedo: boolean;
  copy: { state: string; outcome?: string; size?: { w: number; h: number }; tall?: boolean };
  image: { w: number; h: number };
  dpr: number;
}

export async function waitReady(ed: Page): Promise<void> {
  await expect
    .poll(() => ed.evaluate(() => window.__pagesnapTest?.isReady() ?? false), { timeout: 20_000 })
    .toBe(true);
}

export function snapshot(ed: Page): Promise<EngineSnapshot> {
  return ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const s = (window as any).__pagesnapEngine.state();
    return {
      shapes: s.doc?.shapes ?? [],
      rev: s.doc?.rev ?? -1,
      selection: [...s.selection],
      tool: s.tool,
      editingTextId: s.editingTextId,
      camera: s.camera,
      viewport: s.viewport,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      copy: s.copy,
      image: s.session?.image ?? { w: 0, h: 0 },
      dpr: s.session?.dpr ?? 1,
    };
  });
}

/** Page coordinates (CSS px) of an image-px point under the current camera. */
export async function toPage(ed: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await ed.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('canvas not visible');
  const s = await snapshot(ed);
  return {
    x: box.x + (x - s.camera.x) * s.camera.zoom,
    y: box.y + (y - s.camera.y) * s.camera.zoom,
  };
}

/** Drag between two image-px points with the mouse. */
export async function dragImage(
  ed: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; shift?: boolean } = {},
): Promise<void> {
  const a = await toPage(ed, from.x, from.y);
  const b = await toPage(ed, to.x, to.y);
  if (opts.shift) await ed.keyboard.down('Shift');
  await ed.mouse.move(a.x, a.y);
  await ed.mouse.down();
  await ed.mouse.move(b.x, b.y, { steps: opts.steps ?? 8 });
  await ed.mouse.up();
  if (opts.shift) await ed.keyboard.up('Shift');
}

export async function clickImage(ed: Page, p: { x: number; y: number }, clickCount = 1) {
  const q = await toPage(ed, p.x, p.y);
  await ed.mouse.click(q.x, q.y, { clickCount });
}

export function decodePng(base64OrBuf: string | Buffer): PNG {
  const buf = typeof base64OrBuf === 'string' ? Buffer.from(base64OrBuf, 'base64') : base64OrBuf;
  return PNG.sync.read(buf);
}

export function pixel(png: PNG, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function near(a: readonly number[], b: readonly number[], tol = 6): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);
}

/** Count pixels close to `rgb` inside a rect. */
export function countColor(
  png: PNG,
  rgb: readonly number[],
  rect = { x: 0, y: 0, w: png.width, h: png.height },
  tol = 6,
): number {
  let n = 0;
  for (let y = Math.max(0, rect.y); y < Math.min(png.height, rect.y + rect.h); y++) {
    for (let x = Math.max(0, rect.x); x < Math.min(png.width, rect.x + rect.w); x++) {
      if (near(pixel(png, x, y), rgb, tol)) n++;
    }
  }
  return n;
}

/** Native-resolution export of the current doc through the e2e hook. */
export async function exportPng(ed: Page, scope: 'default' | 'full'): Promise<PNG> {
  const b64 = await ed.evaluate((s) => {
    if (!window.__pagesnapTest) throw new Error('no hook');
    return window.__pagesnapTest.exportPng(s);
  }, scope);
  return decodePng(b64);
}

/**
 * Read the clipboard's image/png from `reader`, a page on the fixture origin with clipboard-read
 * granted (Chromium refuses to grant it to chrome-extension:// origins; the clipboard itself is
 * browser-wide, so any focused page can read what the editor wrote).
 */
export async function readClipboardPng(reader: Page): Promise<PNG> {
  await reader.bringToFront();
  const b64 = await reader.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item)
      throw new Error(`no image/png on the clipboard: ${items.map((i) => i.types).join()}`);
    const buf = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return decodePng(b64);
}
