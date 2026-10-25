import { afterEach, describe, expect, it } from 'vitest';
import { crc32, type ExportJob, encodePngStream, renderExport } from '@/editor/engine/exportCore';
import { Exporter } from '@/editor/engine/exporter';
import type { AnnotationDoc, Shape } from '@/shared/annotations';
import { emptyDoc } from '@/shared/annotations';
import { closeDb, deleteSession, getSession, getSliceBlob } from '@/shared/db';
import { BAND_CSS, bandColor, seedSyntheticSession } from '@/shared/testing/synthetic';
import type { CaptureSession, Rect } from '@/shared/types';

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await deleteSession(id);
  await closeDb();
});

const RED = '#FF3B30';

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

/** Image px: band i spans [i * BAND_CSS * dpr, (i + 1) * BAND_CSS * dpr). */
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

// Session 400 x 3000 CSS at dpr 2 = 800 x 6000 image px; bands are 1000 image px tall.
const rect: Shape = {
  id: 'r1',
  kind: 'rect',
  color: RED,
  shadow: true,
  box: { x: 100, y: 1200, w: 400, h: 600 },
  width: 12,
  fill: 'none',
};
const arrow: Shape = {
  id: 'a1',
  kind: 'arrow',
  color: RED,
  shadow: true,
  a: { x: 600, y: 1900 },
  b: { x: 600, y: 2700 },
  width: 14,
  bend: 0,
  heads: 'end',
};

describe('renderExport: single canvas', () => {
  it('composites the base and draws shapes at scale 1 and 0.5', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, [rect, arrow]);
    const region: Rect = { x: 0, y: 1000, w: 800, h: 2000 };
    for (const scale of [1, 0.5]) {
      const job: ExportJob = { sessionId: session.id, doc, region, scale };
      const res = await renderExport(job, deps(session));
      expect(res.streamed).toBe(false);
      expect(res.size).toEqual({ w: 800 * scale, h: 2000 * scale });
      const img = await decode(res.blob);
      expect([img.w, img.h]).toEqual([800 * scale, 2000 * scale]);
      const at = (x: number, y: number) =>
        [(x - region.x) * scale, (y - region.y) * scale] as const;
      // Base bands away from shapes.
      for (const y of [1100, 1500, 2200, 2900]) {
        expectColor(img, ...at(750, y), bandAt(y, 2), 2, `band s=${scale}`);
      }
      // Rect left edge stroke centre, rect top edge, arrow shaft centre.
      expectColor(img, ...at(100, 1500), RED, 2, `rect s=${scale}`);
      expectColor(img, ...at(300, 1200), RED, 2, `rect top s=${scale}`);
      expectColor(img, ...at(600, 2100), RED, 2, `arrow s=${scale}`);
      // Inside the rect (fill none): band colour.
      expectColor(img, ...at(300, 1500), bandAt(1500, 2), 2, `rect inside s=${scale}`);
    }
  });
});

