/**
 * Headless screenshots of the built site, for design review:
 *   pnpm site:build && pnpm site:preview &   (serves on :4181)
 *   node site/scripts/shots.mjs [outDir] [baseUrl]
 * Full-page and first-screen shots at 390, 768 and 1440 wide, dark and light. Never headed.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const out = process.argv[2] ?? '/tmp/pagesnap-site/shots';
const base = process.argv[3] ?? 'http://localhost:4181/';
const SIZES = [
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '768', width: 768, height: 1024, mobile: true },
  { name: '1440', width: 1440, height: 900, mobile: false },
];

const SECTIONS = [
  ['capture', '[aria-labelledby="f-capture"]'],
  ['markup', '[aria-labelledby="f-markup"]'],
  ['size', '[aria-labelledby="f-size"]'],
  ['pair', '.pair'],
  ['install', '#install'],
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const scheme of ['dark', 'light']) {
    for (const s of SIZES) {
      const ctx = await browser.newContext({
        viewport: { width: s.width, height: s.height },
        deviceScaleFactor: 2,
        colorScheme: scheme,
        isMobile: s.mobile,
        hasTouch: s.mobile,
      });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="demo"]', { timeout: 15_000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${s.name}-${scheme}-top.png` });
      // Walk down once so lazy visuals and reveals run, then shoot the whole page.
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < h; y += s.height * 0.8) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(160);
      }
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${s.name}-${scheme}-full.png`, fullPage: true });
      // Each section on its own, after its visual has had time to run.
      for (const [name, sel] of SECTIONS) {
        const el = page.locator(sel).first();
        await el.scrollIntoViewIfNeeded();
        await page.evaluate((ss) => {
          const r = document.querySelector(ss)?.getBoundingClientRect();
          if (r) window.scrollBy(0, r.top - 72);
        }, sel);
        await page.waitForTimeout(2600);
        await page.screenshot({ path: `${out}/${s.name}-${scheme}-${name}.png` });
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      console.log(`${s.name} ${scheme}${overflow > 0 ? ` HORIZONTAL OVERFLOW ${overflow}px` : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
