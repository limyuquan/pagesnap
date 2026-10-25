/**
 * Renders the fictional page the website demo "captures" (site/demo-page/fernhill.html) with
 * headless Chromium, at 2x, in a desktop and a phone layout:
 *
 *   site/public/demo/fernhill-desktop.webp, fernhill-mobile.webp   the full pages
 *   site/src/demo/pageData.json                                     sizes + hint targets (CSS px)
 *
 * The outputs are committed, so building the site never needs a browser. Re-run after editing
 * the page: `node site/scripts/render-demo-page.mjs`. Always headless.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const pageUrl = pathToFileURL(join(site, 'demo-page/fernhill.html')).href;
const DPR = 2;
const QUALITY = 0.9;

/** Elements the demo's hints point at. */
const TARGETS = {
  plusPrice: '#plus-price',
  tablePrice: '#table-plus-price',
  refund: '#refund-line',
  teamButton: '#team-button',
  teamCard: '#team-card',
  teamPrice: '#team-card .price b',
  plusBilled: '.plan.featured .billed',
  plusOffline: '.plan.featured li:nth-child(4)',
};

const LAYOUTS = [
  { name: 'desktop', width: 1200, height: 800 },
  { name: 'mobile', width: 390, height: 760 },
];

const browser = await chromium.launch({ headless: true });
const out = { dpr: DPR, layouts: {} };
try {
  for (const layout of LAYOUTS) {
    const ctx = await browser.newContext({
      viewport: { width: layout.width, height: layout.height },
      deviceScaleFactor: DPR,
    });
    const page = await ctx.newPage();
    await page.goto(pageUrl);
    await page.evaluate(() => document.fonts.ready);
    const info = await page.evaluate((targets) => {
      const rects = {};
      for (const [k, sel] of Object.entries(targets)) {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        if (r) rects[k] = { x: r.x, y: r.y + scrollY, w: r.width, h: r.height };
      }
      return {
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
        rects,
      };
    }, TARGETS);
    const png = await page.screenshot({ fullPage: true, type: 'png' });
    // Encode to WebP with Chromium's own encoder (no image tooling needed).
    const webp = await page.evaluate(
      async ({ b64, q }) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0);
        const out = await c.convertToBlob({ type: 'image/webp', quality: q });
        const buf = new Uint8Array(await out.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000)
          s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      },
      { b64: png.toString('base64'), q: QUALITY },
    );
    const file = `fernhill-${layout.name}.webp`;
    const bytes = Buffer.from(webp, 'base64');
    await mkdir(join(site, 'public/demo'), { recursive: true });
    await writeFile(join(site, 'public/demo', file), bytes);
    out.layouts[layout.name] = {
      src: `demo/${file}`,
      css: { w: info.w, h: info.h },
      viewport: { w: layout.width, h: layout.height },
      targets: info.rects,
    };
    console.log(`${file}: ${info.w}x${info.h} css, ${(bytes.length / 1024).toFixed(0)} KB`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
await writeFile(join(site, 'src/demo/pageData.json'), `${JSON.stringify(out, null, 2)}\n`);
