/**
 * Compositor public API (owner: A). Implements `OpenCaptureSource` from `shared/source.ts`.
 *
 * PHASE-0 BASELINE: a simple main-thread implementation so the editor (B, C) can run against real
 * sessions before A's worker-based compositor lands. A replaces the internals; the exported
 * signature is the contract.
 */
import { compositeRegion } from '@/shared/composite';
import { getSession, getSliceBlob } from '@/shared/db';
import { DISPLAY_TILE_HEIGHT, DISPLAY_TILE_MAX_SIDE } from '@/shared/limits';
import type { CaptureSource, OpenCaptureSource } from '@/shared/source';
import type { Size, TileMeta } from '@/shared/types';

/** Row-major grid of display tiles covering `size`. */
export function planDisplayTiles(size: Size): TileMeta[] {
  const tiles: TileMeta[] = [];
  for (let y = 0; y < size.h; y += DISPLAY_TILE_HEIGHT) {
    for (let x = 0; x < size.w; x += DISPLAY_TILE_MAX_SIDE) {
      tiles.push({
        index: tiles.length,
        rect: {
          x,
          y,
          w: Math.min(DISPLAY_TILE_MAX_SIDE, size.w - x),
          h: Math.min(DISPLAY_TILE_HEIGHT, size.h - y),
        },
      });
    }
  }
  return tiles;
}

export const openCaptureSource: OpenCaptureSource = async (sessionId) => {
  const session = await getSession(sessionId);
  if (!session) throw new Error('NO_SESSION');
  if (session.status === 'capturing') throw new Error('NOT_FINAL');
  if (session.status === 'error') throw new Error('CAPTURE_FAILED');
  const tiles = planDisplayTiles(session.image);
  let disposed = false;

  const source: CaptureSource = {
    session,
    tiles,
    async getTileBitmap(index, signal) {
      const tile = tiles[index];
      if (!tile) throw new RangeError(`No tile ${index}`);
      if (disposed) throw new Error('DISPOSED');
      signal?.throwIfAborted();
      const canvas = new OffscreenCanvas(tile.rect.w, tile.rect.h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D context');
      await compositeRegion(ctx, session.layout, tile.rect, 1, (i) => getSliceBlob(sessionId, i));
      signal?.throwIfAborted();
      return canvas.transferToImageBitmap();
    },
    dispose() {
      disposed = true;
    },
  };
  return source;
};
