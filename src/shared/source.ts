/**
 * Boundary between the capture side (A) and the editor (B).
 *
 * - **Display**: A implements `openCaptureSource` in `src/compositor/index.ts`. The editor gets
 *   display tiles (`ImageBitmap`s) for the on-screen viewport and never touches slices itself.
 * - **Export**: B's export worker reads the base pixels directly. Given a session id it loads the
 *   session (`getSession`) and calls `compositeRegion(ctx, session.layout, region, scale, i =>
 *   getSliceBlob(id, i))` from `shared/composite.ts`, then draws the annotations on top. No tiles
 *   and no main-thread pixels are involved, and display and export share the same placement code.
 */
import type { CaptureSession, SessionId, TileMeta } from './types';

export interface CaptureSource {
  /** The session snapshot this source was opened with. Its status is final (`ready` or `partial`). */
  readonly session: CaptureSession;
  /** Display tiles covering `session.image` (see `TileMeta`). */
  readonly tiles: readonly TileMeta[];
  /**
   * Decode tile `index` at full image resolution. The **caller owns** the bitmap and must `close()`
   * it when evicting. Concurrent calls for the same tile may share work. Rejects with an
   * `AbortError` when `signal` aborts.
   */
  getTileBitmap(index: number, signal?: AbortSignal): Promise<ImageBitmap>;
  /** Release workers and caches. The source is unusable afterwards. */
  dispose(): void;
}

/**
 * Open a finished session for display. Rejects with `Error('NO_SESSION')` when the id is unknown
 * and `Error('NOT_FINAL')` while it is still `capturing` (use `waitForFinalSession` first) or
 * `Error('CAPTURE_FAILED')` for status `error`.
 */
export type OpenCaptureSource = (sessionId: SessionId) => Promise<CaptureSource>;
