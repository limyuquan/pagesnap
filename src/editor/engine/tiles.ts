/**
 * Display-tile cache for the viewport, with a level-of-detail pyramid.
 *
 * Level `k` renders the base image at `2^-k` (level 0 = full resolution); its tiles are
 * `DISPLAY_TILE_HEIGHT` level px tall, so a level-k tile covers `2^k` times more of the page. The
 * renderer asks for the coarsest level that is still at least as sharp as the screen, so the bytes
 * on screen stay roughly constant at any zoom.
 *
 * Invariants (they are what keeps the cache from thrashing, qa-stress S1):
 * - The **wanted** set is a pure function of (visible rect, prefetch rect, level, budget): every
 *   visible tile of the level, plus prefetch tiles nearest first while the total stays within the
 *   budget. It never depends on what happens to be resident.
 * - Only wanted tiles are ever loaded; wanted tiles are never evicted. So once the wanted set is
 *   resident nothing loads until the view changes: zero work while idle.
 * - Other tiles (other levels, scrolled away) stay resident as fallbacks until the budget needs
 *   their bytes, least recently drawn first.
 */
import { isLodSource, planDisplayTiles } from '@/compositor';
import type { CaptureSource } from '@/shared/source';
import type { Rect, Size } from '@/shared/types';
import { rectsIntersect } from './geometry';
import { perf } from './perf';

/** Default decoded-bitmap budget (~6 strips of a 2800-px-wide DPR-2 capture). */
export const TILE_BUDGET_BYTES = 160 * 2 ** 20;
/** Parallel loads: tiles on screen may use all of them, prefetch only `MAX_PREFETCH_IN_FLIGHT`. */
const MAX_IN_FLIGHT = 4;
const MAX_PREFETCH_IN_FLIGHT = 2;
/** A failed tile is retried this many times (after `RETRY_MS`), then drawn as a placeholder. */
const MAX_RETRIES = 2;
const RETRY_MS = 1_000;
/** Coarsest level: tiles stop shrinking once the level image is about this narrow. */
const MIN_LEVEL_WIDTH = 48;
const MAX_LEVEL = 6;

export interface LevelTile {
  /** Index within its level (row-major). */
  index: number;
  level: number;
  /** Image px covered. */
  rect: Rect;
  /** Decoded bytes (level px × 4). */
  bytes: number;
}

interface Entry {
  tile: LevelTile;
  bitmap: ImageBitmap | null;
  loading: AbortController | null;
  lastUsed: number;
  failures: number;
  retryAt: number;
}

/** Tiles of level `k` for an image (image-px rects; level px = rect × 2^-k). */
export function planLevelTiles(image: Size, level: number): LevelTile[] {
  const s = 2 ** -level;
  const lw = Math.max(1, Math.ceil(image.w * s));
  const lh = Math.max(1, Math.ceil(image.h * s));
  return planDisplayTiles({ w: lw, h: lh }).map((t, index) => {
    const x = t.rect.x / s;
    const y = t.rect.y / s;
    const rect = {
      x,
      y,
      w: Math.min(t.rect.w / s, image.w - x),
      h: Math.min(t.rect.h / s, image.h - y),
    };
    return {
      index,
      level,
      rect,
      bytes: Math.max(1, Math.round(rect.w * s)) * Math.max(1, Math.round(rect.h * s)) * 4,
    };
  });
}

/** Coarsest useful level for an image. */
export function maxLevelFor(image: Size): number {
  let k = 0;
  while (k < MAX_LEVEL && image.w * 2 ** -(k + 1) >= MIN_LEVEL_WIDTH) k++;
  return k;
}

/**
 * The level to draw at `deviceScale` (device px per image px): the coarsest level that is still
 * at least as sharp as the screen.
 */
export function levelForScale(deviceScale: number, maxLevel: number): number {
  if (!(deviceScale > 0) || deviceScale >= 1) return 0;
  const k = Math.floor(Math.log2(1 / deviceScale) + 1e-9);
  return Math.max(0, Math.min(maxLevel, k));
}

export class TileCache {
  private readonly source: CaptureSource;
  private readonly onLoad: () => void;
  private readonly levels = new Map<number, Entry[]>();
  private readonly lod: boolean;
  readonly maxLevel: number;
  private budget: number;
  private clock = 0;
  private inFlight = 0;
  private prefetchInFlight = 0;
  private level = 0;
  private needed: Entry[] = [];
  private wanted = new Set<Entry>();
  private neededRect: Rect | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Loads started (diagnostics and the idle-load perf assertion). */
  loads = 0;

  constructor(source: CaptureSource, onLoad: () => void, budgetBytes = TILE_BUDGET_BYTES) {
    this.source = source;
    this.onLoad = onLoad;
    this.budget = budgetBytes;
    this.lod = isLodSource(source);
    const image = source.session?.image ?? imageOf(source);
    this.maxLevel = this.lod && image ? maxLevelFor(image) : 0;
    // Level 0 is exactly the source's own tile grid.
    this.levels.set(
      0,
      source.tiles.map((t) => ({
        tile: { index: t.index, level: 0, rect: t.rect, bytes: t.rect.w * t.rect.h * 4 },
        bitmap: null,
        loading: null,
        lastUsed: 0,
        failures: 0,
        retryAt: 0,
      })),
    );
  }

