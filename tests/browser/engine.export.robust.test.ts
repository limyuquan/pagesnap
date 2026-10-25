/**
 * Export robustness: canvas-allocation fallback, edge snapping, worker crash/timeout recovery and
 * the byte-bounded result cache.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type ExportJob, renderExport } from '@/editor/engine/exportCore';
import {
  createExportWorker,
  EXPORT_WORKER_CRASHED,
  Exporter,
  exportTimeoutMs,
} from '@/editor/engine/exporter';
import type { AnnotationDoc, Shape } from '@/shared/annotations';
import { emptyDoc } from '@/shared/annotations';
import { closeDb, deleteSession, getSession, getSliceBlob } from '@/shared/db';
import { BAND_CSS, bandColor, seedSyntheticSession } from '@/shared/testing/synthetic';
import type { CaptureSession, FillRect, Rect } from '@/shared/types';

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await deleteSession(id);
  await closeDb();
});

interface Decoded {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

async function decode(blob: Blob): Promise<Decoded> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no ctx');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return {
    w: canvas.width,
    h: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

function rgbAt(img: Decoded, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.w + Math.round(x)) * 4;
  return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1];
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function expectColor(img: Decoded, x: number, y: number, hex: string, tol = 2, label = '') {
  const got = rgbAt(img, x, y);
  const want = rgbOf(hex);
  const ok = got.every((v, i) => Math.abs(v - (want[i] as number)) <= tol);
  expect(ok, `${label} (${x},${y}) got rgb(${got.join(',')}) want ${hex}`).toBe(true);
}

const bandAt = (imageY: number, dpr: number) => bandColor(Math.floor(imageY / (BAND_CSS * dpr)));

async function seeded(opts: Parameters<typeof seedSyntheticSession>[0]): Promise<CaptureSession> {
  const id = await seedSyntheticSession(opts);
  created.push(id);
  const s = await getSession(id);
  if (!s) throw new Error('missing session');
  return s;
}

function docWith(session: CaptureSession, shapes: Shape[], rev = 1): AnnotationDoc {
  return { ...emptyDoc(session.id, { ...session.image, dpr: session.dpr }), rev, shapes };
}

function deps(session: CaptureSession) {
  return { session, loadSlice: (i: number) => getSliceBlob(session.id, i) };
}

// ------------------------------------------------------------------ in-memory "text" page

const WHITE = '#ffffff';
const INK = '#222222';
const RED = '#FF3B30';

/**
 * 400 x 1200 image px at dpr 1: white page, dark 10 px "text lines" at [30k, 30k + 10) across
 * x 20..250 (ragged like text: a row with ink is not uniform). No slices: the base is only the
 * layout fills, so `loadSlice` is never called.
 */
function textSession(): CaptureSession {
  const W = 400;
  const H = 1200;
  const fills: FillRect[] = [];
  for (let y = 0; y < H; y += 30) fills.push({ rect: { x: 20, y, w: 230, h: 10 }, color: INK });
  return {
    v: 1,
    id: `mem-${Math.random().toString(36).slice(2)}`,
    url: 'https://example.test/',
    title: 'text',
    createdAt: 0,
    updatedAt: 0,
    mode: 'full',
    status: 'ready',
    error: null,
    warnings: [],
    progress: { done: 0, total: 0 },
    viewport: { w: W, h: 800 },
    dpr: 1,
    css: { w: W, h: H },
    image: { w: W, h: H },
    slices: [],
    layout: { size: { w: W, h: H }, background: WHITE, fills, parts: [] },
  };
}

const noSlices = (): Promise<Blob> => Promise.reject(new Error('loadSlice must not be called'));

function textJob(session: CaptureSession, region: Rect, extra: Partial<ExportJob> = {}): ExportJob {
  return { sessionId: session.id, doc: docWith(session, []), region, scale: 1, ...extra };
}

function rowIsWhite(img: Decoded, y: number): boolean {
  for (let x = 0; x < img.w; x++) {
    const [r, g, b] = rgbAt(img, x, y);
    if (r < 250 || g < 250 || b < 250) return false;
  }
  return true;
}

