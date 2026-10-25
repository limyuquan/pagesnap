/**
 * Compositor public API (owner: A). Implements `OpenCaptureSource` from `shared/source.ts`.
 *
 * Tiles are rendered in a dedicated worker with OffscreenCanvas (`worker.ts`) and transferred as
 * ImageBitmaps, so the editor's main thread only draws them. The first tiles are rendered as soon
 * as the source opens, so they are usually ready by the time the editor asks. Where workers aren't
 * available (the service worker, tests) or the worker fails, the same renderer runs in-thread.
 *
 * Performance marks (for measuring time to first tile in the editor):
 * `pagesnap:source-open` when `openCaptureSource` is called and `pagesnap:first-tile` when the
 * first `getTileBitmap` resolves.
 */
import { getSession, getSliceBlob } from '@/shared/db';
import { DISPLAY_TILE_HEIGHT, DISPLAY_TILE_MAX_SIDE } from '@/shared/limits';
import type { CaptureSource, OpenCaptureSource } from '@/shared/source';
import type { BaseLayout, Rect, SessionId, Size, TileMeta } from '@/shared/types';
import type { FromWorker, ToWorker } from './messages';
import { createTileRenderer } from './render';

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

const backendKinds = new WeakMap<CaptureSource, () => 'worker' | 'in-thread'>();

/** Which backend renders a source's tiles right now (tests and diagnostics). */
export function compositorBackend(source: CaptureSource): 'worker' | 'in-thread' | null {
  return backendKinds.get(source)?.() ?? null;
}

/** Tiles rendered eagerly when a source opens (the top of the page). */
const PREFETCH_TILES = 2;

interface Backend {
  render(rect: Rect): Promise<ImageBitmap>;
  dispose(): void;
}

export const openCaptureSource: OpenCaptureSource = async (sessionId) => {
  mark('pagesnap:source-open', sessionId);
  const session = await getSession(sessionId);
  if (!session) throw new Error('NO_SESSION');
  if (session.status === 'capturing') throw new Error('NOT_FINAL');
  if (session.status === 'error') throw new Error('CAPTURE_FAILED');
  const tiles = planDisplayTiles(session.image);
  let backend = createBackend(sessionId, session.layout);
  let disposed = false;
  let firstMarked = false;

  const renderTile = (index: number): Promise<ImageBitmap> => {
    const tile = tiles[index];
    if (!tile) return Promise.reject(new RangeError(`No tile ${index}`));
    return backend.render(tile.rect).catch((err: unknown) => {
      if (disposed || backend instanceof InThread) throw err;
      // The worker failed (e.g. crashed): fall back to rendering in this thread.
      backend.dispose();
      backend = new InThread(sessionId, session.layout);
      return backend.render(tile.rect);
    });
  };

  // Prefetched bitmaps are handed to the first caller of that tile, who then owns them.
  const prefetched = new Map<number, Promise<ImageBitmap>>();
  for (let i = 0; i < Math.min(PREFETCH_TILES, tiles.length); i++) {
    const p = renderTile(i);
    p.catch(() => {});
    prefetched.set(i, p);
  }

  const source: CaptureSource = {
    session,
    tiles,
    async getTileBitmap(index, signal) {
      if (disposed) throw new Error('DISPOSED');
      signal?.throwIfAborted();
      const early = prefetched.get(index);
      prefetched.delete(index);
      const work = early ?? renderTile(index);
      const bitmap = await abortable(work, signal);
      if (disposed) {
        bitmap.close();
        throw new Error('DISPOSED');
      }
      if (!firstMarked) {
        firstMarked = true;
        mark('pagesnap:first-tile', sessionId);
      }
      return bitmap;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of prefetched.values())
        void p.then(
          (b) => b.close(),
          () => {},
        );
      prefetched.clear();
      backend.dispose();
    },
  };
  backendKinds.set(source, () => (backend instanceof InThread ? 'in-thread' : 'worker'));
  return source;
};

function createBackend(sessionId: SessionId, layout: BaseLayout): Backend {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return new InThread(sessionId, layout);
  }
  try {
    return new WorkerBackend(sessionId, layout);
  } catch {
    return new InThread(sessionId, layout);
  }
}

class InThread implements Backend {
  private readonly renderer;
  constructor(sessionId: SessionId, layout: BaseLayout) {
    this.renderer = createTileRenderer(layout, (i) => getSliceBlob(sessionId, i));
  }
  render(rect: Rect) {
    return this.renderer.render(rect);
  }
  dispose() {
    this.renderer.dispose();
  }
}

class WorkerBackend implements Backend {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }
  >();
  private dead = false;

  constructor(sessionId: SessionId, layout: BaseLayout) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.t === 'tile') {
        if (p) p.resolve(msg.bitmap);
        else msg.bitmap.close();
      } else {
        p?.reject(new Error(msg.message));
      }
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.fail(new Error(`Compositor worker failed: ${e.message}`));
    };
    this.post({ t: 'init', sessionId, layout });
  }

  render(rect: Rect): Promise<ImageBitmap> {
    if (this.dead) return Promise.reject(new Error('Compositor worker is gone'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ t: 'tile', id, rect });
    });
  }

  dispose(): void {
    if (this.dead) return;
    this.post({ t: 'dispose' });
    this.fail(new Error('DISPOSED'));
    this.worker.terminate();
  }

  private fail(err: Error): void {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private post(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }
}

/** Resolve with `work` unless `signal` aborts first; a late result is closed. */
function abortable(work: Promise<ImageBitmap>, signal?: AbortSignal): Promise<ImageBitmap> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      void work.then(
        (b) => b.close(),
        () => {},
      );
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (b) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) b.close();
        else resolve(b);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function mark(name: string, sessionId: SessionId): void {
  try {
    performance.mark(name, { detail: { sessionId } });
  } catch {
    // performance.mark is best effort (not available everywhere).
  }
}