  /** Level-0 tiles (the source grid). */
  get tiles(): readonly LevelTile[] {
    return this.entriesOf(0).map((e) => e.tile);
  }

  get currentLevel(): number {
    return this.level;
  }

  /** Entries of a level, created on first use. */
  private entriesOf(level: number): Entry[] {
    let es = this.levels.get(level);
    if (!es) {
      const image = this.source.session?.image ?? imageOf(this.source);
      es = (image ? planLevelTiles(image, level) : []).map((tile) => ({
        tile,
        bitmap: null,
        loading: null,
        lastUsed: 0,
        failures: 0,
        retryAt: 0,
      }));
      this.levels.set(level, es);
    }
    return es;
  }

  /** Tiles of `level` intersecting `rect`. */
  tilesIn(level: number, rect: Rect): readonly LevelTile[] {
    return this.entriesOf(level)
      .filter((e) => rectsIntersect(e.tile.rect, rect))
      .map((e) => e.tile);
  }

  /** Resident bitmap of a tile (marks it used), or null. */
  get(tile: LevelTile): ImageBitmap | null {
    const e = this.levels.get(tile.level)?.[tile.index];
    if (!e?.bitmap) return null;
    e.lastUsed = ++this.clock;
    return e.bitmap;
  }

  /** Resident tiles of any level other than `except` that intersect `rect`, coarsest first. */
  fallbacks(rect: Rect, except: number): { tile: LevelTile; bitmap: ImageBitmap }[] {
    const out: { tile: LevelTile; bitmap: ImageBitmap }[] = [];
    const ks = [...this.levels.keys()].filter((k) => k !== except).sort((a, b) => b - a);
    for (const k of ks) {
      for (const e of this.levels.get(k) ?? []) {
        if (e.bitmap && rectsIntersect(e.tile.rect, rect)) {
          e.lastUsed = ++this.clock;
          out.push({ tile: e.tile, bitmap: e.bitmap });
        }
      }
    }
    return out;
  }

  /** True when every tile of the current level intersecting `rect` is resident (or gave up). */
  covers(rect: Rect): boolean {
    for (const e of this.entriesOf(this.level)) {
      if (rectsIntersect(e.tile.rect, rect) && !e.bitmap && e.failures <= MAX_RETRIES) return false;
    }
    return true;
  }

  /** Resident decoded bytes. */
  get bytes(): number {
    let n = 0;
    for (const es of this.levels.values()) for (const e of es) if (e.bitmap) n += e.tile.bytes;
    return n;
  }

  get residentCount(): number {
    let n = 0;
    for (const es of this.levels.values()) for (const e of es) if (e.bitmap) n++;
    return n;
  }

  /** Diagnostics for tests: loads running, and how complete the wanted set is. */
  get stats(): {
    level: number;
    inFlight: number;
    loads: number;
    residentMB: number;
    wantedMB: number;
    wantedMissing: number;
  } {
    let missing = 0;
    for (const e of this.wanted) if (!e.bitmap && e.failures <= MAX_RETRIES) missing++;
    return {
      level: this.level,
      inFlight: this.inFlight,
      loads: this.loads,
      residentMB: Math.round(this.bytes / 2 ** 20),
      wantedMB: Math.round(this.wantedBytes / 2 ** 20),
      wantedMissing: missing,
    };
  }

  /** Bytes the current wanted set needs (≤ max(budget, visible bytes)). */
  get wantedBytes(): number {
    let n = 0;
    for (const e of this.wanted) n += e.tile.bytes;
    return n;
  }

  /**
   * Show `visible` at `level`: its tiles load first, then those in `prefetch` (nearest first)
   * while they fit the budget. Loads that are no longer wanted are aborted.
   */
  update(visible: Rect, prefetch: Rect, level = 0): void {
    if (this.disposed) return;
    const lv = this.lod ? Math.max(0, Math.min(this.maxLevel, level)) : 0;
    this.level = lv;
    this.neededRect = visible;
    const es = this.entriesOf(lv);
    const needed: Entry[] = [];
    const extra: Entry[] = [];
    for (const e of es) {
      if (rectsIntersect(e.tile.rect, visible)) needed.push(e);
      else if (rectsIntersect(e.tile.rect, prefetch)) extra.push(e);
    }
    const cy = visible.y + visible.h / 2;
    const cx = visible.x + visible.w / 2;
    const dist = (e: Entry) =>
      Math.abs(e.tile.rect.y + e.tile.rect.h / 2 - cy) +
      Math.abs(e.tile.rect.x + e.tile.rect.w / 2 - cx);
    needed.sort((a, b) => dist(a) - dist(b));
    extra.sort((a, b) => dist(a) - dist(b));
    const wanted = new Set<Entry>(needed);
    let bytes = 0;
    for (const e of needed) bytes += e.tile.bytes;
    for (const e of extra) {
      if (bytes + e.tile.bytes > this.budget) break;
      bytes += e.tile.bytes;
      wanted.add(e);
    }
    this.needed = needed;
    this.wanted = wanted;
    for (const e of needed) e.lastUsed = ++this.clock;
    // Abort loads that left the wanted set (scrolled away, or another level now).
    for (const all of this.levels.values()) {
      for (const e of all) {
        if (e.loading && !wanted.has(e)) {
          e.loading.abort();
          e.loading = null;
        }
      }
    }
    this.pump();
    this.evict();
  }

