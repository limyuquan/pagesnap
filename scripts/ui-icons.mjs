#!/usr/bin/env node
/**
 * Page Snap icon (owner: C). Regenerates public/icon/{16,32,48,128}.png from the SVG below, so the
 * mark is reproducible and reviewable as code. Rasterised with Playwright's bundled Chromium.
 *
 *   node scripts/ui-icons.mjs            # writes public/icon/*.png
 *   node scripts/ui-icons.mjs --preview  # also writes /tmp/pagesnap-qa/ui/icon-preview.png
 *
 * The mark: a white page on a graphite tile, cut off by the tile's bottom edge (the page keeps
 * going: a full-page capture), crossed by one red stroke (the mark you make before pasting it into
 * an AI chat). The 16 px toolbar size is drawn on its own pixel grid, not scaled down.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TILE = '#232327';
/** Hairline so the tile keeps its edge on dark toolbars. */
const RIM = 'rgba(255,255,255,0.14)';
const PAGE = '#f7f7f8';
const LINE = '#c9c9ce';
const RED = '#ff3b30';

/** Drawn on a 32-unit grid; `pad` insets the tile (Chrome wants breathing room at 48 and 128). */
function svg32(size, pad) {
  const s = 32 - pad * 2;
  const k = s / 32;
  const t = (v) => pad + v * k;
  const d = (v) => v * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <defs><clipPath id="tile"><rect x="${t(0)}" y="${t(0)}" width="${d(32)}" height="${d(32)}" rx="${d(7.5)}"/></clipPath></defs>
  <rect x="${t(0)}" y="${t(0)}" width="${d(32)}" height="${d(32)}" rx="${d(7.5)}" fill="${TILE}"/>
  <g clip-path="url(#tile)">
    <rect x="${t(8)}" y="${t(6)}" width="${d(16)}" height="${d(30)}" rx="${d(2)}" fill="${PAGE}"/>
    <rect x="${t(11)}" y="${t(10)}" width="${d(10)}" height="${d(1.6)}" rx="${d(0.8)}" fill="${LINE}"/>
    <rect x="${t(11)}" y="${t(13.4)}" width="${d(7)}" height="${d(1.6)}" rx="${d(0.8)}" fill="${LINE}"/>
    <rect x="${t(11)}" y="${t(24)}" width="${d(9)}" height="${d(1.6)}" rx="${d(0.8)}" fill="${LINE}"/>
    <rect x="${t(11)}" y="${t(27.4)}" width="${d(6)}" height="${d(1.6)}" rx="${d(0.8)}" fill="${LINE}"/>
    <rect x="${t(5.5)}" y="${t(17.6)}" width="${d(21)}" height="${d(3.4)}" rx="${d(1.7)}" fill="${RED}" transform="rotate(-8 ${t(16)} ${t(19.3)})"/>
  </g>
  <rect x="${t(0) + 0.5 / (size / 32)}" y="${t(0) + 0.5 / (size / 32)}" width="${d(32) - 1 / (size / 32)}" height="${d(32) - 1 / (size / 32)}" rx="${d(7.5) - 0.5 / (size / 32)}" fill="none" stroke="${RIM}" stroke-width="${1 / (size / 32)}"/>
</svg>`;
}

/**
 * 16 px: the page sits on whole pixels, no text lines (they turn to mush), and the red stroke is
 * thicker with a slight tilt so it reads as a hand-made mark, not a minus sign.
 */
function svg16() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <defs><clipPath id="tile"><rect width="16" height="16" rx="3.5"/></clipPath></defs>
  <rect width="16" height="16" rx="3.5" fill="${TILE}"/>
  <rect x=".5" y=".5" width="15" height="15" rx="3" fill="none" stroke="${RIM}"/>
  <g clip-path="url(#tile)">
    <rect x="4" y="3" width="8" height="14" rx="1" fill="${PAGE}" shape-rendering="crispEdges"/>
    <rect x="1.5" y="7.6" width="13" height="2.8" rx="1.4" fill="${RED}" transform="rotate(-12 8 9)"/>
  </g>
</svg>`;
}

const ICONS = {
  16: svg16(),
  32: svg32(32, 0),
  48: svg32(48, 1.5),
  128: svg32(128, 2.5),
};

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const outDir = resolve(root, 'public/icon');
mkdirSync(outDir, { recursive: true });
for (const [size, markup] of Object.entries(ICONS)) {
  const n = Number(size);
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${markup}</body></html>`,
  );
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  writeFileSync(resolve(outDir, `${size}.png`), png);
  console.log(`public/icon/${size}.png`);
}

if (process.argv.includes('--preview')) {
  // Each size at 1x and enlarged (pixelated), on dark and light toolbars.
  const cells = Object.entries(ICONS)
    .map(
      ([size, markup]) => `<div class="cell">
        <div class="row"><img style="flex:none;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}"><div class="big" style="width:${size * 4}px;height:${size * 4}px;max-width:256px;max-height:256px">
          <img src="data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}" style="image-rendering:pixelated;width:100%;height:100%"></div></div>
        <span>${size}px</span></div>`,
    )
    .join('');
  await page.setViewportSize({ width: 1200, height: 640 });
  await page.setContent(`<html><body style="margin:0;font:12px system-ui;display:grid;grid-template-rows:1fr 1fr">
    <div style="background:#202124;color:#aaa;display:flex;gap:40px;padding:20px;align-items:center">${cells}</div>
    <div style="background:#f1f3f4;color:#555;display:flex;gap:40px;padding:20px;align-items:center">${cells}</div>
    <style>.cell{display:grid;gap:8px;justify-items:start}.row{display:flex;gap:16px;align-items:center}</style></body></html>`);
  mkdirSync('/tmp/pagesnap-qa/ui', { recursive: true });
  await page.screenshot({ path: '/tmp/pagesnap-qa/ui/icon-preview.png' });
  console.log('/tmp/pagesnap-qa/ui/icon-preview.png');
}
await browser.close();
