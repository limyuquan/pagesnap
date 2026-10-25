/**
 * Retention in the real SW: `runtime.getContexts` sees open editor tabs (with the `#s=<id>` hash in
 * `documentUrl`), so a session that is open in an editor survives even when it is old enough to go.
 */
import type { Worker } from '@playwright/test';
// Type import so this program sees the `__pagesnapCapture` global declaration.
import type {} from '@/capture/testHook';
import { type ChromeGlobal, expect, test } from './fixtures';

const DAY = 24 * 60 * 60 * 1000;
const tiny = { cssW: 200, cssH: 400, viewportH: 400, dpr: 1 };

/** Rewrite `createdAt`/`updatedAt` of sessions straight in the SW's IndexedDB. */
async function age(sw: Worker, ids: string[], at: number): Promise<void> {
  await sw.evaluate(
    ([sessionIds, when]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('pagesnap');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('sessions', 'readwrite');
          const store = tx.objectStore('sessions');
          for (const id of sessionIds) {
            const get = store.get(id);
            get.onsuccess = () => store.put({ ...get.result, createdAt: when, updatedAt: when });
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [ids, at] as const,
  );
}

const exists = (sw: Worker, id: string) =>
  sw.evaluate(async (sid) => (await globalThis.__pagesnapCapture?.session(sid)) != null, id);

test('retention keeps sessions whose editor is open and deletes other old ones', async ({
  serviceWorker,
  pagesnap,
  extensionId,
}) => {
  const old: string[] = [];
  for (let i = 0; i < 3; i++) old.push(await pagesnap.seedSession({ ...tiny, title: `old ${i}` }));
  await age(serviceWorker, old, Date.now() - 8 * DAY);
  // Ten newer sessions fill the "always keep the newest 10" window.
  const fresh: string[] = [];
  for (let i = 0; i < 10; i++) {
    fresh.push(await pagesnap.seedSession({ ...tiny, title: `new ${i}` }));
  }

  const [oldA = '', oldOpen = '', oldC = ''] = old;
  const editor = await pagesnap.openEditor(oldOpen);
  await editor.waitForLoadState('domcontentloaded');

  // What the retention pass relies on: the TAB context's documentUrl carries the hash.
  const urls = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    return contexts.map((c) => c.documentUrl ?? '');
  });
  expect(urls).toContain(`chrome-extension://${extensionId}/editor.html#s=${oldOpen}`);

  const result = await serviceWorker.evaluate(() => {
    const hook = globalThis.__pagesnapCapture;
    if (!hook) throw new Error('__pagesnapCapture hook missing: not an e2e build?');
    return hook.runRetention({ reason: 'capture' });
  });
  expect([...result.deleted].sort()).toEqual([oldA, oldC].sort());
  expect(await exists(serviceWorker, oldOpen)).toBe(true);
  expect(await exists(serviceWorker, oldA)).toBe(false);
  expect(await exists(serviceWorker, oldC)).toBe(false);
  for (const id of fresh) expect(await exists(serviceWorker, id)).toBe(true);

  // Once the editor is closed, the old session is no longer protected.
  await editor.close();
  const again = await serviceWorker.evaluate(
    () => globalThis.__pagesnapCapture?.runRetention({ reason: 'capture' }) ?? null,
  );
  expect(again?.deleted).toEqual([oldOpen]);
});

test('retention never deletes just-captured sessions, even many of them, nor their slices', async ({
  pagesnap,
  serviceWorker,
}) => {
  // A user captures 14 pages in a row and opens the editors later; meanwhile retention runs
  // after every capture and while slices are being written (seeding writes slices first).
  const ids: string[] = [];
  for (let i = 0; i < 14; i++) {
    const [id] = await Promise.all([
      pagesnap.seedSession(tiny),
      serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.runRetention({ force: true })),
    ]);
    ids.push(id);
  }
  await serviceWorker.evaluate(() => globalThis.__pagesnapCapture?.runRetention({ force: true }));
  for (const id of ids) expect(await exists(serviceWorker, id)).toBe(true);
  // Every slice is still there: the newest and the oldest composite without "not found".
  for (const id of [ids[0], ids[13]] as string[]) {
    const b64 = await serviceWorker.evaluate(
      (sid) => globalThis.__pagesnapCapture?.compositePng(sid) ?? '',
      id,
    );
    expect(b64.length).toBeGreaterThan(100);
  }
  // Opened later, an editor loads it fine.
  const editor = await pagesnap.openEditor(ids[0] as string);
  await expect
    .poll(() => editor.evaluate(() => window.__pagesnapTest?.isReady() ?? false))
    .toBe(true);
});