// ------------------------------------------------------------------------- allocation

describe('renderExport: canvas allocation fallback', () => {
  it('streams when the single canvas is dead (probe fails)', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const region: Rect = { x: 0, y: 1000, w: 800, h: 2000 };
    const job: ExportJob = { sessionId: session.id, doc: docWith(session, []), region, scale: 1 };
    const sizes: string[] = [];
    let calls = 0;
    const res = await renderExport(job, deps(session), {
      stripRows: 512,
      createCanvas: (w, h) => {
        sizes.push(`${w}x${h}`);
        // The first canvas is the single one: simulate Chrome's failed allocation (convertToBlob
        // on a 0x0 canvas throws IndexSizeError, getImageData reads transparent black).
        return calls++ === 0 ? new OffscreenCanvas(0, 0) : new OffscreenCanvas(w, h);
      },
    });
    expect(sizes[0]).toBe('800x2000');
    expect(sizes[1]).toBe('800x512');
    expect(res.streamed).toBe(true);
    expect(res.size).toEqual({ w: 800, h: 2000 });
    expect(res.region).toEqual(region);
    const img = await decode(res.blob);
    expect([img.w, img.h]).toEqual([800, 2000]);
    for (const y of [1000, 1100, 1511, 1512, 1999, 2000, 2500, 2999]) {
      expectColor(img, 750, y - region.y, bandAt(y, 2), 2, 'band');
    }
  });

  it('streams when encoding the single canvas throws an allocation error', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const region: Rect = { x: 0, y: 0, w: 800, h: 3000 };
    const job: ExportJob = { sessionId: session.id, doc: docWith(session, []), region, scale: 0.5 };
    let calls = 0;
    const res = await renderExport(job, deps(session), {
      stripRows: 400,
      createCanvas: (w, h) => {
        const c = new OffscreenCanvas(w, h);
        if (calls++ === 0) {
          c.convertToBlob = () =>
            Promise.reject(new DOMException('The image source is detached', 'IndexSizeError'));
        }
        return c;
      },
    });
    expect(res.streamed).toBe(true);
    expect(res.size).toEqual({ w: 400, h: 1500 });
    const img = await decode(res.blob);
    for (const y of [100, 1100, 2100, 2900]) expectColor(img, 375, y / 2, bandAt(y, 2), 2, 'band');
  });

  it('reports ExportMemoryError when even a strip canvas is dead', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const job: ExportJob = {
      sessionId: session.id,
      doc: docWith(session, []),
      region: { x: 0, y: 0, w: 800, h: 3000 },
      scale: 1,
    };
    await expect(
      renderExport(job, deps(session), { createCanvas: () => new OffscreenCanvas(0, 0) }),
    ).rejects.toMatchObject({ name: 'ExportMemoryError' });
  });

  it('never falls back on abort', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const ac = new AbortController();
    const job: ExportJob = {
      sessionId: session.id,
      doc: docWith(session, []),
      region: { x: 0, y: 0, w: 800, h: 3000 },
      scale: 1,
    };
    let canvases = 0;
    const p = renderExport(
      job,
      {
        ...deps(session),
        signal: ac.signal,
        loadSlice: async (i) => {
          ac.abort(new DOMException('stop', 'AbortError'));
          return getSliceBlob(session.id, i);
        },
      },
      {
        createCanvas: (w, h) => {
          canvases++;
          return new OffscreenCanvas(w, h);
        },
      },
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(canvases).toBe(1);
  });
});

// ------------------------------------------------------------------------------ snapping

