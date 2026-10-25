/**
 * Renders the Open Graph card (site/public/og.png, 1200 × 630) from the real product: the marks
 * come from the editor's own renderer (the features section's markup canvas, all tools drawn),
 * set beside the headline.
 *
 *   pnpm site:build && pnpm site:preview &      (serves on :4181)
 *   node site/scripts/render-og.mjs [baseUrl]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const base = process.argv[2] ?? 'http://localhost:4181/';

const browser = await chromium.launch({ headless: true });
try {
  // 1. Marks drawn by the editor's own renderer (`drawDoc`): the features section's markup
  //    canvas, which under reduced motion shows every tool's mark at once.
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.goto(base);
  const stage = page.locator('[data-visual="tools"] .stage-shot');
  await stage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const shot = await stage.screenshot();
  await ctx.close();

  // 2. The card.
  const font = (await readFile(join(site, 'public/fonts/geist.woff2'))).toString('base64');
  const icon = (await readFile(join(site, '../public/icon/128.png'))).toString('base64');
  const card = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  const og = await card.newPage();
  await og.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #0b0b0c; color: #ededee; font-family: Geist, sans-serif; }
    .brand { position: absolute; left: 72px; top: 64px; display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
    .brand img { width: 40px; height: 40px; border-radius: 9px; }
    h1 { position: absolute; left: 72px; top: 178px; width: 520px; margin: 0; font-size: 76px; line-height: 1; font-weight: 600; letter-spacing: -0.05em; }
    .u { position: relative; white-space: nowrap; }
    .u::after { content: ""; position: absolute; left: 0; right: -2px; bottom: -4px; height: 7px; border-radius: 9px; background: #ff3b30; }
    p { position: absolute; left: 72px; bottom: 64px; margin: 0; color: rgb(237 237 238 / 0.62); font-size: 25px; letter-spacing: -0.01em; }
    .shot { position: absolute; left: 620px; top: 150px; width: 760px; height: 332px; border-radius: 14px; overflow: hidden; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.1), 0 30px 80px -20px rgb(0 0 0 / 0.8); background: #2b2b2f; }
    .shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 0 50%; }
  </style></head><body>
    <div class="brand"><img src="data:image/png;base64,${icon}">Page Snap</div>
    <h1>Show the AI <span class="u">exactly</span> what you mean.</h1>
    <p>Free, open-source Chrome extension</p>
    <div class="shot"><img src="data:image/png;base64,${shot.toString('base64')}"></div>
  </body></html>`);
  await og.evaluate(() => document.fonts.ready);
  await og.waitForTimeout(200);
  await writeFile(join(site, 'public/og.png'), await og.screenshot({ type: 'png' }));
  console.log('site/public/og.png');
} finally {
  await browser.close();
}
