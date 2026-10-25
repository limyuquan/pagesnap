/**
 * Frames the raw README shots (tests/e2e/readme.shots.spec.ts → /tmp/pagesnap-readme/) into
 * docs/images/. Headless Chromium renders a plain browser-window frame around each shot.
 *
 *   PAGESNAP_README_SHOTS=1 PAGESNAP_BROWSER=cft pnpm exec playwright test readme.shots
 *   node scripts/readme-images.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const RAW = process.env.PAGESNAP_README_RAW ?? '/tmp/pagesnap-readme';
const OUT = path.resolve('docs/images');
/** Output scale: the raw shots are DPR 2; 1.5 keeps text crisp at about half the bytes. */
const SCALE = 1.5;

const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const icon = dataUrl('public/icon/32.png');
const ghFavicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23fff' d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'/%3E%3C/svg%3E";

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent; font: 13px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  .stage { padding: 40px 48px 56px; display: inline-block; position: relative; }
  .win { border-radius: 12px; overflow: hidden; background: #202124; position: relative;
         box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 24px 60px rgba(0,0,0,.28), 0 6px 18px rgba(0,0,0,.18); }
  .tabs { height: 40px; display: flex; align-items: flex-end; padding: 0 12px; gap: 8px; }
  .lights { display: flex; gap: 8px; align-self: center; margin: 0 14px 0 4px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .tab { height: 32px; width: 260px; border-radius: 8px 8px 0 0; background: #35363a; color: #e8eaed;
         display: flex; align-items: center; gap: 8px; padding: 0 12px; white-space: nowrap; overflow: hidden; }
  .tab img { width: 16px; height: 16px; flex: none; }
  .tab span { overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 44px; background: #35363a; display: flex; align-items: center; gap: 14px; padding: 0 12px; color: #9aa0a6; }
  .nav { display: flex; gap: 16px; font-size: 16px; padding: 0 4px; }
  .omni { flex: 1; height: 32px; border-radius: 16px; background: #202124; color: #e8eaed; display: flex;
          align-items: center; padding: 0 16px; font-size: 14px; gap: 8px; }
  .omni .dim { color: #9aa0a6; }
  .chip { background: #3c4043; color: #e8eaed; border-radius: 10px; padding: 3px 8px; font-size: 12px; }
  .ext { position: relative; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; }
  .ext.on { background: #4a4b4f; }
  .ext img { width: 16px; height: 16px; }
  .badge { position: absolute; right: -6px; bottom: -1px; background: #232327; color: #fff; font: 700 9px/12px system-ui;
           padding: 0 3px; border-radius: 3px; }
  .avatar { width: 26px; height: 26px; border-radius: 50%; background: #5f6368; }
  .shot { display: block; }
  .popup { position: absolute; border-radius: 10px; overflow: hidden;
           box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 12px 32px rgba(0,0,0,.45); }
  .popup img { display: block; }
`;

function windowHtml({ tabTitle, favicon, omni, shot, shotW, extOn = false, badge = '' }) {
  return `
    <div class="win" style="width:${shotW}px">
      <div class="tabs">
        <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
        <div class="tab"><img src="${favicon}"><span>${tabTitle}</span></div>
      </div>
      <div class="bar">
        <div class="nav">‹ › ↻</div>
        <div class="omni">${omni}</div>
        <div class="ext ${extOn ? 'on' : ''}" id="ext"><img src="${icon}">${badge ? `<span class="badge">${badge}</span>` : ''}</div>
        <div class="avatar"></div>
      </div>
      <img class="shot" src="${dataUrl(shot)}" style="width:${shotW}px">
    </div>`;
}

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({
  deviceScaleFactor: SCALE,
  viewport: { width: 1700, height: 1200 },
});
mkdirSync(OUT, { recursive: true });

async function render(name, body, clip) {
  await page.setContent(`<style>${css}</style>${body}`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  // The panel hangs under the toolbar icon, right edges aligned like Chrome's action popups.
  await page.evaluate(() => {
    const pop = document.getElementById('popup');
    const ext = document.getElementById('ext')?.getBoundingClientRect();
    const st = document.querySelector('.stage')?.getBoundingClientRect();
    if (!pop || !ext || !st) return;
    pop.style.left = `${ext.right + 12 - pop.offsetWidth - st.left}px`;
    pop.style.top = `${ext.bottom + 10 - st.top}px`;
  });
  const stage = await page.locator('.stage').boundingBox();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, omitBackground: true, clip: clip?.(stage) ?? stage });
  console.log(file);
}

// 1. Hero: the marked-up page in the editor, just after ⌘C.
await render(
  'hero',
  `<div class="stage">${windowHtml({
    tabTitle: 'GitHub - microsoft/playwright · Page Snap',
    favicon: icon,
    omni: '<span class="chip">Page Snap</span><span class="dim">editor.html</span>',
    shot: `${RAW}/copied.png`,
    shotW: 1440,
  })}</div>`,
);

// 2. The capture panel under the toolbar icon, over the page being captured (top-right crop).
await render(
  'progress',
  `<div class="stage">${windowHtml({
    tabTitle: 'GitHub - microsoft/playwright',
    favicon: ghFavicon,
    omni: 'github.com<span class="dim">/microsoft/playwright</span>',
    shot: `${RAW}/progress-page.png`,
    shotW: 1440,
    extOn: true,
    badge: '62%',
  })}<div class="popup" id="popup"><img src="${dataUrl(`${RAW}/progress-dark.png`)}" style="width:320px"></div></div>`,
  (stage) => ({ x: stage.x + stage.width - 820, y: stage.y, width: 820, height: 470 }),
);

// 3. Editing a mark: the bent arrow's handles, cropped from the editor.
await page.setContent(`<style>${css}
  .crop { width: 1000px; height: 270px; overflow: hidden; position: relative; border-radius: 12px; background: #fff; }
  .crop img { position: absolute; width: 1440px; left: -420px; top: -388px; }
  </style><div class="stage"><div class="win crop"><img src="${dataUrl(`${RAW}/edit.png`)}"></div></div>`);
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
{
  const stage = await page.locator('.stage').boundingBox();
  await page.screenshot({ path: path.join(OUT, 'edit.png'), omitBackground: true, clip: stage });
  console.log(path.join(OUT, 'edit.png'));
}

await browser.close();
