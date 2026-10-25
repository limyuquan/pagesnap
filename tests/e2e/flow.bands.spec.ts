/**
 * True end-to-end flow on bands.html (8000 CSS px): capture → draw every tool → Cmd+C copies the
 * area around the marks → Shift+Cmd+C copies the full page → Download → reload → tab restored.
 */
import { hexToRgb, near, pixel } from './engine.helpers';
import { expect, test } from './fixtures';
import { type CopyResult, runFlow } from './flow.helpers';

test.setTimeout(120_000);

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

/** Every band whose middle is inside the copy shows its colour (away from labels and marks). */
function bandPixels(c: CopyResult) {
  const { region, scale } = c.plan;
  let checked = 0;
  for (let band = 0; band < 16; band++) {
    // Image px of this band's lower middle, in the right third (labels sit top-left and bottom-right).
    const dpr = 1 / scale;
    const imgY = (band * 500 + 330) * dpr;
    const imgX = region.x + region.w * 0.8;
    if (imgY < region.y || imgY >= region.y + region.h) continue;
    const x = Math.round((imgX - region.x) * scale);
    const y = Math.round((imgY - region.y) * scale);
    const want = hexToRgb(COLORS[band % 8] ?? '#000000');
    const got = pixel(c.png, x, y);
    expect(near(got, want, 3), `band ${band} at copy (${x}, ${y}): ${got} vs ${want}`).toBe(true);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

test('bands: capture, annotate, copy, copy full, download, reload, page restored', async ({
  context,
  pagesnap,
  serviceWorker,
}) => {
  const r = await runFlow(context, pagesnap, serviceWorker, 'bands', {
    prepare: (page) => page.evaluate(() => window.scrollTo(0, 1234)),
    // Draw a few screens down, over band 5/6 territory.
    panCss: 1200,
    defaultOutcome: () => 'smart',
    pagePixels: bandPixels,
  });
  expect(r.session.css.h).toBe(8000);
  expect(r.copyFull.png.height).toBe(8000);
});
