/**
 * Abort races (review correctness #1): after the page is restored, nothing the agent still has in
 * flight may touch it. Reproduces the reviewer's cases: a page whose DOM ticks every 40 ms (so
 * every step re-scans floats), aborted mid-step by Esc or a toolbar cancel, and Esc during
 * prepare / pre-scroll with the user scrolled down.
 */
import type {} from '@/capture/testHook';
import { pageState, startCaptureAsync, waitForFinal, waitForSlices } from './capture.helpers';
import { expect, test } from './fixtures';

test.use({ dpr: 1 });

const DIRTY = `<!doctype html><html><head><style>
body{margin:0;font:16px sans-serif}
.top{position:fixed;top:0;left:0;right:0;height:50px;background:#0a84ff;z-index:5}
.side{position:sticky;top:60px;height:80px;background:#ff9500}
.band{height:600px;border-top:2px solid #000}
</style></head><body>
<div class="top" id="top">fixed</div>
<div style="height:60px"></div>
<div class="side" id="side">sticky</div>
${Array.from({ length: 14 }, (_, i) => `<div class="band" style="background:hsl(${i * 25} 70% 70%)">${i}</div>`).join('')}
<div id="clock"></div>
<script>let n=0;setInterval(()=>{document.getElementById('clock').className='t'+(n++%2)},40);</script>
</body></html>`;

for (const how of ['escape', 'cancel'] as const) {
  test(`abort (${how}) mid-step on a page with a ticking DOM leaves it untouched`, async ({
    context,
    pagesnap,
    serviceWorker,
  }) => {
    test.setTimeout(120_000);
    await context.route('**/capture-dirty.html', (r) =>
      r.fulfill({ contentType: 'text/html', body: DIRTY }),
    );
    const page = await pagesnap.openFixture('capture-dirty');
    const tabId = await pagesnap.tabIdOf(page);
    const bad: string[] = [];
    for (let run = 0; run < 5; run++) {
      await page.reload();
      await page.bringToFront();
      await page.evaluate((y) => scrollTo(0, y), run * 137);
      const before = await pageState(page);
      await startCaptureAsync(serviceWorker, tabId);
      const id = await waitForSlices(serviceWorker, 1 + (run % 3));
      // Land the abort at different points inside a step (scroll, settle, float update).
      await new Promise((r) => setTimeout(r, 30 + run * 67));
      if (how === 'escape') await page.keyboard.press('Escape');
      else await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.cancel());
      const s = await waitForFinal(serviceWorker, id);
      expect(s.error?.code).toBe('ABORTED_BY_USER');
      for (const p of context.pages()) if (p.url().includes('editor.html')) await p.close();
      await page.bringToFront();
      // Long enough for any straggling step to have run.
      await new Promise((r) => setTimeout(r, 900));
      const after = await pageState(page);
      const computed = await page.evaluate(() => ({
        top: getComputedStyle(document.getElementById('top') as HTMLElement).opacity,
        side: getComputedStyle(document.getElementById('side') as HTMLElement).position,
      }));
      if (JSON.stringify(after) !== JSON.stringify(before) || computed.top !== '1') {
        bad.push(`${run}: ${JSON.stringify({ before, after, computed })}`);
      }
      expect(computed.side).toBe('sticky');
    }
    expect(bad).toEqual([]);
  });
}

for (const delay of [150, 300, 600, 900]) {
  test(`Esc ${delay} ms into a capture (prepare / pre-scroll) restores the page exactly`, async ({
    context,
    pagesnap,
    serviceWorker,
  }) => {
    const page = await pagesnap.openFixture('lazy-images');
    await page.evaluate(() => scrollTo(0, 1234));
    await new Promise((r) => setTimeout(r, 300));
    const before = await pageState(page);
    const tabId = await pagesnap.tabIdOf(page);
    await startCaptureAsync(serviceWorker, tabId);
    await new Promise((r) => setTimeout(r, delay));
    await page.keyboard.press('Escape');
    let id: string | null = null;
    for (let i = 0; i < 100 && !id; i++) {
      id = await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.activeId() ?? null);
      const ed = context.pages().find((p) => p.url().includes('editor.html'));
      if (!id && ed) id = new URL(ed.url()).hash.replace('#s=', '');
      if (!id) await new Promise((r) => setTimeout(r, 50));
    }
    if (id) await waitForFinal(serviceWorker, id);
    await page.bringToFront();
    // The pre-scroll budget is 2 s and the stable-height wait 1.5 s: wait past both.
    await new Promise((r) => setTimeout(r, 4000));
    expect(await pageState(page)).toEqual(before);
  });
}

test('a synthetic Escape or pagehide from the page does not cancel the capture', async ({
  pagesnap,
  serviceWorker,
}) => {
  const page = await pagesnap.openFixture('bands');
  const tabId = await pagesnap.tabIdOf(page);
  await startCaptureAsync(serviceWorker, tabId);
  const id = await waitForSlices(serviceWorker, 2);
  await page.evaluate(() => {
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const s = await waitForFinal(serviceWorker, id);
  expect(s.status).toBe('ready');
});