describe('renderExport: edge snapping', () => {
  it('moves a bottom edge that cuts through text up into the gap above', async () => {
    const session = textSession();
    // Bottom at 515 cuts the line [510, 520). Gap [490, 510) is in the 40 px window.
    const region: Rect = { x: 0, y: 0, w: 400, h: 515 };
    const res = await renderExport(textJob(session, region, { snap: { top: 0, bottom: 40 } }), {
      session,
      loadSlice: noSlices,
    });
    expect(res.streamed).toBe(false);
    // Keep 8 px of whitespace below the line ending at 490.
    expect(res.region).toEqual({ x: 0, y: 0, w: 400, h: 498 });
    expect(res.size).toEqual({ w: 400, h: 498 });
    const img = await decode(res.blob);
    expect([img.w, img.h]).toEqual([400, 498]);
    for (let y = 490; y < 498; y++) expect(rowIsWhite(img, y), `row ${y}`).toBe(true);
    expectColor(img, 200, 489, INK, 2, 'last text line');
  });

  it('snaps both edges and keeps annotations aligned', async () => {
    const session = textSession();
    const rect: Shape = {
      id: 'r',
      kind: 'rect',
      color: RED,
      shadow: false,
      box: { x: 100, y: 100, w: 200, h: 100 },
      width: 6,
      fill: 'none',
    };
    // Top at 5 cuts the line [0, 10); the gap [10, 30) is in the window. Bottom at 515 as above.
    const region: Rect = { x: 0, y: 5, w: 400, h: 510 };
    const job: ExportJob = {
      ...textJob(session, region, { snap: { top: 40, bottom: 40 } }),
      doc: docWith(session, [rect]),
    };
    const res = await renderExport(job, { session, loadSlice: noSlices });
    // Top: 8 px of whitespace above the line at 30 → 22. Bottom: 498 as above.
    expect(res.region).toEqual({ x: 0, y: 22, w: 400, h: 476 });
    expect(res.size).toEqual({ w: 400, h: 476 });
    const img = await decode(res.blob);
    expect([img.w, img.h]).toEqual([400, 476]);
    for (let y = 0; y < 8; y++) expect(rowIsWhite(img, y), `top row ${y}`).toBe(true);
    expectColor(img, 200, 8, INK, 2, 'first text line');
    expect(rowIsWhite(img, 475)).toBe(true);
    // The rect's left edge at image (100, 150) → output (100, 128); the page shifts by 22 too.
    expectColor(img, 100, 150 - 22, RED, 2, 'rect edge');
    expectColor(img, 200, 75 - 22, WHITE, 2, 'gap');
    expectColor(img, 200, 65 - 22, INK, 2, 'line');
  });

  it('snaps at scale 0.5 with whole source px', async () => {
    const session = textSession();
    const region: Rect = { x: 0, y: 0, w: 400, h: 516 };
    const res = await renderExport(
      textJob(session, region, { scale: 0.5, snap: { top: 0, bottom: 40 } }),
      { session, loadSlice: noSlices },
    );
    expect(res.region.h).toBeLessThan(516);
    expect(res.region.h).toBeGreaterThanOrEqual(516 - 40);
    expect(Number.isInteger(res.region.h)).toBe(true);
    expect(res.size).toEqual({ w: 200, h: Math.round(res.region.h * 0.5) });
    const img = await decode(res.blob);
    expect([img.w, img.h]).toEqual([res.size.w, res.size.h]);
    expect(rowIsWhite(img, img.h - 1)).toBe(true);
  });

  it('leaves an edge that is already in whitespace alone', async () => {
    const session = textSession();
    // Bottom at 505: rows 490..504 are the gap, so the last row is already blank.
    const region: Rect = { x: 0, y: 0, w: 400, h: 505 };
    const res = await renderExport(textJob(session, region, { snap: { top: 0, bottom: 40 } }), {
      session,
      loadSlice: noSlices,
    });
    expect(res.region).toEqual(region);
    expect(res.size).toEqual({ w: 400, h: 505 });
    // Both edges in whitespace: top at 15 (gap [10, 30)), bottom at 505.
    const r2: Rect = { x: 0, y: 15, w: 400, h: 490 };
    const res2 = await renderExport(textJob(session, r2, { snap: { top: 40, bottom: 40 } }), {
      session,
      loadSlice: noSlices,
    });
    expect(res2.region).toEqual(r2);
  });

  it('does nothing without snap, with a zero snap, or on the streamed path', async () => {
    const session = textSession();
    const region: Rect = { x: 0, y: 0, w: 400, h: 515 };
    const plain = await renderExport(textJob(session, region), { session, loadSlice: noSlices });
    expect(plain.region).toEqual(region);
    expect(plain.size).toEqual({ w: 400, h: 515 });
    const zero = await renderExport(textJob(session, region, { snap: { top: 0, bottom: 0 } }), {
      session,
      loadSlice: noSlices,
    });
    expect(zero.region).toEqual(region);
    const streamed = await renderExport(
      textJob(session, region, { snap: { top: 40, bottom: 40 } }),
      { session, loadSlice: noSlices },
      { singleMaxArea: 1, stripRows: 100 },
    );
    expect(streamed.streamed).toBe(true);
    expect(streamed.region).toEqual(region);
    expect(streamed.size).toEqual({ w: 400, h: 515 });
  });

  it('never moves an edge further than its max', async () => {
    const session = textSession();
    // The nearest gap above 515 starts 25 rows up: a 4 px window finds no gap.
    const region: Rect = { x: 0, y: 0, w: 400, h: 515 };
    const res = await renderExport(textJob(session, region, { snap: { top: 0, bottom: 4 } }), {
      session,
      loadSlice: noSlices,
    });
    expect(res.region).toEqual(region);
  });
});

