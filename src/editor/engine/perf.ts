/**
 * Lightweight performance probes (owner: B). Always on (cheap); exposed to e2e tests through
 * `window.__pagesnapEngine.perf`.
 */
import type { Size } from '@/shared/types';

const FRAME_SAMPLES = 600;

export interface CopyRecord {
  request: string;
  outcome: string;
  /** From the copy call to `clipboard.write` resolving. */
  ms: number;
  /** The PNG was already pre-encoded (or in flight) when the copy started. */
  cacheHit: boolean;
  size: Size;
  key: string;
}

class Perf {
  /** `performance.now()` when `init` started. */
  initAt: number | null = null;
  /** ms from navigation start / from init to the first frame with every visible tile drawn. */
  firstTilesFromNav: number | null = null;
  firstTilesFromInit: number | null = null;
  /** Render (CPU) time per frame, ms, ring buffer. */
  frames: number[] = [];
  /** rAF timestamps of rendered frames (for interval analysis). */
  frameStamps: number[] = [];
  copies: CopyRecord[] = [];
  /** Base-tile loads started (any level). Should stay flat while the view is idle. */
  tileLoads = 0;
  /** `performance.now()` at the end of the last rendered frame. */
  lastFrameEnd = 0;

  markInit(): void {
    this.initAt = performance.now();
  }

  markFirstTiles(): void {
    if (this.firstTilesFromNav !== null) return;
    const now = performance.now();
    this.firstTilesFromNav = now;
    this.firstTilesFromInit = this.initAt === null ? null : now - this.initAt;
  }

  recordFrame(ms: number, stamp: number): void {
    this.lastFrameEnd = performance.now();
    this.frames.push(ms);
    this.frameStamps.push(stamp);
    if (this.frames.length > FRAME_SAMPLES) {
      this.frames.shift();
      this.frameStamps.shift();
    }
  }

  recordCopy(r: CopyRecord): void {
    this.copies.push(r);
    if (this.copies.length > 50) this.copies.shift();
  }

  resetFrames(): void {
    this.frames = [];
    this.frameStamps = [];
  }
}

export const perf = new Perf();
