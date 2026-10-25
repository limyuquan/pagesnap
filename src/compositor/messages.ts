/** Main thread ↔ compositor worker messages (internal to the compositor). */
import type { BaseLayout, Rect, SessionId } from '@/shared/types';

export type TilePriority = 'high' | 'low';

export type ToWorker =
  | { t: 'init'; sessionId: SessionId; layout: BaseLayout }
  /** Render `rect` (image px) at `scale` output px per image px (1 = full resolution). */
  | { t: 'tile'; id: number; rect: Rect; scale: number; priority: TilePriority }
  /** Drop a queued render (a running one is answered, and the caller closes the late bitmap). */
  | { t: 'cancel'; id: number }
  | { t: 'dispose' };

export type FromWorker =
  | { t: 'ready' }
  | { t: 'tile'; id: number; bitmap: ImageBitmap }
  | { t: 'error'; id: number; message: string; name?: string };
