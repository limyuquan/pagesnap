import { afterEach, describe, expect, it } from 'vitest';
import { openCaptureSource } from '@/compositor';
import { compositeRegion } from '@/shared/composite';
import { closeDb, deleteSession, getSession, getSliceBlob } from '@/shared/db';
import { BAND_CSS, bandColor, seedSyntheticSession } from '@/shared/testing/synthetic';

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await deleteSession(id);
  await closeDb();
});

function hex(data: Uint8ClampedArray, i = 0): string {
  return `#${[data[i], data[i + 1], data[i + 2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

describe('compositeRegion (real canvas)', () => {
  it('reproduces the synthetic bands at full and reduced scale', async () => {
    const id = await seedSyntheticSession({ cssW: 400, cssH: 3000, viewportH: 700, dpr: 2 });
    created.push(id);
    const session = await getSession(id);
    if (!session) throw new Error('missing session');
    expect(session.image).toEqual({ w: 800, h: 6000 });

    // Sample the middle of every band, crossing slice seams.
    for (const scale of [1, 0.5]) {
      const canvas = new OffscreenCanvas(Math.round(800 * scale), Math.round(6000 * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no ctx');
      await compositeRegion(ctx, session.layout, { x: 0, y: 0, w: 800, h: 6000 }, scale, (i) =>
        getSliceBlob(id, i),
      );
      for (let band = 0; band < 3000 / BAND_CSS; band++) {
        const y = Math.round((band * BAND_CSS + BAND_CSS / 2) * 2 * scale);
        const px = ctx.getImageData(Math.round(700 * scale), y, 1, 1).data;
        expect(hex(px), `band ${band} at scale ${scale}`).toBe(bandColor(band));
      }
    }
  });
});

describe('openCaptureSource (phase-0 baseline)', () => {
  it('serves tiles covering the image', async () => {
    const id = await seedSyntheticSession({ cssW: 300, cssH: 2500, viewportH: 600, dpr: 1 });
    created.push(id);
    const source = await openCaptureSource(id);
    expect(source.tiles.map((t) => t.rect.h)).toEqual([2048, 452]);
    const bmp = await source.getTileBitmap(1);
    expect([bmp.width, bmp.height]).toEqual([300, 452]);
    bmp.close();
    source.dispose();
  });
});
