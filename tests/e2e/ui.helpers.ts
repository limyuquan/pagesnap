/**
 * UI (C) e2e helpers: seed sessions in states the synthetic seeder can't produce (partial, error,
 * capturing), seed an LMS-like capture made from a fixture page, seed annotation docs, and drive
 * the e2e-only `window.__pagesnapUi` store hook.
 *
 * Sessions are written with raw IndexedDB from the service worker. The DB and its stores always
 * exist first, because every helper starts from `seedSyntheticSession` (which opens the DB through
 * `openDb`, running the schema upgrade).
 */
import type { Page, Worker } from '@playwright/test';
import type { EditorState } from '@/editor/engine';
import type { AnnotationDoc, Shape } from '@/shared/annotations';
import type { CaptureSession } from '@/shared/types';
import type { PagesnapHelpers } from './fixtures';

type SessionPatch = Partial<Omit<CaptureSession, 'id' | 'v'>>;

/** Read-modify-write a session record in IDB (raw API, from the SW). */
export async function patchSession(sw: Worker, id: string, patch: SessionPatch): Promise<void> {
  await sw.evaluate(
    async ({ id, patch }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('pagesnap');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const get = store.get(id);
        get.onsuccess = () => store.put({ ...get.result, ...patch, updatedAt: Date.now() });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { id, patch },
  );
}

/** Store an annotation doc for a session (the engine loads it through `migrateDoc`). */
export async function seedDoc(sw: Worker, doc: AnnotationDoc): Promise<void> {
  await sw.evaluate(async (doc) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('pagesnap');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res, rej) => {
      const tx = db.transaction('docs', 'readwrite');
      tx.objectStore('docs').put(doc);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, doc);
}

export interface ImageSessionOptions {
  title: string;
  url: string;
  /** CSS width of the page. */
  cssW: number;
  dpr: number;
  /** Full-page PNG (image px), base64. */
  pngBase64: string;
}

/**
 * Turn a full-page PNG into a realistic `ready` session: slices one viewport tall, a layout that
 * places them, title and URL. Reuses a synthetic session's id and replaces its content.
 */
export async function seedImageSession(
  sw: Worker,
  pagesnap: PagesnapHelpers,
  opts: ImageSessionOptions,
): Promise<string> {
  const id = await pagesnap.seedSession({ cssW: opts.cssW, cssH: 900, dpr: opts.dpr });
  await sw.evaluate(
    async ({ id, opts }) => {
      const bytes = Uint8Array.from(atob(opts.pngBase64), (c) => c.charCodeAt(0));
      const full = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const W = full.width;
      const H = full.height;
      const vh = Math.round(800 * opts.dpr);
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('pagesnap');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = (stores: string[]) => db.transaction(stores, 'readwrite');
      // Drop the synthetic slices.
      await new Promise<void>((res) => {
        const t = tx(['slices']);
        t.objectStore('slices').delete(IDBKeyRange.bound([id, 0], [id, 1e9]));
        t.oncomplete = () => res();
      });
      const slices: unknown[] = [];
      const parts: unknown[] = [];
      let index = 0;
      for (let y = 0; y < H; y += vh, index++) {
        const top = Math.min(y, Math.max(0, H - vh));
        const h = Math.min(vh, H);
        const c = new OffscreenCanvas(W, h);
        c.getContext('2d')?.drawImage(full, 0, top, W, h, 0, 0, W, h);
        const blob = await c.convertToBlob({ type: 'image/png' });
        await new Promise<void>((res) => {
          const t = tx(['slices']);
          t.objectStore('slices').put({ sessionId: id, index, blob });
          t.oncomplete = () => res();
        });
        const cssW = W / opts.dpr;
        slices.push({
          index,
          scroll: { x: 0, y: top / opts.dpr },
          bitmap: { w: W, h },
          target: {
            kind: 'document',
            clientRect: { x: 0, y: 0, w: cssW, h: h / opts.dpr },
            range: { x0: 0, x1: 0, y0: 0, y1: (H - h) / opts.dpr },
            content: { w: cssW, h: H / opts.dpr },
          },
          capturedAt: Date.now(),
        });
        parts.push({ slice: index, src: { x: 0, y: 0, w: W, h }, dest: { x: 0, y: top } });
      }
      full.close();
      await new Promise<void>((res) => {
        const t = tx(['sessions']);
        const store = t.objectStore('sessions');
        const get = store.get(id);
        get.onsuccess = () => {
          const image = { w: W, h: H };
          store.put({
            ...get.result,
            title: opts.title,
            url: opts.url,
            viewport: { w: W / opts.dpr, h: 800 },
            dpr: opts.dpr,
            css: { w: W / opts.dpr, h: H / opts.dpr },
            image,
            slices,
            progress: { done: slices.length, total: slices.length },
            layout: { size: image, background: '#ffffff', fills: [], parts },
          });
        };
        t.oncomplete = () => res();
      });
      db.close();
    },
    { id, opts },
  );
  return id;
}

type Box = { x: number; y: number; w: number; h: number };
/** Where the demo marks go, CSS px of the unrolled page. */
export interface LmsTargets {
  due: Box;
  submitting: Box;
  wordCount: Box;
}

/**
 * Full-page PNG of the Canvas-LMS-like fixture (inner-scroller.html), unrolled so the document
 * scrolls, at the context's device scale factor, plus the boxes of a few phrases to annotate.
 */
export async function lmsPagePng(pagesnap: PagesnapHelpers): Promise<{
  pngBase64: string;
  cssW: number;
  title: string;
  url: string;
  targets: LmsTargets;
}> {
  const page = await pagesnap.openFixture('inner-scroller');
  await page.addStyleTag({
    content: `html,body{height:auto!important;overflow:visible!important}
      body{position:relative}
      #global-nav{position:absolute!important;top:0;bottom:0;height:auto}
      #app{height:auto!important}
      #content{overflow:visible!important}`,
  });
  const cssW = await page.evaluate(() => document.documentElement.clientWidth);
  const targets = await page.evaluate(() => {
    const find = (from: string, to: string) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let start: { node: Text; i: number } | null = null;
      let end: { node: Text; i: number } | null = null;
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const t = n.data;
        if (!start && t.includes(from)) start = { node: n, i: t.indexOf(from) };
        if (start && t.includes(to)) {
          end = { node: n, i: t.indexOf(to) + to.length };
          break;
        }
      }
      if (!start || !end) throw new Error(`text not found: ${from}…${to}`);
      const r = document.createRange();
      r.setStart(start.node, start.i);
      r.setEnd(end.node, end.i);
      const b = r.getBoundingClientRect();
      return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height };
    };
    return {
      due: find('Due', '23:59'),
      submitting: find('Submitting', 'external tool'),
      wordCount: find('Write a 1000', 'word reflection'),
    };
  });
  const buf = await page.screenshot({ fullPage: true });
  const title = await page.title();
  await page.close();
  return {
    pngBase64: buf.toString('base64'),
    cssW,
    title,
    url: 'https://canvas.example.edu/courses/1010/assignments/42',
    targets,
  };
}

