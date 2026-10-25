import { captureFull } from './capture.helpers';
import { expect, test } from './fixtures';

/**
 * Time from opening the editor tab to the first display tile, measured with the compositor's
 * performance marks in the real editor after a real capture.
 */
for (const fixture of ['bands', 'inner-scroller', 'lazy-images']) {
  test(`editor gets its first tile quickly after capturing ${fixture}`, async ({
    pagesnap,
    serviceWorker,
  }) => {
    const page = await pagesnap.openFixture(fixture);
    const { editor, timings } = await captureFull(pagesnap, serviceWorker, page);
    const marks = await editor.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const first = performance.getEntriesByName('pagesnap:first-tile')[0];
        if (first) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const get = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? null;
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      return {
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        sourceOpen: get('pagesnap:source-open'),
        firstTile: get('pagesnap:first-tile'),
      };
    });
    console.log(
      `[perf ${fixture}] capture ${JSON.stringify({ total: timings?.totalMs, slices: timings?.slices, prepare: timings?.prepareMs })} editor ${JSON.stringify(marks)}`,
    );
    expect(marks.firstTile).not.toBeNull();
    // Target is < 300 ms (measured ~130–280 ms); the guard is looser so parallel e2e runs on a
    // busy machine don't flake.
    expect(marks.firstTile ?? Number.POSITIVE_INFINITY).toBeLessThan(500);
  });
}
