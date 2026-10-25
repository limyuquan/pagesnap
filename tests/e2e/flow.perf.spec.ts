/**
 * Performance budgets on the real pipeline (always on, unlike the PAGESNAP_PERF measurements in
 * engine.perf.spec.ts). Each number is asserted against a CI-tolerant threshold, well above what a
 * quiet machine measures but low enough that a real regression fails. Measured values are logged
 * as `PERF {...}` lines.
 */
import type { Page } from '@playwright/test';
import { captureFull } from './capture.helpers';
import { toPage, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';
import { visibleImageRect, wheelBy } from './flow.helpers';

/** Thresholds (ms unless noted). Targets in comments are quiet-machine measurements. */
const BUDGET = {
  /**
   * Average wall time per slice, capture start → editor open. Floor is the 530 ms quota gap;
   * measured 523–537 alone and up to ~680 with six test browsers in parallel.
   */
  perSliceMs: 900,
  /** Median gap between two captureVisibleTab calls. Target: 531. */
  sliceGapP50Ms: 600,
  /** Inject + prepare. Target: ~100–500. */
  prepareMs: 2_000,
  /** Editor navigation → first display tile drawn. Target: ~100–300. */
  firstTileMs: 750,
  /** Cmd+C → clipboard.write resolved, with the PNG pre-encoded. Target: < 50. */
  copyWarmMs: 250,
  /** Our render work per frame during a pen stroke, p95. Target: < 2. */
  strokeRenderP95Ms: 8,
  /** Frames the page itself dropped during a 2 s pen stroke (see `penStroke`). */
  strokeDroppedFrames: 0,
  /**
   * rAF intervals over 1.5 × 16.7 ms during the stroke, whatever the cause. Measured 0 on a quiet
   * machine; with other test browsers running in parallel the compositor occasionally stalls one
   * frame with no page work at all (LoAF entries without scripts or blocking), so allow 2.
   */
  strokeRafDroppedMax: 2,
} as const;

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0) };
}

/**
 * A 2 s pen stroke at ~60 Hz input. Samples rAF intervals, the engine's render time per frame,
 * and Long Animation Frame entries (with script attribution) while it runs.
 */
async function penStroke(ed: Page) {
  await ed.keyboard.press('p');
  const v = await visibleImageRect(ed);
  const start = await toPage(ed, v.x + v.w * 0.15, v.y + v.h * 0.4);
  await ed.mouse.move(start.x, start.y);
  await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__pagesnapEngine.perf.resetFrames();
    w.__loaf = [];
    w.__loafObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // biome-ignore lint/suspicious/noExplicitAny: LoAF entries aren't in the DOM lib yet
        const x = e as any;
        w.__loaf.push({
          ms: Math.round(e.duration),
          blockingMs: Math.round(x.blockingDuration ?? 0),
          scriptMs: Math.round(
            // biome-ignore lint/suspicious/noExplicitAny: LoAF script entries
            (x.scripts ?? []).reduce((t: number, sc: any) => t + sc.duration, 0),
          ),
        });
      }
    });
    w.__loafObs.observe({ type: 'long-animation-frame' });
    w.__raf = [];
    w.__rafOn = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.__raf.push(t - last);
      last = t;
      if (w.__rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await ed.mouse.down();
  for (let i = 0; i < 120; i++) {
    await ed.mouse.move(start.x + i * 5, start.y + Math.sin(i / 8) * 80);
    await ed.waitForTimeout(16);
  }
  await ed.mouse.up();
  const sample = await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__rafOn = false;
    w.__loafObs.disconnect();
    return {
      raf: (w.__raf as number[]).slice(1),
      render: [...w.__pagesnapEngine.perf.frames] as number[],
      loaf: w.__loaf as { ms: number; blockingMs: number; scriptMs: number }[],
    };
  });
  const kinds = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    () => (window as any).__pagesnapEngine.state().doc.shapes.map((s: any) => s.kind),
  );
  expect(kinds).toEqual(['pen']);
  // A frame the page dropped: our render ran past the frame budget, or a long animation frame
  // had script work or blocked input.
  const pageDropped =
    sample.render.filter((ms) => ms > 1000 / 60).length +
    sample.loaf.filter((l) => l.scriptMs > 0 || l.blockingMs > 0).length;
  return {
    render: stats(sample.render),
    raf: stats(sample.raf),
    rafDropped: sample.raf.filter((d) => d > 25).length,
    pageDropped,
    loaf: sample.loaf,
  };
}

