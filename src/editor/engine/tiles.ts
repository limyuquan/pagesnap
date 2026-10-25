/**
 * Display-tile cache for the viewport (owner: B). Loads base-image tiles from the `CaptureSource`
 * lazily around the view, keeps an LRU bounded by a byte budget, closes evicted bitmaps, and
 * aborts loads that scrolled out of range. Tiles are always full image resolution, so nothing is
 * ever drawn from a blurry low-res stand-in.
 */
import type { CaptureSource } from '@/shared/source';
import type { Rect, TileMeta } from '@/shared/types';
import { rectsIntersect } from './geometry';

/** Default decoded-bitmap budget (~6 strips of a 2800-px-wide DPR-2 capture). */
export const TILE_BUDGET_BYTES = 160 * 2 ** 20;
/** Parallel tile decodes. */
const MAX_IN_FLIGHT = 3;

interface Entry {
  tile: TileMeta;
  bitmap: ImageBitmap | null;
  loading: AbortController | null;
  lastUsed: number;
  failed: boolean;
}

export class TileCache {
  private readonly entries: Entry[];
  private readonly source: CaptureSource;
  private readonly onLoad: () => void;
  private budget: number;
  private clock = 0;
  private inFlight = 0;
  private wanted: Rect | null = null;
  private needed: Rect | null = null;
  private disposed = false;

  constructor(source: CaptureSource, onLoad: () => void, budgetBytes = TILE_BUDGET_BYTES) {
    this.source = source;
    this.onLoad = onLoad;
    this.budget = budgetBytes;
    this.entries = source.tiles.map((tile) => ({
      tile,
      bitmap: null,
      loading: null,
      lastUsed: 0,
      failed: false,
    }));
  }

  get tiles(): readonly TileMeta[] {
    return this.source.tiles;
  }

  /** Bitmap of a tile if it's resident (marks it used). */
  get(index: number): ImageBitmap | null {
    const e = this.entries[index];
    if (!e?.bitmap) return null;
    e.lastUsed = ++this.clock;
    return e.bitmap;
  }

  /** True when every tile intersecting `rect` is resident. */
  covers(rect: Rect): boolean {
    for (const e of this.entries)
      if (rectsIntersect(e.tile.rect, rect) && !e.bitmap && !e.failed) return false;
    return true;
  }

  /** Resident decoded bytes. */
  get bytes(): number {
    let n = 0;
    for (const e of this.entries) if (e.bitmap) n += e.bitmap.width * e.bitmap.height * 4;
    return n;
  }

  get residentCount(): number {
    return this.entries.filter((e) => e.bitmap).length;
  }

  /**
   * Make sure the tiles for `visible` load first, then those in `prefetch` (a larger rect around
   * it). Loads outside `prefetch` are aborted; resident tiles outside it are evicted only when over
   * budget.
   */
  update(visible: Rect, prefetch: Rect): void {
    if (this.disposed) return;
    this.needed = visible;
    this.wanted = prefetch;
    for (const e of this.entries) {
      if (e.loading && !rectsIntersect(e.tile.rect, prefetch)) {
        e.loading.abort();
        e.loading = null;
      }
      if (rectsIntersect(e.tile.rect, visible)) e.lastUsed = ++this.clock;
    }
    this.pump();
    this.evict();
  }

  /** Drop everything that isn't visible (tab hidden, memory pressure). */
  trim(): void {
    const keep = this.needed;
    for (const e of this.entries) {
      if (e.bitmap && !(keep && rectsIntersect(e.tile.rect, keep))) {
        e.bitmap.close();
        e.bitmap = null;
      }
    }
  }

  setBudget(bytes: number): void {
    this.budget = bytes;
    this.evict();
  }

  private pump(): void {
    const visible = this.needed;
    const wanted = this.wanted;
    if (!visible || !wanted) return;
    const centre = visible.y + visible.h / 2;
    const candidates = this.entries
      .filter((e) => !e.bitmap && !e.loading && !e.failed && rectsIntersect(e.tile.rect, wanted))
      .sort((a, b) => {
        const av = rectsIntersect(a.tile.rect, visible) ? 0 : 1;
        const bv = rectsIntersect(b.tile.rect, visible) ? 0 : 1;
        if (av !== bv) return av - bv;
        const ad = Math.abs(a.tile.rect.y + a.tile.rect.h / 2 - centre);
        const bd = Math.abs(b.tile.rect.y + b.tile.rect.h / 2 - centre);
        return ad - bd;
      });
    for (const e of candidates) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      this.load(e);
    }
  }

  private load(e: Entry): void {
    const ctrl = new AbortController();
    e.loading = ctrl;
    this.inFlight++;
    this.source.getTileBitmap(e.tile.index, ctrl.signal).then(
      (bmp) => {
        this.inFlight--;
        if (e.loading === ctrl) e.loading = null;
        if (this.disposed || ctrl.signal.aborted) {
          bmp.close();
        } else {
          e.bitmap?.close();
          e.bitmap = bmp;
          e.lastUsed = ++this.clock;
          this.evict();
          this.onLoad();
        }
        this.pump();
      },
      (err: unknown) => {
        this.inFlight--;
        if (e.loading === ctrl) e.loading = null;
        if (!ctrl.signal.aborted && !this.disposed) {
          e.failed = true;
          console.warn('[pagesnap] tile load failed', e.tile.index, err);
          this.onLoad();
        }
        this.pump();
      },
    );
  }

  private evict(): void {
    let bytes = this.bytes;
    if (bytes <= this.budget) return;
    const visible = this.needed;
    const wanted = this.wanted;
    // Least valuable first: outside the prefetch rect, then least recently used.
    const resident = this.entries
      .filter((e) => e.bitmap && !(visible && rectsIntersect(e.tile.rect, visible)))
      .sort((a, b) => {
        const aw = wanted && rectsIntersect(a.tile.rect, wanted) ? 1 : 0;
        const bw = wanted && rectsIntersect(b.tile.rect, wanted) ? 1 : 0;
        return aw - bw || a.lastUsed - b.lastUsed;
      });
    for (const e of resident) {
      if (bytes <= this.budget) break;
      const bmp = e.bitmap as ImageBitmap;
      bytes -= bmp.width * bmp.height * 4;
      bmp.close();
      e.bitmap = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries) {
      e.loading?.abort();
      e.loading = null;
      e.bitmap?.close();
      e.bitmap = null;
    }
  }
}
