/**
 * End-to-end flow helpers (`flow.*.spec.ts`). No synthetic sessions: a fixture page is captured
 * through the toolbar button's own listener, the editor tab that the capture opens is driven with
 * the mouse and keyboard, and the results are read back from the system clipboard, the download
 * and the original tab.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { PNG } from 'pngjs';
import { DEFAULT_HIGHLIGHT_COLOR, DEFAULT_HIGHLIGHT_OPACITY } from '@/shared/annotations';
import type { CaptureSession, Rect } from '@/shared/types';
import { getSession, pageState, stitched } from './capture.helpers';
import {
  clickImage,
  countColor,
  decodePng,
  dragImage,
  hexToRgb,
  near,
  pixel,
  readClipboardPng,
  snapshot,
  waitReady,
} from './engine.helpers';
import { expect, type PagesnapHelpers } from './fixtures';

export const RED = hexToRgb('#FF3B30');
export const YELLOW = hexToRgb(DEFAULT_HIGHLIGHT_COLOR);

export interface ShapeBox {
  kind: string;
  /** Image px. */
  box: Rect;
}

export interface CopyResult {
  png: PNG;
  plan: { outcome: string; region: Rect; scale: number; size: { w: number; h: number } };
  /** The un-annotated base pixels for the same region and scale (`compositeRegion`). */
  base: { width: number; height: number; rgb(x: number, y: number): [number, number, number] };
  ms: number;
  cacheHit: boolean;
}

export interface Captured {
  page: Page;
  editor: Page;
  sessionId: string;
  session: CaptureSession;
  /** What the original tab looked like before the capture. */
  before: Awaited<ReturnType<typeof pageState>> & { innerScrollTop: number | null };
}

/** `pageState` plus the inner scroller's position (inner-scroller fixture). */
export async function fullPageState(page: Page) {
  const s = await pageState(page);
  const innerScrollTop = await page.evaluate(
    () => document.querySelector<HTMLElement>('#content')?.scrollTop ?? null,
  );
  return { ...s, innerScrollTop };
}

/**
 * Open `fixture`, run `prepare` (scroll it somewhere), then capture it exactly like a toolbar
 * click and wait until the editor has pixels on screen.
 */
export async function captureFixture(
  pagesnap: PagesnapHelpers,
  sw: Worker,
  fixture: string,
  prepare?: (page: Page) => Promise<void>,
): Promise<Captured> {
  const page = await pagesnap.openFixture(fixture);
  if (prepare) await prepare(page);
  const before = await fullPageState(page);
  const { sessionId, editor } = await pagesnap.capture(page, { via: 'click' });
  await waitReady(editor);
  const session = await getSession(sw, sessionId);
  return { page, editor, sessionId, session, before };
}

/** Grant clipboard access to the fixture origin, so `page` can read what the editor copied. */
export async function allowClipboard(context: BrowserContext, page: Page): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
}

