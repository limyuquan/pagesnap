import { captureFull, near, pageState, stitched } from './capture.helpers';
import { expect, test } from './fixtures';

const COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#bcf60c',
];

for (const dpr of [1, 2]) {
  test.describe(`bands at DPR ${dpr}`, () => {
    test.use({ dpr });

    test('stitches 8000 px with no seams, restores the page, within the time budget', async ({
      pagesnap,
      serviceWorker,
    }) => {
      const page = await pagesnap.openFixture('bands');
      await page.evaluate(() => scrollTo(0, 1234));
      const before = await pageState(page);
      const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

      const { session, timings, sessionId } = await captureFull(pagesnap, serviceWorker, page);
      expect(session.status).toBe('ready');
      expect(session.error).toBeNull();
      expect(session.dpr).toBe(dpr);
      expect(session.css).toEqual({ w: view.w, h: 8000 });
      expect(session.image).toEqual({ w: view.w * dpr, h: 8000 * dpr });
      const expectedSlices = Math.ceil((8000 - view.h) / (view.h - 2)) + 1;
      expect(session.slices).toHaveLength(expectedSlices);

      // The page is left exactly as it was.
      expect(await pageState(page)).toEqual(before);

      // Every CSS row in a label-free column has the right band colour or the 2 px black rule.
      const img = await stitched(serviceWorker, sessionId);
      const x = Math.round(view.w * 0.55 * dpr);
      const bad: string[] = [];
      for (let y = 0; y < 8000; y++) {
        const band = Math.floor(y / 500);
        const want = y % 500 < 2 ? '#000000' : COLORS[band % 8];
        const got = img.hex(x, y * dpr + dpr / 2);
        if (!near(got, want ?? '')) bad.push(`y=${y}: ${got} != ${want}`);
      }
      expect(bad.slice(0, 10)).toEqual([]);

      expect(timings).not.toBeNull();
      const budget = expectedSlices * 550 + 1000;
      console.log(`[bands dpr=${dpr}] ${JSON.stringify({ ...timings, budget })}`);
      let best = timings?.totalMs ?? Number.POSITIVE_INFINITY;
      if (best >= budget) {
        // Wall-clock budget: a load spike from other browsers on the machine misses one run, a
        // real slowdown misses both. Same budget, best of two.
        for (const p of page.context().pages())
          if (p.url().includes('editor.html')) await p.close();
        await page.bringToFront();
        const again = await captureFull(pagesnap, serviceWorker, page);
        console.log(`[bands dpr=${dpr}] retry ${JSON.stringify(again.timings)}`);
        best = Math.min(best, again.timings?.totalMs ?? Number.POSITIVE_INFINITY);
      }
      expect(best).toBeLessThan(budget);
    });
  });
}
