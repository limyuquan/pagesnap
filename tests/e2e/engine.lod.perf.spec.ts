/**
 * Zoomed-out performance on a page the size of Wikipedia's "World War II" captured at DPR 2
 * (2560 × 118548 image px), with a synthetic session (qa-stress S1, correctness #2):
 * - zero tile loads while idle, at every zoom;
 * - 60 fps panning at 25% and 10%;
 * - each ⌘− step paints its next frame within 50 ms.
 *
 * Prints a `PERF {...}` JSON line with the raw numbers.
 */
import type { Page } from '@playwright/test';
import { waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

test.setTimeout(240_000);

const CSS_W = 1280;
const CSS_H = 59_274; // × DPR 2 = 2560 × 118548

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0) };
}

/** Count every base-tile request the renderer makes (whatever the source method is called). */
async function instrument(ed: Page) {
  await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    const src = w.__pagesnapEngine.state().source;
    w.__loads = 0;
    for (const name of ['getTileBitmap', 'getRegionBitmap']) {
      const orig = src[name];
      if (typeof orig !== 'function') continue;
      src[name] = (...args: unknown[]) => {
        w.__loads++;
        return orig.apply(src, args);
      };
    }
  });
}

async function setZoomPct(ed: Page, pct: number, yFrac = 0.4) {
  await ed.evaluate(
    ([p, f]) => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      const s = (window as any).__pagesnapEngine.state();
      s._engine._panZoom({
        x: 0,
        y: s.session.image.h * (f as number),
        zoom: (p as number) / 100 / s.session.dpr,
      });
    },
    [pct, yFrac],
  );
}

/** Tile requests during `ms` of idle time, plus the rAF intervals meanwhile. */
async function idleLoads(ed: Page, ms: number) {
  return ed.evaluate(async (dur) => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__loads = 0;
    const gaps: number[] = [];
    let last = performance.now();
    const t0 = last;
    await new Promise<void>((done) => {
      const tick = (t: number) => {
        gaps.push(t - last);
        last = t;
        if (t - t0 < dur) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return { loads: w.__loads as number, gaps: gaps.slice(1) };
  }, ms);
}

interface TileStats {
  level: number;
  inFlight: number;
  loads: number;
  residentMB: number;
  wantedMB: number;
  wantedMissing: number;
}

const tileStats = (ed: Page) =>
  // biome-ignore lint/suspicious/noExplicitAny: test hook
  ed.evaluate(() => (window as any).__pagesnapEngine.tiles() as TileStats);

/** Wait (bounded) until the tile cache has everything it wants and nothing in flight. */
async function settle(ed: Page, maxMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    await ed.waitForTimeout(100);
    const t = await tileStats(ed);
    if ((t.inFlight === 0 && t.wantedMissing === 0) || Date.now() - t0 > maxMs) {
      return Date.now() - t0;
    }
  }
}

/** Pan with one wheel event per animation frame; returns rAF intervals. */
async function panFrames(ed: Page, frames: number, deltaCss: number, maxMs: number) {
  return ed.evaluate(
    async ([n, d, cap]) => {
      const c = document.querySelector('[data-testid="editor-canvas"]') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const gaps: number[] = [];
      let last = performance.now();
      const t0 = last;
      let dir = 1;
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      const st = () => (window as any).__pagesnapEngine.state();
      for (let i = 0; i < (n as number); i++) {
        const t = await new Promise<number>((res) => requestAnimationFrame(res));
        gaps.push(t - last);
        last = t;
        if (t - t0 > (cap as number)) break;
        const s = st();
        const y = s.camera.y;
        if (y > s.session.image.h * 0.85) dir = -1;
        if (y < s.session.image.h * 0.05) dir = 1;
        c.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: (d as number) * dir,
            clientX: r.x + r.width / 2,
            clientY: r.y + r.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return gaps.slice(1);
    },
    [frames, deltaCss, maxMs],
  );
}

/** ⌘− presses; per press: ms from keydown to the end of the next rendered frame. */
async function zoomOutSteps(ed: Page, presses: number) {
  await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__keyAt = [];
    w.__frameEnds = [];
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === '-') w.__keyAt.push(performance.now());
      },
      { capture: true },
    );
    const loop = () => {
      // rAF callbacks run before paint; a frame "ends" when the next task after it runs.
      requestAnimationFrame(() => {
        setTimeout(() => w.__frameEnds.push(performance.now()), 0);
        if (w.__frameEnds.length < 100_000) loop();
      });
    };
    loop();
  });
  for (let i = 0; i < presses; i++) {
    await ed.keyboard.press('ControlOrMeta+-');
    await ed.waitForTimeout(250);
  }
  return ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    const ends = w.__frameEnds as number[];
    return (w.__keyAt as number[]).map((k) => {
      const e = ends.find((t) => t > k);
      return e === undefined ? 10_000 : e - k;
    });
  });
}

