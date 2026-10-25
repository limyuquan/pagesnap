import { describe, expect, it } from 'vitest';
import { emptyDoc } from '@/shared/annotations';
import {
  countSlices,
  deleteSession,
  getDoc,
  getSession,
  getSliceBlob,
  listSessions,
  putDoc,
  putSession,
  putSlice,
  updateSession,
} from '@/shared/db';
import type { CaptureSession } from '@/shared/types';

function session(id: string, createdAt: number): CaptureSession {
  const size = { w: 200, h: 400 };
  return {
    v: 1,
    id,
    url: 'http://localhost/x.html',
    title: 'x',
    createdAt,
    updatedAt: createdAt,
    mode: 'full',
    status: 'capturing',
    error: null,
    warnings: [],
    progress: { done: 0, total: 2 },
    viewport: { w: 100, h: 100 },
    dpr: 2,
    css: { w: 100, h: 200 },
    image: size,
    slices: [],
    layout: { size, background: '#fff', fills: [], parts: [] },
  };
}

describe('db', () => {
  it('stores and updates sessions', async () => {
    await putSession(session('a', 1));
    const next = await updateSession('a', (s) => ({ ...s, status: 'ready' }));
    expect(next.status).toBe('ready');
    expect((await getSession('a'))?.status).toBe('ready');
    await expect(updateSession('missing', (s) => s)).rejects.toThrow(/not found/);
  });

  it('lists sessions newest first', async () => {
    await putSession(session('old', 1));
    await putSession(session('new', 2));
    expect((await listSessions()).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('stores slice blobs and cascades deletes', async () => {
    await putSession(session('a', 1));
    await putSession(session('b', 1));
    await putSlice({ sessionId: 'a', index: 0, blob: new Blob(['0']) });
    await putSlice({ sessionId: 'a', index: 1, blob: new Blob(['1']) });
    await putSlice({ sessionId: 'b', index: 0, blob: new Blob(['b']) });
    await putDoc(emptyDoc('a', { w: 200, h: 400, dpr: 2 }));
    expect(await countSlices('a')).toBe(2);
    expect(await (await getSliceBlob('a', 1)).text()).toBe('1');

    await deleteSession('a');
    expect(await getSession('a')).toBeUndefined();
    expect(await countSlices('a')).toBe(0);
    expect(await getDoc('a')).toBeUndefined();
    expect(await countSlices('b')).toBe(1);
  });
});
