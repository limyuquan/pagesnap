import { decodePng, dragImage, toPage, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

test('right mouse down swaps in the annotated composite <img> as the context-menu target', async ({
  pagesnap,
}) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 2000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await dragImage(ed, { x: 300, y: 600 }, { x: 1300, y: 900 });
  const img = ed.getByTestId('editor-composite');
  // The composite is pre-rendered at idle after the commit.
  await expect
    .poll(() =>
      ed.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: test hook
        const s = (window as any).__pagesnapEngine.state();
        return s._compositeRev === s.doc.rev && /^blob:/.test(s._compositeUrl ?? '');
      }),
    )
    .toBe(true);
  await expect(img).toHaveAttribute('src', /^blob:/);

  await ed.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test probe
    const w = window as any;
    w.__menuTargets = [];
    document.addEventListener(
      'contextmenu',
      (e) => {
        w.__menuTargets.push(
          (e.target as HTMLElement).dataset.testid ?? (e.target as HTMLElement).tagName,
        );
        e.preventDefault(); // keep the headless run free of a native menu
      },
      { capture: true },
    );
  });
  const p = await toPage(ed, 1500, 1200);
  await ed.mouse.move(p.x, p.y);
  await ed.mouse.down({ button: 'right' });
  await ed.mouse.up({ button: 'right' });
  // biome-ignore lint/suspicious/noExplicitAny: test probe
  expect(await ed.evaluate(() => (window as any).__menuTargets)).toEqual(['editor-composite']);

  // The <img> holds the annotated full image (copy resolution: 1x CSS).
  const b64 = await ed.evaluate(async () => {
    const src = document.querySelector<HTMLImageElement>('[data-testid="editor-composite"]')?.src;
    if (!src) throw new Error('no src');
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const png = decodePng(b64);
  expect([png.width, png.height]).toEqual([1280, 2000]);
  const i = (375 * png.width + 400) * 4;
  const px = [png.data[i], png.data[i + 1], png.data[i + 2]];
  expect(px, `arrow pixel ${px}`).toEqual([255, 59, 48]);

  // Moving on restores the canvas as the pointer target, so drawing keeps working.
  await ed.mouse.move(p.x + 40, p.y + 40);
  await expect(img).toHaveCSS('pointer-events', 'none');
  const q = await toPage(ed, 300, 1400);
  const target = await ed.evaluate(
    ([x, y]) =>
      (document.elementFromPoint(x as number, y as number) as HTMLElement | null)?.dataset.testid,
    [q.x, q.y],
  );
  expect(target).toBe('editor-canvas');
});