/** The part of the image currently on screen (image px). */
export async function visibleImageRect(ed: Page): Promise<Rect> {
  const s = await snapshot(ed);
  const x0 = Math.max(0, s.camera.x);
  const y0 = Math.max(0, s.camera.y);
  const x1 = Math.min(s.image.w, s.camera.x + s.viewport.w / s.camera.zoom);
  const y1 = Math.min(s.image.h, s.camera.y + s.viewport.h / s.camera.zoom);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Pan the editor with the mouse wheel (trackpad-style) by about `cssDy` screen px. */
export async function wheelBy(ed: Page, cssDy: number): Promise<void> {
  const box = await ed.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('canvas not visible');
  await ed.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const step = 100;
  for (let d = 0; Math.abs(d) < Math.abs(cssDy); d += Math.sign(cssDy) * step) {
    await ed.mouse.wheel(0, Math.sign(cssDy) * step);
  }
  await ed.waitForTimeout(150);
}

const at = (v: Rect, fx: number, fy: number) => ({ x: v.x + v.w * fx, y: v.y + v.h * fy });

/**
 * Draw one of every v0.1 tool inside the visible part of the image with the mouse: arrow
 * (already armed), rect, underline, highlight, pen and text. Returns each shape's kind.
 */
export async function drawEveryTool(ed: Page, text = 'Check this'): Promise<void> {
  const v = await visibleImageRect(ed);
  expect((await snapshot(ed)).tool).toBe('arrow');
  await dragImage(ed, at(v, 0.1, 0.12), at(v, 0.34, 0.34));
  await ed.keyboard.press('r');
  await dragImage(ed, at(v, 0.44, 0.1), at(v, 0.7, 0.34));
  await ed.keyboard.press('u');
  await dragImage(ed, at(v, 0.1, 0.48), at(v, 0.4, 0.48));
  await ed.keyboard.press('h');
  await dragImage(ed, at(v, 0.1, 0.6), at(v, 0.45, 0.6));
  await ed.keyboard.press('p');
  const p0 = await toPageXY(ed, at(v, 0.55, 0.46));
  await ed.mouse.move(p0.x, p0.y);
  await ed.mouse.down();
  for (let i = 1; i <= 24; i++) {
    const q = at(v, 0.55 + (0.3 * i) / 24, 0.46 + 0.08 * Math.sin(i / 3));
    const pq = await toPageXY(ed, q);
    await ed.mouse.move(pq.x, pq.y);
  }
  await ed.mouse.up();
  await ed.keyboard.press('t');
  await clickImage(ed, at(v, 0.55, 0.7));
  await ed.keyboard.type(text);
  await ed.keyboard.press('Enter');
  const s = await snapshot(ed);
  expect(s.shapes.map((x) => x.kind)).toEqual([
    'arrow',
    'rect',
    'underline',
    'highlight',
    'pen',
    'text',
  ]);
}

async function toPageXY(ed: Page, p: { x: number; y: number }) {
  const box = await ed.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('canvas not visible');
  const s = await snapshot(ed);
  return {
    x: box.x + (p.x - s.camera.x) * s.camera.zoom,
    y: box.y + (p.y - s.camera.y) * s.camera.zoom,
  };
}

/** Image-px bounding boxes of the doc's shapes (from their geometry, without stroke width). */
export async function shapeBoxes(ed: Page): Promise<ShapeBox[]> {
  return ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const s = (window as any).__pagesnapEngine.state();
    // biome-ignore lint/suspicious/noExplicitAny: shapes are a union; read loosely
    return (s.doc.shapes as any[]).map((sh) => {
      const pts: [number, number][] = [];
      if (sh.a && sh.b) pts.push([sh.a.x, sh.a.y], [sh.b.x, sh.b.y]);
      if (sh.box) pts.push([sh.box.x, sh.box.y], [sh.box.x + sh.box.w, sh.box.y + sh.box.h]);
      if (sh.pts) for (const p of sh.pts) pts.push([p[0], p[1]]);
      if (sh.at) pts.push([sh.at.x, sh.at.y], [sh.at.x + sh.size * 4, sh.at.y + sh.size * 1.3]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { kind: sh.kind, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
    });
  });
}

/**
 * Press `keys` in the editor (Cmd+C or Shift+Cmd+C), wait for the copy to finish, and read the
 * PNG back from the system clipboard through `reader` (a page on the fixture origin).
 */
export async function copyViaKeyboard(
  sw: Worker,
  ed: Page,
  reader: Page,
  sessionId: string,
  keys: 'ControlOrMeta+c' | 'ControlOrMeta+Shift+c',
): Promise<CopyResult> {
  const request = keys.includes('Shift') ? 'full' : 'default';
  await ed.bringToFront();
  const plan = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (r) => (window as any).__pagesnapEngine.plan(r),
    request,
  );
  const before = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    () => (window as any).__pagesnapEngine.perf.copies.length as number,
  );
  await ed.keyboard.press(keys);
  await expect
    .poll(
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      () => ed.evaluate(() => (window as any).__pagesnapEngine.perf.copies.length as number),
      { timeout: 30_000 },
    )
    .toBe(before + 1);
  const s = await snapshot(ed);
  expect(s.copy.state).toBe('copied');
  // The export may move a cut edge by up to 48 CSS px onto a blank row (design §5.4); the
  // status says which region it really copied.
  const region = (s.copy as { scope?: { region: Rect } }).scope?.region;
  if (region) {
    plan.region = region;
    plan.size = { w: Math.round(region.w * plan.scale), h: Math.round(region.h * plan.scale) };
  }
  expect(s.copy.size).toEqual(plan.size);
  // biome-ignore lint/suspicious/noExplicitAny: test hook
  const rec = await ed.evaluate(() => (window as any).__pagesnapEngine.perf.copies.at(-1));
  const png = await readClipboardPng(reader);
  const base = await stitched(sw, sessionId, plan.region, plan.scale);
  return {
    png,
    plan,
    base: { width: base.width, height: base.height, rgb: base.rgb },
    ms: rec.ms,
    cacheHit: rec.cacheHit,
  };
}

