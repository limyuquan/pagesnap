/**
 * Export timings on big synthetic sessions. Skipped by default (seeding a 30000 px page takes a
 * while). Run with:
 *
 *   VITE_BENCH=1 pnpm vitest run --project browser tests/browser/engine.export.bench.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { type ExportJob, renderExport } from '@/editor/engine/exportCore';
import { Exporter } from '@/editor/engine/exporter';
import type { AnnotationDoc, Shape } from '@/shared/annotations';
import { emptyDoc } from '@/shared/annotations';
import { closeDb, deleteSession, getSession, getSliceBlob } from '@/shared/db';
import { seedSyntheticSession } from '@/shared/testing/synthetic';
import type { CaptureSession, Rect } from '@/shared/types';

const created: string[] = [];
afterAll(async () => {
  for (const id of created.splice(0)) await deleteSession(id);
  await closeDb();
});

const shapes = (y: number): Shape[] => [
  {
    id: 'r',
    kind: 'rect',
    color: '#FF3B30',
    shadow: true,
    box: { x: 200, y, w: 900, h: 500 },
    width: 10,
    fill: 'none',
  },
  {
    id: 'a',
    kind: 'arrow',
    color: '#FF3B30',
    shadow: true,
    a: { x: 1600, y: y + 900 },
    b: { x: 1150, y: y + 300 },
    width: 12,
    bend: 0,
    heads: 'end',
  },
];

async function seed(cssW: number, cssH: number): Promise<CaptureSession> {
  const t0 = performance.now();
  const id = await seedSyntheticSession({ cssW, cssH, viewportH: 800, dpr: 2 });
  created.push(id);
  const s = await getSession(id);
  if (!s) throw new Error('missing');
  console.log(`seed ${cssW}x${cssH} CSS: ${Math.round(performance.now() - t0)} ms`);
  return s;
}

function doc(s: CaptureSession, y: number): AnnotationDoc {
  return { ...emptyDoc(s.id, { ...s.image, dpr: s.dpr }), rev: 1, shapes: shapes(y) };
}

async function time(
  label: string,
  s: CaptureSession,
  d: AnnotationDoc,
  region: Rect,
  scale: number,
) {
  const job: ExportJob = { sessionId: s.id, doc: d, region, scale };
  const res = await renderExport(job, { session: s, loadSlice: (i) => getSliceBlob(s.id, i) });
  console.log(
    `${label}: ${res.size.w}x${res.size.h} ${res.streamed ? 'streamed' : 'single'} ` +
      `${Math.round(res.ms)} ms, ${(res.blob.size / 2 ** 20).toFixed(2)} MB`,
  );
  return res;
}

describe.skipIf(!import.meta.env.VITE_BENCH)('export benchmark', () => {
  it('1280x3000 CSS dpr 2, full at 0.5', { timeout: 120_000 }, async () => {
    const s = await seed(1280, 3000);
    const d = doc(s, 1500);
    await time('(a) full 0.5 (warm-up)', s, d, { x: 0, y: 0, ...s.image }, 0.5);
    const r = await time('(a) full 0.5', s, d, { x: 0, y: 0, ...s.image }, 0.5);
    expect(r.size).toEqual({ w: 1280, h: 3000 });
  });

  it('1400x30000 CSS dpr 2', { timeout: 600_000 }, async () => {
    const s = await seed(1400, 30000);
    const d = doc(s, 22000);
    const full: Rect = { x: 0, y: 0, ...s.image };
    const smart: Rect = { x: 0, y: 20000, w: 2800, h: 5152 };
    await time('(b) smart 0.5 (warm-up)', s, d, smart, 0.5);
    await time('(b) smart 2800x5152 @0.5', s, d, smart, 0.5);
    await time('(b) full @0.5', s, d, full, 0.5);
    const native = await time('(b) full native @1', s, d, full, 1);
    expect(native.streamed).toBe(true);
    for (const filter of ['sub', 'none'] as const) {
      const job: ExportJob = { sessionId: s.id, doc: d, region: full, scale: 1 };
      const res = await renderExport(
        job,
        { session: s, loadSlice: (i) => getSliceBlob(s.id, i) },
        { filter },
      );
      console.log(
        `(b) full native @1 filter=${filter}: ${Math.round(res.ms)} ms, ${(res.blob.size / 2 ** 20).toFixed(2)} MB`,
      );
    }
    // For comparison: Chrome's own encoder on one 168 MP canvas (what the memory guard avoids).
    const forced = await renderExport(
      { sessionId: s.id, doc: d, region: full, scale: 1 },
      { session: s, loadSlice: (i) => getSliceBlob(s.id, i) },
      { singleMaxArea: Number.POSITIVE_INFINITY },
    );
    console.log(
      `(b) full native @1 single canvas (guard off): ${Math.round(forced.ms)} ms, ` +
        `${(forced.blob.size / 2 ** 20).toFixed(2)} MB`,
    );

    // Through the worker (includes structured-clone of the Blob back to the page).
    const exporter = new Exporter();
    try {
      const t0 = performance.now();
      const r = await exporter.render(d, { region: smart, scale: 0.5 }).promise;
      console.log(
        `(b) worker smart @0.5 round trip: ${Math.round(performance.now() - t0)} ms ` +
          `(worker render ${Math.round(r.ms)} ms, mode ${exporter.mode})`,
      );
    } finally {
      exporter.dispose();
    }
  });
});
