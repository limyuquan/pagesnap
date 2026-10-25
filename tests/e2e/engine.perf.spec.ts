/**
 * Performance measurements for the editor engine. Skipped unless PAGESNAP_PERF=1:
 *   PAGESNAP_PERF=1 PAGESNAP_E2E_ID=b pnpm exec playwright test tests/e2e/engine.perf.spec.ts
 * Prints a JSON summary per test. Asserts only loose budgets (headless numbers vary).
 */
import type { Page } from '@playwright/test';
import { snapshot, toPage, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

test.skip(!process.env.PAGESNAP_PERF, 'set PAGESNAP_PERF=1 to run the performance measurements');
test.setTimeout(180_000);

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0) };
}

/** Start sampling rAF intervals and our render times. */
async function startSampling(ed: Page) {
  await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__pagesnapEngine.perf.resetFrames();
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
}

async function stopSampling(ed: Page) {
  return ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__rafOn = false;
    return {
      raf: w.__raf.slice(1) as number[],
      render: [...w.__pagesnapEngine.perf.frames] as number[],
    };
  });
}

function frameReport(sample: { raf: number[]; render: number[] }) {
  return {
    renderMs: stats(sample.render),
    rafIntervalMs: stats(sample.raf),
    // A frame counts as dropped when the interval exceeds 1.5 × 16.7 ms.
    droppedFrames: sample.raf.filter((d) => d > 25).length,
  };
}

async function copyLatency(ed: Page, keys: string) {
  await ed.bringToFront();
  const before = await ed.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    () => (window as any).__pagesnapEngine.perf.copies.length as number,
  );
  await ed.keyboard.press(keys);
  await expect
    .poll(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: test hook
        ed.evaluate(() => (window as any).__pagesnapEngine.perf.copies.length as number),
      { timeout: 60_000 },
    )
    .toBe(before + 1);
  const s = await snapshot(ed);
  // biome-ignore lint/suspicious/noExplicitAny: test hook
  const rec = await ed.evaluate(() => (window as any).__pagesnapEngine.perf.copies.at(-1));
  return {
    outcome: s.copy.outcome,
    size: s.copy.size,
    ms: Math.round(rec.ms),
    cacheHit: rec.cacheHit,
  };
}

/** Wait until the default copy and the composite are pre-encoded for the current rev. */
async function waitPrewarmed(ed: Page) {
  await expect
    .poll(
      () =>
        ed.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: test hook
          const s = (window as any).__pagesnapEngine.state();
          return s._compositeRev === s.doc.rev;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

test('1400×30000 at DPR 2: first tiles, stroke and pan frame times, copy latency', async ({
  pagesnap,
  context,
}) => {
  const seedT0 = Date.now();
  const id = await pagesnap.seedSession({ cssW: 1400, cssH: 30_000 });
  const seedMs = Date.now() - seedT0;
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  const firstTiles = await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const p = (window as any).__pagesnapEngine.perf;
    return {
      fromNavigationMs: Math.round(p.firstTilesFromNav),
      fromInitMs: Math.round(p.firstTilesFromInit),
    };
  });

  // --- Pen stroke: ~60 Hz pointer input for 2 s.
  await ed.keyboard.press('p');
  const start = await toPage(ed, 300, 400);
  await ed.mouse.move(start.x, start.y);
  await startSampling(ed);
  await ed.mouse.down();
  for (let i = 0; i < 120; i++) {
    await ed.mouse.move(start.x + i * 6, start.y + Math.sin(i / 8) * 80);
    await ed.waitForTimeout(16);
  }
  await ed.mouse.up();
  const stroke = frameReport(await stopSampling(ed));

  // --- Arrow drag (draft redraw each frame) with 15 committed shapes on screen.
  await ed.keyboard.press('a');
  for (let k = 0; k < 15; k++) {
    const a = await toPage(ed, 200 + k * 150, 900);
    await ed.mouse.move(a.x, a.y);
    await ed.mouse.down();
    await ed.mouse.move(a.x + 60, a.y + 80, { steps: 3 });
    await ed.mouse.up();
  }
  const a0 = await toPage(ed, 400, 1200);
  await ed.mouse.move(a0.x, a0.y);
  await startSampling(ed);
  await ed.mouse.down();
  for (let i = 0; i < 90; i++) {
    await ed.mouse.move(a0.x + i * 5, a0.y + i * 2);
    await ed.waitForTimeout(16);
  }
  await ed.mouse.up();
  const arrowDrag = frameReport(await stopSampling(ed));

  // --- Trackpad-style panning: 150 wheel events, 16 ms apart, ~15k image px down.
  await startSampling(ed);
  for (let i = 0; i < 150; i++) {
    await ed.mouse.wheel(0, 50);
    await ed.waitForTimeout(16);
  }
  await ed.waitForTimeout(200);
  const pan = frameReport(await stopSampling(ed));
  const tilesAfterPan = await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const s = (window as any).__pagesnapEngine.state();
    return { y: Math.round(s.camera.y) };
  });

  // --- Copy latency. Smart region (prewarmed), then a cold full-page copy.
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.setCamera({ y: 0 }),
  );
  await waitPrewarmed(ed);
  const smartWarm = await copyLatency(ed, 'ControlOrMeta+c');
  const fullCached = await copyLatency(ed, 'ControlOrMeta+Shift+c'); // composite = full copy
  // Cold: a fresh edit invalidates the caches, copy before the prewarm kicks in.
  await ed.keyboard.press('a');
  const c = await toPage(ed, 600, 500);
  await ed.mouse.move(c.x, c.y);
  await ed.mouse.down();
  await ed.mouse.move(c.x + 80, c.y + 40, { steps: 3 });
  await ed.mouse.up();
  const smartCold = await copyLatency(ed, 'ControlOrMeta+c');
  await ed.mouse.move(c.x, c.y + 60);
  await ed.mouse.down();
  await ed.mouse.move(c.x + 80, c.y + 100, { steps: 3 });
  await ed.mouse.up();
  const fullCold = await copyLatency(ed, 'ControlOrMeta+Shift+c');

  const report = {
    session: '1400×30000 CSS @ DPR 2 (2800×60000 image px)',
    seedMs,
    firstTiles,
    stroke,
    arrowDrag,
    pan: { ...pan, endCameraY: tilesAfterPan.y },
    copy: { smartWarm, fullCached, smartCold, fullCold },
  };
  console.log(`PERF ${JSON.stringify(report, null, 2)}`);
  void context;
  expect(stroke.renderMs.p95).toBeLessThan(16);
  expect(pan.renderMs.p95).toBeLessThan(16);
});