/** A shape's box mapped into a copy's pixel space, padded by `pad` output px. */
export function inCopy(c: CopyResult, b: Rect, pad = 0): Rect {
  const s = c.plan.scale;
  return {
    x: Math.round((b.x - c.plan.region.x) * s) - pad,
    y: Math.round((b.y - c.plan.region.y) * s) - pad,
    w: Math.round(b.w * s) + 2 * pad,
    h: Math.round(b.h * s) + 2 * pad,
  };
}

/** Pixels near `rgb` in `rect` of the base image (same region/scale as the copy). */
function countBase(c: CopyResult, rgb: readonly number[], r: Rect, tol: number): number {
  let n = 0;
  for (let y = Math.max(0, r.y); y < Math.min(c.base.height, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(c.base.width, r.x + r.w); x++) {
      if (near(c.base.rgb(x, y), rgb, tol)) n++;
    }
  }
  return n;
}

/**
 * Every annotation left its ink in the copied pixels: red that the page itself doesn't have
 * (arrow, rect, underline, pen, text), the multiply-tinted highlight band, and the text's white
 * outline.
 */
export function expectAnnotations(c: CopyResult, boxes: readonly ShapeBox[]): void {
  for (const sh of boxes) {
    const r = inCopy(c, sh.box, 6);
    if (sh.kind === 'highlight') {
      // The middle of the band: base × (1 − α + α·yellow).
      const mx = Math.round((sh.box.x + sh.box.w / 2 - c.plan.region.x) * c.plan.scale);
      const my = Math.round((sh.box.y - c.plan.region.y) * c.plan.scale);
      const b = c.base.rgb(mx, my);
      const a = DEFAULT_HIGHLIGHT_OPACITY;
      const want = b.map((v, i) => v * (1 - a + (a * (YELLOW[i] ?? 0)) / 255));
      const got = pixel(c.png, mx, my);
      expect(near(got, want, 8), `highlight ${got} vs ${want} (base ${b})`).toBe(true);
      continue;
    }
    const added = countColor(c.png, RED, r, 12) - countBase(c, RED, r, 12);
    const area = Math.max(1, r.w * r.h);
    // Thin strokes at 1x still cover hundreds of pixels; text glyphs at 26 CSS px likewise.
    expect(added, `${sh.kind} red pixels in ${JSON.stringify(r)} (area ${area})`).toBeGreaterThan(
      sh.kind === 'underline' ? 80 : 150,
    );
    if (sh.kind === 'text') {
      const white = countColor(c.png, [255, 255, 255], r, 10);
      expect(white, 'text outline').toBeGreaterThan(60);
    }
  }
}

/**
 * Away from the annotations the copy is the page itself: sample a grid outside every shape's
 * (padded) box and compare with the un-annotated base pixels.
 */