  /** Drop everything that isn't visible (tab hidden, memory pressure). */
  trim(): void {
    const keep = new Set(this.needed);
    for (const es of this.levels.values()) {
      for (const e of es) {
        if (e.bitmap && !keep.has(e)) {
          e.bitmap.close();
          e.bitmap = null;
        }
      }
    }
  }

  setBudget(bytes: number): void {
    this.budget = bytes;
    if (this.neededRect) this.evict();
  }

  private loadable(e: Entry, now: number): boolean {
    return !e.bitmap && !e.loading && e.failures <= MAX_RETRIES && e.retryAt <= now;
  }

  private pump(): void {
    const now = performance.now();
    let retryIn = Number.POSITIVE_INFINITY;
    const neededSet = new Set(this.needed);
    // `needed` first (sorted by distance), then the rest of `wanted` (insertion order = distance).
    for (const e of [...this.needed, ...[...this.wanted].filter((w) => !neededSet.has(w))]) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      if (!e.bitmap && !e.loading && e.failures > 0 && e.failures <= MAX_RETRIES) {
        if (e.retryAt > now) retryIn = Math.min(retryIn, e.retryAt - now);
      }
      if (!this.loadable(e, now)) continue;
      const isNeeded = neededSet.has(e);
      if (!isNeeded && this.prefetchInFlight >= MAX_PREFETCH_IN_FLIGHT) continue;
      this.load(e, isNeeded);
    }
    if (Number.isFinite(retryIn) && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.pump();
      }, retryIn + 5);
    }
  }

  private load(e: Entry, needed: boolean): void {
    const ctrl = new AbortController();
    e.loading = ctrl;
    this.inFlight++;
    if (!needed) this.prefetchInFlight++;
    this.loads++;
    perf.tileLoads++;
    const t = e.tile;
    const src = this.source;
    const work = isLodSource(src)
      ? src.getRegionBitmap(t.rect, 2 ** -t.level, {
          signal: ctrl.signal,
          priority: needed ? 'high' : 'low',
        })
      : src.getTileBitmap(t.index, ctrl.signal);
    const settle = () => {
      this.inFlight--;
      if (!needed) this.prefetchInFlight--;
      if (e.loading === ctrl) e.loading = null;
    };
    work.then(
      (bmp) => {
        settle();
        if (this.disposed || ctrl.signal.aborted) {
          bmp.close();
        } else {
          e.bitmap?.close();
          e.bitmap = bmp;
          e.failures = 0;
          e.lastUsed = ++this.clock;
          this.evict();
          this.onLoad();
        }
        this.pump();
      },
      (err: unknown) => {
        settle();
        if (!ctrl.signal.aborted && !this.disposed) {
          e.failures++;
          e.retryAt = performance.now() + RETRY_MS * e.failures;
          console.warn('[pagesnap] tile load failed', t.level, t.index, err);
          this.onLoad();
        }
        this.pump();
      },
    );
  }

  private evict(): void {
    let bytes = this.bytes;
    let neededBytes = 0;
    for (const e of this.needed) neededBytes += e.tile.bytes;
    // While tiles are still coming, keep fallbacks up to the budget; once everything wanted is
    // resident, let go of the rest down to half of it (memory, qa-stress S6).
    let complete = true;
    for (const e of this.wanted) if (!e.bitmap && e.failures <= MAX_RETRIES) complete = false;
    const limit = Math.max(complete ? this.budget / 2 : this.budget, neededBytes, this.wantedBytes);
    if (bytes <= limit) return;
    // Never evict a wanted tile (that is what would make loading loop); among the rest, least
    // recently drawn first.
    const victims: Entry[] = [];
    for (const es of this.levels.values()) {
      for (const e of es) if (e.bitmap && !this.wanted.has(e)) victims.push(e);
    }
    victims.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of victims) {
      if (bytes <= limit) break;
      bytes -= e.tile.bytes;
      e.bitmap?.close();
      e.bitmap = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const es of this.levels.values()) {
      for (const e of es) {
        e.loading?.abort();
        e.loading = null;
        e.bitmap?.close();
        e.bitmap = null;
      }
    }
  }
}

/** Image size from a source's tile grid (sources built in tests may lack `session.image`). */
function imageOf(source: CaptureSource): Size | null {
  let w = 0;
  let h = 0;
  for (const t of source.tiles) {
    w = Math.max(w, t.rect.x + t.rect.w);
    h = Math.max(h, t.rect.y + t.rect.h);
  }
  return w > 0 && h > 0 ? { w, h } : null;
}