test('typical page copy latency (1280×2400 at DPR 2)', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 2400 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  const a = await toPage(ed, 300, 400);
  await ed.mouse.move(a.x, a.y);
  await ed.mouse.down();
  await ed.mouse.move(a.x + 200, a.y + 100, { steps: 4 });
  await ed.mouse.up();
  const cold = await copyLatency(ed, 'ControlOrMeta+c');
  await ed.mouse.move(a.x, a.y + 200);
  await ed.mouse.down();
  await ed.mouse.move(a.x + 200, a.y + 300, { steps: 4 });
  await ed.mouse.up();
  await waitPrewarmed(ed);
  const warm = await copyLatency(ed, 'ControlOrMeta+c');
  console.log(`PERF ${JSON.stringify({ session: '1280×2400 CSS @ DPR 2', cold, warm }, null, 2)}`);
  expect(warm.cacheHit).toBe(true);
});

test('huge page (1280×70000 at DPR 2): first tiles and copy latency', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 70_000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  const firstTiles = await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const p = (window as any).__pagesnapEngine.perf;
    return {
      fromNavigationMs: Math.round(p.firstTilesFromNav),
      fromInitMs: Math.round(p.firstTilesFromInit),
    };
  });
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.setCamera({ y: 60_000 }),
  );
  const a = await toPage(ed, 300, 60_400);
  await ed.mouse.move(a.x, a.y);
  await ed.mouse.down();
  await ed.mouse.move(a.x + 200, a.y + 100, { steps: 4 });
  await ed.mouse.up();
  const smartCold = await copyLatency(ed, 'ControlOrMeta+c');
  await waitPrewarmed(ed);
  const smartWarm = await copyLatency(ed, 'ControlOrMeta+c');
  const full = await copyLatency(ed, 'ControlOrMeta+Shift+c');
  // Native download path (stream-encoded: 2560×140000 exceeds one canvas).
  const t0 = Date.now();
  const nativeBytes = await ed.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const blob = await (window as any).__pagesnapEngine.state()._engine._exportNative('full');
    return blob.size as number;
  });
  const nativeMs = Date.now() - t0;
  console.log(
    `PERF ${JSON.stringify(
      {
        session: '1280×70000 CSS @ DPR 2 (2560×140000 image px)',
        firstTiles,
        copy: { smartCold, smartWarm, full },
        nativeFullExport: { ms: nativeMs, mb: Math.round(nativeBytes / 1e5) / 10 },
      },
      null,
      2,
    )}`,
  );
});
