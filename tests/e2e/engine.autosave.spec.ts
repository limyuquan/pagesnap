/**
 * Autosave edge cases (correctness #9): a doc restored from the sessionStorage mirror is written
 * back to IndexedDB, and two editor tabs on one capture stay in step instead of overwriting
 * each other.
 */
import type { Page } from '@playwright/test';
import { dragImage, snapshot, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

/** The stored doc for a session, read straight from IndexedDB in `page`. */
function storedDoc(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('pagesnap');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      return await new Promise<{ rev: number; shapes: { id: string }[] } | undefined>((res) => {
        const r = db.transaction('docs').objectStore('docs').get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
    } finally {
      db.close();
    }
  }, sessionId);
}

test('a doc restored from the sessionStorage mirror is saved back to IndexedDB', async ({
  pagesnap,
}) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await dragImage(ed, { x: 300, y: 600 }, { x: 1300, y: 900 });
  // biome-ignore lint/suspicious/noExplicitAny: test hook
  await ed.evaluate(() => (window as any).__pagesnapEngine.flushAutosave());
  expect((await storedDoc(ed, id))?.rev).toBe(1);

  // As if the tab reloaded before IDB caught up: the mirror holds a newer doc.
  await ed.evaluate((sid) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const doc = (window as any).__pagesnapEngine.state().doc;
    const extra = {
      ...doc.shapes[0],
      id: 'mirror01',
      a: { x: 300, y: 1600 },
      b: { x: 900, y: 1800 },
    };
    sessionStorage.setItem(
      `pagesnap:doc:${sid}`,
      JSON.stringify({ ...doc, rev: 5, shapes: [...doc.shapes, extra], updatedAt: Date.now() }),
    );
  }, id);
  await ed.reload();
  await waitReady(ed);
  const s = await snapshot(ed);
  expect(s.rev).toBe(5);
  expect(s.shapes.map((x) => x.id)).toContain('mirror01');
  // …and it reaches IDB without any further edit, so closing the tab now keeps it.
  await expect.poll(async () => (await storedDoc(ed, id))?.rev, { timeout: 5_000 }).toBe(5);
});

test('two editor tabs on one capture stay in step; the newest doc wins in IDB', async ({
  pagesnap,
}) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const a = await pagesnap.openEditor(id);
  await waitReady(a);
  const b = await pagesnap.openEditor(id);
  await waitReady(b);

  await a.bringToFront();
  await dragImage(a, { x: 300, y: 600 }, { x: 1300, y: 900 });
  await expect.poll(async () => (await snapshot(b)).shapes.length).toBe(1);
  const external = await b.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    () => (window as any).__pagesnapEngine.state().externalEditAt as number | null,
  );
  expect(external).not.toBeNull();

  await b.bringToFront();
  await b.keyboard.press('r');
  await dragImage(b, { x: 400, y: 1200 }, { x: 900, y: 1500 });
  await expect.poll(async () => (await snapshot(a)).shapes.length).toBe(2);
  const [sa, sb] = [await snapshot(a), await snapshot(b)];
  expect(sa.rev).toBe(sb.rev);
  expect(sa.shapes.map((x) => x.id)).toEqual(sb.shapes.map((x) => x.id));

  // Both tabs autosave; neither may put an older doc over the newer one.
  await expect
    .poll(async () => (await storedDoc(a, id))?.shapes.length, { timeout: 5_000 })
    .toBe(2);
  await a.waitForTimeout(800);
  expect((await storedDoc(b, id))?.rev).toBe(sb.rev);
});
