/**
 * True end-to-end flow on the Canvas LMS replica: the page doesn't scroll, `#content` does. The
 * capture expands that panel in place; Cmd+C copies the area around the marks when the result is
 * taller than 2576 CSS px (what AI models read at full resolution), else the whole page.
 */
import { AI_MAX_LONG_EDGE_CSS } from '@/shared/limits';
import { hexToRgb, near, pixel } from './engine.helpers';
import { expect, test } from './fixtures';
import { type CopyResult, runFlow } from './flow.helpers';

test.setTimeout(120_000);

/** The dark global nav runs down the left edge of every copy, top to bottom. */
function navPixels(c: CopyResult) {
  const nav = hexToRgb('#394b58');
  const { scale, region } = c.plan;
  const x = Math.round((10 / scale - region.x) * scale);
  for (const f of [0.02, 0.5, 0.98]) {
    const y = Math.round(c.png.height * f);
    // Skip the nav's icons/avatar near the very top.
    if (region.y === 0 && y < 160) continue;
    expect(near(pixel(c.png, x, y), nav, 4), `global nav at (${x}, ${y})`).toBe(true);
  }
}

test('inner scroller: capture, annotate, copy, copy full, download, reload, page restored', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  const r = await runFlow(context, pagesnap, serviceWorker, 'inner-scroller', {
    prepare: (page) => page.evaluate(() => document.querySelector('#content')?.scrollTo(0, 400)),
    defaultOutcome: (s) => (s.css.h > AI_MAX_LONG_EDGE_CSS ? 'smart' : 'full'),
    pagePixels: navPixels,
  });
  expect(r.session.warnings.map((w) => w.code)).toContain('INNER_SCROLLER');
  // The replica's content is ~4300 px, so this exercises the smart region.
  expect(r.session.css.h).toBeGreaterThan(AI_MAX_LONG_EDGE_CSS);
  expect(r.copyDefault.plan.outcome).toBe('smart');
});
