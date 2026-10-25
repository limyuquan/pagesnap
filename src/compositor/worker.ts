/**
 * Compositor worker (owner: A): renders display tiles off the main thread with OffscreenCanvas
 * and transfers them back as ImageBitmaps. Reads slices straight from IndexedDB.
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
      r.render(msg.rect).then(
        (bitmap) => post({ t: 'tile', id: msg.id, bitmap }, [bitmap]),
        (err: unknown) =>
          post({ t: 'error', id: msg.id, message: String((err as Error)?.message ?? err) }),
      );
      return;
    }
    case 'dispose': {
      renderer?.dispose();
      renderer = null;
      scope.close();
    }
  }
};

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}
