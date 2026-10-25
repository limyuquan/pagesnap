/** Main thread ↔ compositor worker messages (internal to A). */
import type { BaseLayout, Rect, SessionId } from '@/shared/types';

export type ToWorker =
  | { t: 'init'; sessionId: SessionId; layout: BaseLayout }
  | { t: 'tile'; id: number; rect: Rect }
  | { t: 'dispose' };

export type FromWorker =
  | { t: 'tile'; id: number; bitmap: ImageBitmap }
  | { t: 'error'; id: number; message: string };
