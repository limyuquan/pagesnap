/**
 * Compositor worker: renders display tiles (any level of detail) off the main thread with
 * OffscreenCanvas and transfers them back as ImageBitmaps. Reads slices straight from IndexedDB.
 */
import { getSliceBlob } from '@/shared/db';
import type { FromWorker, ToWorker } from './messages';
import { createTileRenderer, type TileRenderer } from './render';

// The DOM lib is in scope (no webworker lib, which would clash), so type the bits we use.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker, transfer: Transferable[]): void;
  close(): void;
};
let renderer: TileRenderer | null = null;
const cancelled = new Set<number>();

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.t) {
    case 'init': {
      renderer?.dispose();
      renderer = createTileRenderer(msg.layout, (i) => getSliceBlob(msg.sessionId, i));
      return;
    }
    case 'tile': {
      const r = renderer;
      if (!r) return post({ t: 'error', id: msg.id, message: 'not initialised' });
      const id = msg.id;
      r.render(msg.rect, msg.scale, {
        priority: msg.priority,
        isCancelled: () => cancelled.has(id),
      }).then(
        (bitmap) => {
          if (cancelled.delete(id)) {
            bitmap.close();
            post({ t: 'error', id, name: 'AbortError', message: 'Aborted' });
          } else post({ t: 'tile', id, bitmap }, [bitmap]);
        },
        (err: unknown) => {
          cancelled.delete(id);
          const e = err as { name?: string; message?: string };
          post({ t: 'error', id, name: e?.name ?? 'Error', message: String(e?.message ?? err) });
        },
      );
      return;
    }
    case 'cancel': {
      cancelled.add(msg.id);
      return;
    }
    case 'dispose': {
      renderer?.dispose();
      renderer = null;
      scope.close();
    }
  }
};

post({ t: 'ready' });

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}