describe('renderExport: streamed', () => {
  it('matches the single-canvas output across strip boundaries (scale 1)', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, [rect, arrow]);
    const region: Rect = { x: 0, y: 0, w: 800, h: 6000 };
    const job: ExportJob = { sessionId: session.id, doc, region, scale: 1 };
    const single = await renderExport(job, deps(session));
    const streamed = await renderExport(job, deps(session), { singleMaxArea: 1, stripRows: 512 });
    expect(single.streamed).toBe(false);
    expect(streamed.streamed).toBe(true);
    expect(streamed.size).toEqual({ w: 800, h: 6000 });
    const a = await decode(single.blob);
    const b = await decode(streamed.blob);
    expect([b.w, b.h]).toEqual([800, 6000]);

    // Strip boundaries at multiples of 512: 1536 crosses the rect, 2048/2560 cross the arrow.
    const points: [number, number][] = [];
    for (const y of [511, 512, 1535, 1536, 2047, 2048, 2559, 2560, 4095, 4096]) {
      for (const x of [0, 100, 106, 94, 300, 594, 600, 606, 610, 799]) points.push([x, y]);
    }
    for (const [x, y] of points) {
      const pa = rgbAt(a, x, y);
      const pb = rgbAt(b, x, y);
      const diff = Math.max(...pa.map((v, i) => Math.abs(v - (pb[i] as number))));
      expect(diff, `(${x},${y}) single ${pa} streamed ${pb}`).toBeLessThanOrEqual(2);
    }
    expectColor(b, 600, 2048, RED, 2, 'arrow across strip');
    expectColor(b, 100, 1536, RED, 2, 'rect across strip');

    // Whole-image comparison: the stream must reproduce the single canvas.
    let maxDiff = 0;
    let differing = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.max(
        Math.abs((a.data[i] as number) - (b.data[i] as number)),
        Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)),
        Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)),
      );
      if (d > 0) differing++;
      if (d > maxDiff) maxDiff = d;
    }
    expect(maxDiff, `${differing} px differ`).toBeLessThanOrEqual(2);
  });

  it('streams a scaled export (scale 0.5) correctly', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, [rect, arrow]);
    const region: Rect = { x: 0, y: 500, w: 800, h: 5000 };
    const job: ExportJob = { sessionId: session.id, doc, region, scale: 0.5 };
    const res = await renderExport(job, deps(session), { singleMaxArea: 1, stripRows: 300 });
    expect(res.streamed).toBe(true);
    const img = await decode(res.blob);
    expect([img.w, img.h]).toEqual([400, 2500]);
    const at = (x: number, y: number) => [(x - region.x) * 0.5, (y - region.y) * 0.5] as const;
    for (const y of [700, 1100, 1700, 2300, 2900, 3550, 4100, 5400]) {
      expectColor(img, ...at(750, y), bandAt(y, 2), 2, 'band');
    }
    // Strip boundaries at output rows 300, 600, 900, 1200 = image y 1100, 1700, 2300, 2900.
    expectColor(img, ...at(100, 1700), RED, 2, 'rect across strip');
    expectColor(img, ...at(600, 2300), RED, 2, 'arrow across strip');
    // Band edges within 1 px: rows just either side of the 2000 boundary.
    expectColor(img, ...at(750, 1996), bandAt(1996, 2), 2, 'above band edge');
    expectColor(img, ...at(750, 2004), bandAt(2004, 2), 2, 'below band edge');
  });

  it('respects the abort signal', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, []);
    const ac = new AbortController();
    const job: ExportJob = {
      sessionId: session.id,
      doc,
      region: { x: 0, y: 0, w: 800, h: 6000 },
      scale: 1,
    };
    const p = renderExport(
      job,
      { ...deps(session), signal: ac.signal },
      { singleMaxArea: 1, stripRows: 256 },
    );
    ac.abort(new DOMException('stop', 'AbortError'));
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('encodePngStream', () => {
  it('crc32 matches the reference check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  for (const filter of ['up', 'sub', 'none'] as const) {
    it(`encodes a tiny image losslessly (filter ${filter})`, async () => {
      const w = 3;
      const h = 5;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = (i * 37 + 11) & 255;
        rgba[i * 4 + 1] = (i * 91 + 200) & 255;
        rgba[i * 4 + 2] = (255 - i * 53) & 255;
        rgba[i * 4 + 3] = 255;
      }
      const blob = await encodePngStream(
        w,
        h,
        async (y0, rows) => rgba.slice(y0 * w * 4, (y0 + rows) * w * 4),
        { stripRows: 2, filter },
      );
      expect(blob.type).toBe('image/png');
      const img = await decode(blob);
      expect([img.w, img.h]).toEqual([w, h]);
      for (let i = 0; i < w * h; i++) {
        const got = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
        expect(got, `px ${i}`).toEqual([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
      }

      // Every chunk's CRC is right, and the layout is IHDR, IDAT+, IEND.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dv = new DataView(bytes.buffer);
      const types: string[] = [];
      for (let at = 8; at < bytes.length; ) {
        const len = dv.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        types.push(type);
        expect(dv.getUint32(at + 8 + len), `${type} crc`).toBe(
          crc32(bytes.subarray(at + 4, at + 8 + len)),
        );
        at += 12 + len;
      }
      expect(types[0]).toBe('IHDR');
      expect(types.at(-1)).toBe('IEND');
      expect(types.slice(1, -1).every((t) => t === 'IDAT')).toBe(true);
    });
  }
});

describe('Exporter', () => {
  it('de-duplicates by key, caches, and cancels in the worker', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, [rect, arrow]);
    const exporter = new Exporter();
    try {
      const plan = { region: { x: 0, y: 1000, w: 800, h: 2000 }, scale: 0.5 };
      const h1 = exporter.render(doc, plan);
      const h2 = exporter.render(doc, plan, { priority: 'high' });
      expect(h2.promise).toBe(h1.promise);
      expect(exporter.peek(doc, plan)).toBe(h1.promise);
      const res = await h1.promise;
      expect(exporter.mode).toBe('worker');
      expect(res.size).toEqual({ w: 400, h: 1000 });
      const img = await decode(res.blob);
      expectColor(img, 50, 250, RED, 2, 'worker rect');
      expectColor(img, 375, 50, bandAt(1100, 2), 2, 'worker band');
      // A settled hit returns the cached promise.
      expect(exporter.render(doc, plan).promise).toBe(h1.promise);

      // Cancel: one of two holders cancelling keeps the job alive; the last one cancels it.
      const big = { region: { x: 0, y: 0, w: 800, h: 6000 }, scale: 1 };
      const c1 = exporter.render(doc, big);
      const c2 = exporter.render(doc, big);
      c1.cancel();
      expect(exporter.peek(doc, big)).toBe(c1.promise);
      c2.cancel();
      await expect(c1.promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(exporter.peek(doc, big)).toBeNull();

      // cancelStale only drops older low-priority jobs.
      const lowOld = exporter.render(doc, big);
      const highOld = exporter.render(doc, { ...big, scale: 0.25 }, { priority: 'high' });
      exporter.cancelStale(doc.rev + 1);
      await expect(lowOld.promise).rejects.toMatchObject({ name: 'AbortError' });
      expect((await highOld.promise).size).toEqual({ w: 200, h: 1500 });

      // The next request after a cancel still works.
      const again = await exporter.render(doc, big).promise;
      expect(again.size).toEqual({ w: 800, h: 6000 });
    } finally {
      exporter.dispose();
    }
  });

  it('main-thread fallback gives the same result as the worker', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, [rect, arrow]);
    const plan = { region: { x: 0, y: 1000, w: 800, h: 2000 }, scale: 1 };
    const viaWorker = new Exporter();
    const viaMain = new Exporter({ useWorker: false });
    try {
      expect(viaMain.mode).toBe('main');
      const [a, b] = await Promise.all([
        viaWorker.render(doc, plan).promise,
        viaMain.render(doc, plan).promise,
      ]);
      expect(b.size).toEqual(a.size);
      const ia = await decode(a.blob);
      const ib = await decode(b.blob);
      for (const [x, y] of [
        [100, 500],
        [600, 1100],
        [750, 100],
        [750, 1500],
      ] as const) {
        expect(rgbAt(ib, x, y)).toEqual(rgbAt(ia, x, y));
      }
    } finally {
      viaWorker.dispose();
      viaMain.dispose();
    }
  });

  it('runs high-priority jobs before queued low ones', async () => {
    const session = await seeded({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    const doc = docWith(session, [rect]);
    const exporter = new Exporter({ useWorker: false });
    const order: string[] = [];
    try {
      const full = { x: 0, y: 0, w: 800, h: 6000 };
      const track = (name: string, p: Promise<unknown>) => p.then(() => order.push(name));
      const a = track('lowA', exporter.render(doc, { region: full, scale: 1 }).promise);
      const b = track('lowB', exporter.render(doc, { region: full, scale: 0.5 }).promise);
      const c = track(
        'high',
        exporter.render(doc, { region: full, scale: 0.25 }, { priority: 'high' }).promise,
      );
      await Promise.all([a, b, c]);
      expect(order).toEqual(['lowA', 'high', 'lowB']);
    } finally {
      exporter.dispose();
    }
  });
});