export function expectPagePixels(c: CopyResult, boxes: readonly ShapeBox[]): void {
  const pad = Math.round(60 * c.plan.scale * 2);
  const zones = boxes.map((b) => inCopy(c, b.box, pad));
  const inside = (x: number, y: number) =>
    zones.some((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
  let n = 0;
  let same = 0;
  const W = c.png.width;
  const H = c.png.height;
  for (let y = 3; y < H; y += Math.max(7, Math.floor(H / 120))) {
    for (let x = 3; x < W; x += Math.max(7, Math.floor(W / 60))) {
      if (inside(x, y)) continue;
      n++;
      if (near(pixel(c.png, x, y), c.base.rgb(x, y), 10)) same++;
    }
  }
  expect(n).toBeGreaterThan(200);
  expect(same / n, `${same}/${n} page pixels match the capture`).toBeGreaterThan(0.98);
}

/** Width and height from a PNG file's IHDR, without decoding it. */
export function pngFileSize(file: string): { w: number; h: number; bytes: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}

/** Click Download PNG and wait for the file. Returns its path, name and PNG size. */
export async function downloadViaButton(ed: Page) {
  await ed.bringToFront();
  const wait = ed.waitForEvent('download', { timeout: 60_000 });
  await ed.getByRole('button', { name: 'Download PNG' }).click();
  const dl = await wait;
  const file = await dl.path();
  if (!file) throw new Error(`download failed: ${await dl.failure()}`);
  return { name: dl.suggestedFilename(), file, ...pngFileSize(file) };
}

/** Reload the editor and check the annotations come back exactly as they were. */
export async function expectPersistsAcrossReload(ed: Page): Promise<void> {
  const before = (await snapshot(ed)).shapes;
  await ed.reload();
  await waitReady(ed);
  const after = await snapshot(ed);
  expect(after.shapes).toEqual(before);
  // Fresh history after a reload, but the work is there.
  expect(after.canUndo).toBe(false);
}

/** The captured tab is back where it was: scroll positions, no styles or nodes left behind. */
export async function expectPageRestored(c: Captured): Promise<void> {
  expect(await fullPageState(c.page)).toEqual(c.before);
}

export { decodePng };

export interface FlowChecks {
  /** Scroll the page somewhere before capturing (the capture must put it back). */
  prepare?: (page: Page) => Promise<void>;
  /** Pan the editor this many screen px before drawing. */
  panCss?: number;
  /** Known page colours in a copy: `(copy, session) => void`. */
  pagePixels: (c: CopyResult, session: CaptureSession) => void;
  /** Expected Cmd+C outcome for this page. */
  defaultOutcome: (session: CaptureSession) => 'full' | 'smart';
}

export interface FlowReport {
  session: CaptureSession;
  copyDefault: CopyResult;
  copyFull: CopyResult;
  download: ReturnType<typeof pngFileSize> & { name: string };
}

/**
 * The whole user flow on one fixture: capture (toolbar-click path) → draw every tool with the
 * mouse → Cmd+C → Shift+Cmd+C → Download → reload → original tab restored.
 */
export async function runFlow(
  context: BrowserContext,
  pagesnap: PagesnapHelpers,
  sw: Worker,
  fixture: string,
  checks: FlowChecks,
): Promise<FlowReport> {
  const cap = await captureFixture(pagesnap, sw, fixture, checks.prepare);
  const { editor: ed, session, sessionId, page } = cap;
  expect(session.status).toBe('ready');
  await allowClipboard(context, page);

  if (checks.panCss) await wheelBy(ed, checks.panCss);
  await drawEveryTool(ed);
  const boxes = await shapeBoxes(ed);

  // Cmd+C: the whole page when it's short enough for AI models, else the area around the marks.
  const copyDefault = await copyViaKeyboard(sw, ed, page, sessionId, 'ControlOrMeta+c');
  const outcome = checks.defaultOutcome(session);
  expect(copyDefault.plan.outcome).toBe(outcome);
  expect([copyDefault.png.width, copyDefault.png.height]).toEqual([
    copyDefault.plan.size.w,
    copyDefault.plan.size.h,
  ]);
  expect(copyDefault.png.width).toBe(Math.round(session.css.w));
  if (outcome === 'full') {
    expect(copyDefault.png.height).toBe(Math.round(session.css.h));
  } else {
    expect(copyDefault.png.height).toBeLessThanOrEqual(2576);
    // The region holds every mark.
    for (const b of boxes) {
      expect(b.box.y).toBeGreaterThanOrEqual(copyDefault.plan.region.y);
      expect(b.box.y + b.box.h).toBeLessThanOrEqual(
        copyDefault.plan.region.y + copyDefault.plan.region.h,
      );
    }
  }
  await expect(ed.getByTestId('toast-title')).toHaveText(
    outcome === 'full' ? 'Copied full page' : /^Copied/,
  );
  expectAnnotations(copyDefault, boxes);
  expectPagePixels(copyDefault, boxes);
  checks.pagePixels(copyDefault, session);

  // Shift+Cmd+C: always the full page.
  const copyFull = await copyViaKeyboard(sw, ed, page, sessionId, 'ControlOrMeta+Shift+c');
  expect(copyFull.plan.outcome).toBe('full');
  expect([copyFull.png.width, copyFull.png.height]).toEqual([
    Math.round(session.css.w),
    Math.round(session.css.h),
  ]);
  expectAnnotations(copyFull, boxes);
  expectPagePixels(copyFull, boxes);
  checks.pagePixels(copyFull, session);

  // Download: the full annotated image at native resolution.
  const download = await downloadViaButton(ed);
  expect(download.name).toMatch(/\.png$/);
  expect([download.w, download.h]).toEqual([session.image.w, session.image.h]);
  expect(download.bytes).toBeGreaterThan(1000);
  await expect(ed.getByTestId('toast-title')).toHaveText(`Saved ${download.name}`);

  if (process.env.PAGESNAP_DUMP) {
    const dir = '/tmp/pagesnap-qa/flow-tests';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${fixture}-copy.png`, PNG.sync.write(copyDefault.png));
    writeFileSync(`${dir}/${fixture}-copy-full.png`, PNG.sync.write(copyFull.png));
  }

  await expectPersistsAcrossReload(ed);
  await expectPageRestored(cap);
  return { session, copyDefault, copyFull, download };
}
