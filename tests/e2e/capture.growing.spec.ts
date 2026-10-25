/**
 * Pages that change height while they are captured (qa-sitesA issues 1 and 2: react.dev's code
 * blocks mounting, the Guardian's footer loading at the end). `growing.html` expands code blocks
 * and collapses placeholders once they have been on screen for 200 ms, and appends bands when the
 * end has been in view for 300 ms (three times). Every band must appear exactly once, whole, in
 * page order, including the ones loaded at the end; growth that was absorbed is not a warning.
 */
import type { Worker } from '@playwright/test';
import { captureFull, dump, type Img, near, stitched } from './capture.helpers';
import { expect, test } from './fixtures';

interface Run {
  color: string;
  y: number;
  h: number;
}

/** Colour runs down column `x` of `img` (image px). */
function runsAt(img: Img, x: number): Run[] {
  const out: Run[] = [];
  for (let y = 0; y < img.height; y++) {
    const c = img.hex(x, y);
    const prev = out[out.length - 1];
    if (prev && near(prev.color, c, 10)) prev.h++;
    else out.push({ color: c, y, h: 1 });
  }
  return out;
}

async function check(sw: Worker, id: string, palette: string[], dpr: number) {
  const img = await stitched(sw, id);
  const runs = runsAt(img, 20 * dpr);
  const bandRuns = runs.filter((r) => palette.some((p) => near(p, r.color, 10)));
  const seen = bandRuns.map((r) => palette.findIndex((p) => near(p, r.color, 10)));
  return { img, runs, bandRuns, seen };
}

for (const dpr of [1, 2]) {
  test.describe(`growing page at DPR ${dpr}`, () => {
    test.use({ dpr });

    test('every band once, whole and in order; the late footer is included', async ({
      pagesnap,
      serviceWorker,
    }) => {
      test.setTimeout(90_000);
      const page = await pagesnap.openFixture('growing');
      const trace: string[] = [];
      page.on('console', (m) => {
        if (m.text().startsWith('[pagesnap-agent]')) trace.push(m.text());
      });
      const { sessionId, session } = await captureFull(pagesnap, serviceWorker, page);
      await dump(serviceWorker, sessionId, `growing-dpr${dpr}`);
      const palette = await page.evaluate(() =>
        (window as unknown as { __fixture: { bands(): string[] } }).__fixture.bands(),
      );
      const loads = await page.evaluate(() =>
        (window as unknown as { __fixture: { loads(): number } }).__fixture.loads(),
      );
      const { bandRuns, seen } = await check(serviceWorker, sessionId, palette, dpr);
      const moved = session.slices.filter((s) => s.place).length;
      console.log(
        `[growing dpr=${dpr}] status=${session.status} slices=${session.slices.length} reanchored=${moved} loads=${loads} css=${JSON.stringify(session.css)} warnings=${session.warnings.map((w) => w.code)} seen=${seen.join(',')}`,
      );
      console.log(
        `[growing dpr=${dpr}] slices ${JSON.stringify(session.slices.map((s) => [s.scroll.y, s.place?.y, s.target.content.h]))} runs ${JSON.stringify(bandRuns.map((r) => [r.y, r.h]))}`,
      );
      expect(session.status).toBe('ready');
      expect(loads).toBe(3);
      // Each band whole: 298 px of colour under its 2 px rule.
      const wrong = bandRuns.filter((r) => Math.abs(r.h - 298 * dpr) > 2);
      if (wrong.length || new Set(seen).size !== seen.length) {
        console.log(`[growing dpr=${dpr}] agent trace\n  ${trace.join('\n  ')}`);
        console.log(`[growing dpr=${dpr}] wrong runs ${JSON.stringify(wrong)}`);
        console.log(
          `[growing dpr=${dpr}] slices ${JSON.stringify(session.slices.map((s) => [s.scroll.y, s.place?.y, s.target.content.h]))}`,
        );
      }
      // Every band exactly once, in page order: nothing duplicated or dropped at a seam.
      expect(seen).toEqual(palette.map((_, i) => i));
      expect(wrong).toEqual([]);
      // Growth that was followed or re-anchored isn't reported as a misalignment.
      expect(session.warnings.map((w) => w.code)).not.toContain('HEIGHT_CHANGED');
      expect(moved).toBeGreaterThan(0);
    });
  });
}
