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
import type { CaptureSource } from '@/shared/source';
import type { BaseLayout, Rect, SessionId, Size, TileMeta } from '@/shared/types';
import type { FromWorker, TilePriority, ToWorker } from './messages';
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

export type { TilePriority } from './messages';

export interface RegionRequest {
  signal?: AbortSignal;
  /** `high` for tiles on screen, `low` for prefetch. Default `high`. */
  priority?: TilePriority;
}

/**
 * A `CaptureSource` that can also render any region at a reduced scale (the editor's
 * level-of-detail tiles). `openCaptureSource` always returns one.
 */
export interface LodCaptureSource extends CaptureSource {
  /**
   * Render `rect` (image px) at `scale` output px per image px (≤ 1). The bitmap is
   * `round(rect.w * scale) × round(rect.h * scale)`; the caller owns it and must close it.
   */
  getRegionBitmap(rect: Rect, scale: number, req?: RegionRequest): Promise<ImageBitmap>;
}

export function isLodSource(s: CaptureSource | null | undefined): s is LodCaptureSource {
  return !!s && typeof (s as Partial<LodCaptureSource>).getRegionBitmap === 'function';
}

/** Tiles rendered eagerly when a source opens (the top of the page). */
const PREFETCH_TILES = 2;
/** Unclaimed eager tiles are released after this long (the view may never need them). */
const PREFETCH_TTL_MS = 10_000;

interface Backend {
  render(
    rect: Rect,
    scale: number,
    priority: TilePriority,
    signal?: AbortSignal,
  ): Promise<ImageBitmap>;
  dispose(): void;
}

const rectKey = (r: Rect) => `${r.x},${r.y},${r.w},${r.h}`;

export const openCaptureSource = async (sessionId: SessionId): Promise<LodCaptureSource> => {
  mark('pagesnap:source-open', sessionId);
  const session = await getSession(sessionId);
  if (!session) throw new Error('NO_SESSION');
  if (session.status === 'capturing') throw new Error('NOT_FINAL');
  if (session.status === 'error') throw new Error('CAPTURE_FAILED');
  const tiles = planDisplayTiles(session.image);
  let backend = createBackend(sessionId, session.layout);
  let restarts = 0;
  let disposed = false;
  let firstMarked = false;

  const renderRegion = (
    rect: Rect,
    scale: number,
    priority: TilePriority,
    signal?: AbortSignal,
  ): Promise<ImageBitmap> =>
    backend.render(rect, scale, priority, signal).catch((err: unknown) => {
      if (disposed || isAbort(err) || !(backend instanceof WorkerBackend) || !backend.dead) {
        throw err;
      }
      // The worker died (e.g. crashed): restart it once, then render in this thread.
      backend.dispose();
      backend =
        restarts++ < 1
          ? createBackend(sessionId, session.layout)
          : new InThread(sessionId, session.layout);
      return backend.render(rect, scale, priority, signal);
    });

  // Prefetched bitmaps are handed to the first caller of that tile, who then owns them.
  const prefetched = new Map<string, Promise<ImageBitmap>>();
  for (let i = 0; i < Math.min(PREFETCH_TILES, tiles.length); i++) {
    const rect = (tiles[i] as TileMeta).rect;
    const key = rectKey(rect);
    const p = renderRegion(rect, 1, 'high');
    p.catch(() => {});
    prefetched.set(key, p);
    setTimeout(() => {
      if (prefetched.get(key) !== p) return;
      prefetched.delete(key);
      void p.then(
        (b) => b.close(),
        () => {},
      );
    }, PREFETCH_TTL_MS);
  }

  const getRegionBitmap = async (
    rect: Rect,
    scale: number,
    req: RegionRequest = {},
  ): Promise<ImageBitmap> => {
    if (disposed) throw new Error('DISPOSED');
    const { signal } = req;
    signal?.throwIfAborted();
    const key = rectKey(rect);
    const early = scale === 1 ? prefetched.get(key) : undefined;
    if (early) prefetched.delete(key);
    const work = early ?? renderRegion(rect, scale, req.priority ?? 'high', signal);
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
  };

  const source: LodCaptureSource = {
    session,
    tiles,
    getRegionBitmap,
    async getTileBitmap(index, signal) {
      const tile = tiles[index];
      if (!tile) throw new RangeError(`No tile ${index}`);
      return getRegionBitmap(tile.rect, 1, signal ? { signal } : {});
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

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

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
  render(rect: Rect, scale: number, priority: TilePriority, signal?: AbortSignal) {
    return this.renderer.render(rect, scale, {
      priority,
      isCancelled: () => signal?.aborted ?? false,
    });
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
  dead = false;

  constructor(sessionId: SessionId, layout: BaseLayout) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.t === 'ready') return;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.t === 'tile') {
        if (p) p.resolve(msg.bitmap);
        else msg.bitmap.close();
      } else if (p) {
        const err =
          msg.name === 'AbortError'
            ? new DOMException(msg.message, 'AbortError')
            : Object.assign(new Error(msg.message), { name: msg.name ?? 'Error' });
        p.reject(err as Error);
      }
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.fail(new Error(`Compositor worker failed: ${e.message}`));
    };
    this.worker.onmessageerror = () => this.fail(new Error('Compositor worker message error'));
    this.post({ t: 'init', sessionId, layout });
  }

  render(
    rect: Rect,
    scale: number,
    priority: TilePriority,
    signal?: AbortSignal,
  ): Promise<ImageBitmap> {
    if (this.dead) return Promise.reject(new Error('Compositor worker is gone'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ t: 'tile', id, rect, scale, priority });
      signal?.addEventListener(
        'abort',
        () => {
          // Let the worker skip it; the answer (an AbortError or a late bitmap) is handled above.
          if (this.pending.has(id) && !this.dead) this.post({ t: 'cancel', id });
        },
        { once: true },
      );
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