test('capture, first tile, pen stroke and pre-encoded copy stay within budget', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  test.setTimeout(120_000);
  const page = await pagesnap.openFixture('bands');
  let { editor: ed, session, timings } = await captureFull(pagesnap, serviceWorker, page);
  expect(session.status).toBe('ready');
  if (!timings) throw new Error('no capture timings');
  const withinCaptureBudget = (t: NonNullable<typeof timings>) =>
    t.totalMs / t.slices < BUDGET.perSliceMs &&
    stats(t.frameGapsMs).p50 < BUDGET.sliceGapP50Ms &&
    t.prepareMs < BUDGET.prepareMs;
  if (!withinCaptureBudget(timings)) {
    // Wall-clock budgets: a load spike from other browsers on the machine misses one capture, a
    // real slowdown misses both. Same budgets, best of two captures.
    console.log(`PERF capture over budget, retrying once: ${JSON.stringify(timings)}`);
    await ed.close();
    await page.bringToFront();
    const again = await captureFull(pagesnap, serviceWorker, page);
    if (again.timings && withinCaptureBudget(again.timings)) {
      ({ editor: ed, session, timings } = again);
    } else {
      await again.editor.close();
    }
  }
  if (!timings) throw new Error('no capture timings');
  await waitReady(ed);

  const perSlice = timings.totalMs / timings.slices;
  const gaps = stats(timings.frameGapsMs);
  const firstTile = await ed.evaluate(
    () => performance.getEntriesByName('pagesnap:first-tile')[0]?.startTime ?? null,
  );

  // Draw on a later part of the page, so the stroke runs over freshly loaded tiles.
  await wheelBy(ed, 600);
  const stroke = await penStroke(ed);

  // Pre-encoded copy: wait for the prewarm of the current revision, then Cmd+C.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await expect
    .poll(
      () =>
        ed.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: test hook
          const e = (window as any).__pagesnapEngine;
          const s = e.state();
          return e.perf.prewarmedKey?.() ?? s._compositeRev === s.doc.rev;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await ed.keyboard.press('ControlOrMeta+c');
  await expect
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    .poll(() => ed.evaluate(() => (window as any).__pagesnapEngine.perf.copies.length))
    .toBe(1);
  // biome-ignore lint/suspicious/noExplicitAny: test hook
  const copy = await ed.evaluate(() => (window as any).__pagesnapEngine.perf.copies[0]);

  const report = {
    capture: {
      slices: timings.slices,
      totalMs: timings.totalMs,
      perSliceMs: Math.round(perSlice),
      prepareMs: timings.prepareMs,
      gapsMs: gaps,
    },
    firstTileMs: firstTile && Math.round(firstTile),
    stroke,
    copy: { outcome: copy.outcome, ms: Math.round(copy.ms), cacheHit: copy.cacheHit },
  };
  console.log(`PERF ${JSON.stringify(report)}`);

  expect(perSlice).toBeLessThan(BUDGET.perSliceMs);
  expect(gaps.p50).toBeLessThan(BUDGET.sliceGapP50Ms);
  expect(timings.prepareMs).toBeLessThan(BUDGET.prepareMs);
  expect(firstTile).not.toBeNull();
  expect(firstTile ?? Number.POSITIVE_INFINITY).toBeLessThan(BUDGET.firstTileMs);
  expect(stroke.render.p95).toBeLessThan(BUDGET.strokeRenderP95Ms);
  expect(stroke.pageDropped).toBeLessThanOrEqual(BUDGET.strokeDroppedFrames);
  expect(stroke.rafDropped).toBeLessThanOrEqual(BUDGET.strokeRafDroppedMax);
  expect(copy.outcome).toBe('smart');
  expect(copy.cacheHit).toBe(true);
  expect(copy.ms).toBeLessThan(BUDGET.copyWarmMs);
});