/** A few annotations on the LMS fixture, the way someone would mark it up for an AI chat. */
export function lmsAnnotations(
  sessionId: string,
  image: { w: number; h: number },
  dpr: number,
  t: LmsTargets,
): AnnotationDoc {
  const p = (x: number, y: number) => ({ x: Math.round(x * dpr), y: Math.round(y * dpr) });
  const pad = 7;
  const box = { x: t.due.x - pad, y: t.due.y - pad, w: t.due.w + pad * 2, h: t.due.h + pad * 2 };
  const tail = { x: box.x + box.w + 190, y: box.y + box.h + 120 };
  const shapes: Shape[] = [
    {
      id: 'hl000001',
      kind: 'highlight',
      color: '#FFD60A',
      shadow: false,
      a: p(t.submitting.x - 2, t.submitting.y + t.submitting.h / 2),
      b: p(t.submitting.x + t.submitting.w + 2, t.submitting.y + t.submitting.h / 2),
      thickness: 22 * dpr,
      opacity: 0.45,
    },
    {
      id: 'rect0001',
      kind: 'rect',
      color: '#FF3B30',
      shadow: true,
      box: { ...p(box.x, box.y), w: Math.round(box.w * dpr), h: Math.round(box.h * dpr) },
      width: 5 * dpr,
      fill: 'none',
    },
    {
      id: 'arrow001',
      kind: 'arrow',
      color: '#FF3B30',
      shadow: true,
      a: p(tail.x, tail.y),
      b: p(box.x + box.w + 10, box.y + box.h + 8),
      width: 6 * dpr,
      bend: 0,
      heads: 'end',
    },
    {
      id: 'text0001',
      kind: 'text',
      color: '#FF3B30',
      shadow: true,
      at: p(tail.x + 10, tail.y - 6),
      text: 'Is this the final deadline?',
      size: 26 * dpr,
      weight: 700,
      style: 'outline',
    },
    {
      id: 'under001',
      kind: 'underline',
      color: '#FF3B30',
      shadow: true,
      a: p(t.wordCount.x, t.wordCount.y + t.wordCount.h + 4),
      b: p(t.wordCount.x + t.wordCount.w, t.wordCount.y + t.wordCount.h + 4),
      width: 5 * dpr,
    },
  ];
  return {
    v: 1,
    sessionId,
    rev: 1,
    image: { ...image, dpr },
    shapes,
    crop: null,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------- store hook

type UiState = Omit<EditorState, 'actions' | 'source'>;
/** `window.__pagesnapUi` (declared in src/editor/ui/testHook.ts, which this tsconfig doesn't see). */
type UiWindow = {
  __pagesnapUi?: { getState(): unknown; setState(patch: Record<string, unknown>): void };
};

export async function uiState(page: Page): Promise<UiState> {
  return page.evaluate(() => {
    const hook = (window as unknown as UiWindow).__pagesnapUi;
    if (!hook) throw new Error('__pagesnapUi missing: not an e2e build?');
    return JSON.parse(JSON.stringify(hook.getState())) as UiState;
  });
}

export async function setUiState(page: Page, patch: Partial<EditorState>): Promise<void> {
  await page.evaluate(
    (p) => {
      const hook = (window as unknown as UiWindow).__pagesnapUi;
      if (!hook) throw new Error('__pagesnapUi missing: not an e2e build?');
      hook.setState(p);
    },
    patch as Record<string, unknown>,
  );
}

/** Wait until the editor reports ready (engine), or force the phase when the engine is a stub. */
export async function waitReady(page: Page, { force = false } = {}): Promise<boolean> {
  const root = page.getByTestId('editor-root');
  try {
    await root.and(page.locator('[data-phase="ready"]')).waitFor({ timeout: force ? 4000 : 15000 });
    return true;
  } catch (err) {
    if (!force) throw err;
    await setUiState(page, { load: { phase: 'ready' } });
    await root.and(page.locator('[data-phase="ready"]')).waitFor();
    return false;
  }
}
