import { afterEach, describe, expect, it } from 'vitest';
import { compositorBackend, openCaptureSource } from '@/compositor';
import { closeDb, deleteSession, getSession, getSliceBlob, putSession } from '@/shared/db';
import { BAND_CSS, bandColor, seedSyntheticSession } from '@/shared/testing/synthetic';

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await deleteSession(id);
  await closeDb();
});

function hexAt(bmp: ImageBitmap, x: number, y: number): string {
  const c = new OffscreenCanvas(1, 1);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no ctx');
  ctx.drawImage(bmp, x, y, 1, 1, 0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[d[0], d[1], d[2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

describe('openCaptureSource (worker compositor)', () => {
  it('renders tiles in a worker that match the slices, and the first tile is fast', async () => {
    // A typical page: 1280 × 8000 CSS px at DPR 2, 813 px viewport.
    const id = await seedSyntheticSession({ cssW: 1280, cssH: 8000, viewportH: 813, dpr: 2 });
    created.push(id);
    const t0 = performance.now();
    const source = await openCaptureSource(id);
    const first = await source.getTileBitmap(0);
    const firstMs = performance.now() - t0;
    const second = await source.getTileBitmap(1);
    const bothMs = performance.now() - t0;
    console.log(
      `[compositor] first tile ${firstMs.toFixed(0)} ms, first two ${bothMs.toFixed(0)} ms`,
    );
    expect(compositorBackend(source)).toBe('worker');
    expect(firstMs).toBeLessThan(300);
    expect(source.tiles).toHaveLength(Math.ceil(16_000 / 2048));
    expect([first.width, first.height]).toEqual([2560, 2048]);

    // Every band crossing tiles 0–1 has the right colour (tiles are image px, bands 1000 px).
    for (const [tile, bmp] of [first, second].entries()) {
      for (let y = 100; y < 2048; y += 250) {
        const imageY = tile * 2048 + y;
        if ((imageY / 2) % BAND_CSS < 30) continue; // skip the label strip
        expect(hexAt(bmp, 2000, y), `tile ${tile} y ${y}`).toBe(
          bandColor(Math.floor(imageY / 2 / BAND_CSS)),
        );
      }
    }
    first.close();
    second.close();

    // The last tile is the remainder.
    const last = source.tiles.at(-1);
    if (!last) throw new Error('no tiles');
    const bmp = await source.getTileBitmap(last.index);
    expect(bmp.height).toBe(16_000 - last.rect.y);
    bmp.close();
    source.dispose();
    await expect(source.getTileBitmap(0)).rejects.toThrow('DISPOSED');
  });

  it('honours abort signals', async () => {
    const id = await seedSyntheticSession({ cssW: 400, cssH: 3000, viewportH: 600, dpr: 1 });
    created.push(id);
    const source = await openCaptureSource(id);
    const ac = new AbortController();
    const p = source.getTileBitmap(1, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeDefined();
    source.dispose();
  });

  it('rejects for unknown, unfinished and failed sessions', async () => {
    await expect(openCaptureSource('nope')).rejects.toThrow('NO_SESSION');
    const id = await seedSyntheticSession({ cssW: 300, cssH: 900, viewportH: 600, dpr: 1 });
    created.push(id);
    const s = await getSession(id);
    if (!s) throw new Error('no session');
    await putSession({ ...s, status: 'capturing' });
    await expect(openCaptureSource(id)).rejects.toThrow('NOT_FINAL');
    await putSession({ ...s, status: 'error' });
    await expect(openCaptureSource(id)).rejects.toThrow('CAPTURE_FAILED');
    expect(await getSliceBlob(id, 0)).toBeInstanceOf(Blob);
  });
});
