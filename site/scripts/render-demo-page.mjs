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
  plusButton: '.plan.featured .btn',
};

const LAYOUTS = [
  { name: 'desktop', width: 1200, height: 800, posterCss: 1000 },
  { name: 'mobile', width: 390, height: 760, posterCss: 1300 },
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
    // `rows` limits the encode to the top of the page (the poster: the first paint of the demo,
    // a fraction of the full image's bytes).
    // Encode a region (image px) of the screenshot, optionally scaled, as WebP.
    const encode = (crop = null, scale = 1) =>
      page.evaluate(
        async ({ b64, q, crop, scale }) => {
          const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
          const bmp = await createImageBitmap(blob);
          const r = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
          const c = new OffscreenCanvas(Math.round(r.w * scale), Math.round(r.h * scale));
          const ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
          const out = await c.convertToBlob({ type: 'image/webp', quality: q });
          const buf = new Uint8Array(await out.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000)
            s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return btoa(s);
        },
        { b64: png.toString('base64'), q: QUALITY, crop, scale },
      );
    const save = async (name, b64) => {
      const bytes = Buffer.from(b64, 'base64');
      await writeFile(join(site, 'public/demo', name), bytes);
      return bytes.length;
    };
    await mkdir(join(site, 'public/demo'), { recursive: true });
    const file = `fernhill-${layout.name}.webp`;
    const size = await save(file, await encode());
    const posterFile = `fernhill-${layout.name}-top.webp`;
    const posterCss = layout.posterCss;
    const posterSize = await save(
      posterFile,
      await encode({ x: 0, y: 0, w: info.w * DPR, h: posterCss * DPR }),
    );
    if (layout.name === 'desktop') {
      // The features section: the left of the page around the first seam, and the whole page
      // small (it's shown at most ~300 CSS px wide).
      await save('fernhill-seam.webp', await encode({ x: 0, y: 0, w: 640 * DPR, h: 1000 * DPR }));
      await save('fernhill-column.webp', await encode(null, 0.25));
    }
    out.layouts[layout.name] = {
      src: `demo/${file}`,
      poster: { src: `demo/${posterFile}`, h: posterCss },
      css: { w: info.w, h: info.h },
      viewport: { w: layout.width, h: layout.height },
      targets: info.rects,
    };
    console.log(
      `${file}: ${info.w}x${info.h} css, ${(size / 1024).toFixed(0)} KB; poster ${(posterSize / 1024).toFixed(0)} KB`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
}
await writeFile(join(site, 'src/demo/pageData.json'), `${JSON.stringify(out, null, 2)}\n`);
