/** True end-to-end flow on short.html (one viewport): Cmd+C copies the whole page. */
import { hexToRgb, near, pixel } from './engine.helpers';
import { expect, test } from './fixtures';
import { type CopyResult, runFlow } from './flow.helpers';

test.setTimeout(120_000);

function shortPixels(c: CopyResult) {
  // The blue box fills the top 400 CSS px; below it is white page background.
  expect(near(pixel(c.png, c.png.width - 20, 380), hexToRgb('#0a84ff'), 3)).toBe(true);
  if (c.png.height > 440) {
    expect(near(pixel(c.png, c.png.width - 20, 430), [255, 255, 255], 3)).toBe(true);
  }
}

test('short page: capture, annotate, full copy, download, reload, page restored', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  const r = await runFlow(context, pagesnap, serviceWorker, 'short', {
    defaultOutcome: () => 'full',
    pagePixels: shortPixels,
  });
  expect(r.session.slices).toHaveLength(1);
  // Cmd+C and Shift+Cmd+C give the same full image on a short page.
  expect(r.copyDefault.plan.size).toEqual(r.copyFull.plan.size);
});