// ------------------------------------------------------------------ worker crash / timeout

function blobWorker(src: string): Worker {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const w = new Worker(url);
  // The script is fetched on start; the URL can go once the worker has loaded it.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return w;
}

const CRASHING = `postMessage({ t: 'ready' }); self.onmessage = () => { throw new Error('boom'); };`;
const HANGING = `postMessage({ t: 'ready' }); self.onmessage = () => {};`;
const BROKEN = `throw new Error('startup failure');`;

describe('Exporter: worker failures', () => {
  it('exportTimeoutMs: 20 s + 100 ms per megapixel, capped', () => {
    expect(exportTimeoutMs({ w: 0, h: 0 })).toBe(20_000);
    expect(exportTimeoutMs({ w: 1000, h: 1000 })).toBe(20_100);
    expect(exportTimeoutMs({ w: 2576, h: 2576 })).toBe(Math.ceil(20_000 + 663.5776));
    expect(exportTimeoutMs({ w: 16_384, h: 200_000 })).toBe(120_000);
  });

  it('a crash after ready rejects pending jobs; a fresh worker takes the next job', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    let spawned = 0;
    const exporter = new Exporter({
      createWorker: () => (spawned++ === 0 ? blobWorker(CRASHING) : createExportWorker()),
    });
    try {
      const plan = { region: { x: 0, y: 0, w: 800, h: 1000 }, scale: 0.5 };
      const t0 = performance.now();
      const err = await exporter.render(doc, plan).promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        name: EXPORT_WORKER_CRASHED,
        message: 'The export worker stopped unexpectedly',
      });
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(exporter.peek(doc, plan)).toBeNull();
      expect(exporter.mode).toBe('worker');
      const res = await exporter.render(doc, plan).promise;
      expect(spawned).toBe(2);
      expect(res.size).toEqual({ w: 400, h: 500 });
      const img = await decode(res.blob);
      expectColor(img, 375, 250, bandAt(500, 2), 2, 'band');
    } finally {
      exporter.dispose();
    }
  });

  it('a startup failure falls back to the main thread', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    let spawned = 0;
    const exporter = new Exporter({
      createWorker: () => {
        spawned++;
        return blobWorker(BROKEN);
      },
    });
    try {
      const res = await exporter.render(doc, { region: { x: 0, y: 0, w: 800, h: 1000 }, scale: 1 })
        .promise;
      expect(res.size).toEqual({ w: 800, h: 1000 });
      expect(exporter.mode).toBe('main');
      expect(spawned).toBe(1);
    } finally {
      exporter.dispose();
    }
  });

  it('times out a hung job, replaces the worker and re-sends the other pending jobs', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    let spawned = 0;
    const exporter = new Exporter({
      createWorker: () => (spawned++ === 0 ? blobWorker(HANGING) : createExportWorker()),
    });
    try {
      const hung = { region: { x: 0, y: 0, w: 800, h: 1000 }, scale: 1 };
      const other = { region: { x: 0, y: 1000, w: 800, h: 1000 }, scale: 0.5 };
      const t0 = performance.now();
      const p1 = exporter.render(doc, hung, { timeoutMs: 200 }).promise;
      // Sent to the hung worker too, without a timeout: re-sent to the new worker.
      const p2 = exporter.render(doc, other).promise;
      const err = await p1.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DOMException);
      expect(err).toMatchObject({ name: 'TimeoutError', message: 'The export took too long' });
      const dt = performance.now() - t0;
      expect(dt).toBeGreaterThanOrEqual(190);
      expect(dt).toBeLessThan(1_000);
      expect(exporter.peek(doc, hung)).toBeNull();
      const r2 = await p2;
      expect(r2.size).toEqual({ w: 400, h: 500 });
      expect(spawned).toBe(2);
      // A later job on the recreated worker works.
      const r3 = await exporter.render(doc, hung, { timeoutMs: 20_000 }).promise;
      expect(r3.size).toEqual({ w: 800, h: 1000 });
      expect(exporter.mode).toBe('worker');
    } finally {
      exporter.dispose();
    }
  });

  it('a job waiting behind a slow one is not timed until it starts (no restart mid-download)', async () => {
    const SLOW = `
      postMessage({ t: 'ready' });
      const q = []; let busy = false;
      const pump = () => {
        if (busy || !q.length) return;
        const m = q.shift(); busy = true;
        postMessage({ t: 'start', id: m.id });
        setTimeout(() => {
          postMessage({ t: 'done', id: m.id, result: { blob: new Blob(['x']), size: { w: 1, h: 1 },
            region: m.job.region, ms: 1, streamed: false } });
          busy = false; pump();
        }, 400);
      };
      onmessage = (e) => { if (e.data.t === 'job') { q.push(e.data); pump(); } };
    `;
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    let spawned = 0;
    const exporter = new Exporter({
      createWorker: () => {
        spawned++;
        return blobWorker(SLOW);
      },
    });
    try {
      const a = exporter.render(
        doc,
        { region: { x: 0, y: 0, w: 10, h: 10 }, scale: 1 },
        {
          priority: 'high',
          timeoutMs: 1_000,
        },
      );
      // Queued behind A for ~400 ms, runs ~400 ms: 600 ms from submission would have expired.
      const b = exporter.render(
        doc,
        { region: { x: 0, y: 10, w: 10, h: 10 }, scale: 1 },
        {
          priority: 'low',
          timeoutMs: 600,
        },
      );
      await expect(a.promise).resolves.toMatchObject({ size: { w: 1, h: 1 } });
      await expect(b.promise).resolves.toMatchObject({ size: { w: 1, h: 1 } });
      expect(spawned).toBe(1);
    } finally {
      exporter.dispose();
    }
  });

  it('a timeout on the main thread replaces the runner too', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    const exporter = new Exporter({ useWorker: false });
    try {
      const plan = { region: { x: 0, y: 0, w: 800, h: 3000 }, scale: 1 };
      // 0 ms: fires before the first slice is read.
      await expect(exporter.render(doc, plan, { timeoutMs: 0 }).promise).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      const res = await exporter.render(doc, plan).promise;
      expect(res.size).toEqual({ w: 800, h: 3000 });
    } finally {
      exporter.dispose();
    }
  });

  it('a settled job ignores its timeout', async () => {
    const session = await seeded({ cssW: 400, cssH: 1500, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    const exporter = new Exporter({ useWorker: false });
    try {
      const plan = { region: { x: 0, y: 0, w: 800, h: 1000 }, scale: 0.5 };
      const h = exporter.render(doc, plan, { timeoutMs: 10_000 });
      await h.promise;
      // A cache hit with a tiny timeout is still the resolved promise.
      const again = exporter.render(doc, plan, { timeoutMs: 1 });
      expect(again.promise).toBe(h.promise);
      await new Promise((r) => setTimeout(r, 20));
      await expect(again.promise).resolves.toMatchObject({ size: { w: 400, h: 500 } });
    } finally {
      exporter.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------- cache

describe('Exporter: cache bounds', () => {
  it('bounds settled results by bytes and skips results that are too big', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    const small = (y: number) => ({ region: { x: 0, y, w: 800, h: 400 }, scale: 0.25 });
    const plans = [small(0), small(1000), small(2000)];
    const big = { region: { x: 0, y: 0, w: 800, h: 6000 }, scale: 1 };
    // Measure the PNG sizes first (same renderer, deterministic encoder).
    const sizeOf = async (p: { region: Rect; scale: number }) =>
      (await renderExport({ sessionId: session.id, doc, ...p }, deps(session))).blob.size;
    const smallBytes = await Promise.all(plans.map(sizeOf));
    const bigBytes = await sizeOf(big);
    const maxSmall = Math.max(...smallBytes);
    expect(bigBytes).toBeGreaterThan(maxSmall);
    const sum = smallBytes.reduce((a, b) => a + b, 0);

    const exporter = new Exporter({
      useWorker: false,
      cacheMaxEntries: 10,
      cacheMaxBytes: sum - 1, // all three don't fit: the oldest goes
      cacheMaxEntryBytes: bigBytes - 1, // the big one isn't cached at all
    });
    try {
      for (const p of plans) await exporter.render(doc, p).promise;
      expect(exporter.peek(doc, plans[0] as (typeof plans)[0])).toBeNull();
      expect(exporter.peek(doc, plans[1] as (typeof plans)[0])).not.toBeNull();
      expect(exporter.peek(doc, plans[2] as (typeof plans)[0])).not.toBeNull();

      const h = exporter.render(doc, big);
      // In flight: served from the cache (de-duplicated).
      expect(exporter.peek(doc, big)).toBe(h.promise);
      const res = await h.promise;
      expect(res.blob.size).toBe(bigBytes);
      expect(exporter.peek(doc, big)).toBeNull();
      // The small ones are untouched by the uncached big result.
      expect(exporter.peek(doc, plans[1] as (typeof plans)[0])).not.toBeNull();
      expect(exporter.peek(doc, plans[2] as (typeof plans)[0])).not.toBeNull();
    } finally {
      exporter.dispose();
    }
  });

  it('bounds settled results by count, and snap is part of the key', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    const exporter = new Exporter({ useWorker: false, cacheMaxEntries: 2 });
    try {
      const plan = (y: number) => ({ region: { x: 0, y, w: 800, h: 200 }, scale: 0.25 });
      for (const y of [0, 1000, 2000]) await exporter.render(doc, plan(y)).promise;
      expect(exporter.peek(doc, plan(0))).toBeNull();
      expect(exporter.peek(doc, plan(1000))).not.toBeNull();
      expect(exporter.peek(doc, plan(2000))).not.toBeNull();

      const snapped = { ...plan(2000), snap: { top: 10, bottom: 10 } };
      expect(exporter.peek(doc, snapped)).toBeNull();
      // A zero snap is the same job as no snap.
      expect(exporter.peek(doc, { ...plan(2000), snap: { top: 0, bottom: 0 } })).toBe(
        exporter.peek(doc, plan(2000)),
      );
      const res = await exporter.render(doc, snapped).promise;
      // The rendered region lies within the asked one, each edge moved at most 10 px.
      expect(res.region.y).toBeGreaterThanOrEqual(2000);
      expect(res.region.y).toBeLessThanOrEqual(2010);
      expect(res.region.y + res.region.h).toBeGreaterThanOrEqual(2190);
      expect(res.region.y + res.region.h).toBeLessThanOrEqual(2200);
      expect(exporter.peek(doc, snapped)).not.toBeNull();
    } finally {
      exporter.dispose();
    }
  });
});