test('2560×118548 at DPR 2: no idle tile loads, 60 fps pan at 25% and 10%, fast ⌘− steps', async ({
  pagesnap,
}) => {
  const id = await pagesnap.seedSession({ cssW: CSS_W, cssH: CSS_H, dpr: 2 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  // The right-click "Copy image" (= the default ⌘C) must exist soon after the editor is ready.
  const compositeAfterReadyMs = await ed.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const e = (window as any).__pagesnapEngine;
    while (!e.state()._compositeUrl) await new Promise((r) => setTimeout(r, 10));
    return performance.now() - e.perf.firstTilesFromNav;
  });
  await instrument(ed);
  const report: Record<string, unknown> = {
    compositeAfterReadyMs: Math.round(compositeAfterReadyMs),
  };

  // Idle at several zooms: after the view settles, nothing may load.
  const idle: Record<string, unknown> = {};
  for (const pct of [96, 50, 33, 25, 10, 5]) {
    await setZoomPct(ed, pct);
    const settleMs = await settle(ed);
    const r = await idleLoads(ed, 2_000);
    idle[pct] = { settleMs, loads: r.loads, raf: stats(r.gaps), tiles: await tileStats(ed) };
  }
  report.idle = idle;

  // Pans: one wheel event per frame.
  const pan: Record<string, ReturnType<typeof stats> & { over25: number }> = {};
  for (const pct of [25, 10]) {
    await setZoomPct(ed, pct, 0.2);
    await settle(ed);
    const gaps = await panFrames(ed, 180, 60, 20_000);
    pan[pct] = { ...stats(gaps), over25: gaps.filter((g) => g > 25).length };
  }
  report.pan = pan;

  // ⌘− from fit width down to the 5% floor.
  await ed.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__pagesnapEngine.state().actions.fitWidth(),
  );
  await settle(ed);
  const steps = await zoomOutSteps(ed, 14);
  report.zoomOutStepMs = steps.map((s) => Math.round(s));
  await settle(ed);
  const finalIdle = await idleLoads(ed, 2_000);
  report.idleAtMin = { loads: finalIdle.loads, raf: stats(finalIdle.gaps) };
  report.tilesAtMin = await tileStats(ed);
  console.log(`PERF ${JSON.stringify(report)}`);

  for (const [pct, r] of Object.entries(idle)) {
    expect((r as { loads: number }).loads, `idle tile loads at ${pct}%`).toBe(0);
  }
  expect(finalIdle.loads, 'idle tile loads at 5% after ⌘−').toBe(0);
  for (const [pct, r] of Object.entries(pan)) {
    expect(r.p95, `pan rAF p95 at ${pct}%`).toBeLessThanOrEqual(20);
    expect(r.over25, `dropped frames panning at ${pct}%`).toBeLessThanOrEqual(r.n * 0.03);
  }
  expect(compositeAfterReadyMs, 'right-click image after ready').toBeLessThan(600);
  for (const [i, ms] of steps.entries()) {
    expect(ms, `⌘− step ${i + 1}`).toBeLessThan(50);
  }
});
