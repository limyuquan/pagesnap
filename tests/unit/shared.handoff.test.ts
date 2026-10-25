import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { putSession } from '@/shared/db';
import {
  editorUrl,
  parseEditorHash,
  publishSessionStatus,
  waitForFinalSession,
} from '@/shared/handoff';
import type { CaptureSession } from '@/shared/types';

const base: CaptureSession = {
  v: 1,
  id: 'abc',
  url: 'http://localhost/x.html',
  title: 'x',
  createdAt: 1,
  updatedAt: 1,
  mode: 'full',
  status: 'capturing',
  error: null,
  warnings: [],
  progress: { done: 1, total: 3 },
  viewport: { w: 100, h: 100 },
  dpr: 1,
  css: { w: 100, h: 300 },
  image: { w: 100, h: 300 },
  slices: [],
  layout: { size: { w: 100, h: 300 }, background: '#fff', fills: [], parts: [] },
};

describe('editor hash', () => {
  it('round-trips the session id', () => {
    const url = new URL(editorUrl('mh5x-a1b2'));
    expect(url.pathname).toBe('/editor.html');
    expect(parseEditorHash(url.hash)).toBe('mh5x-a1b2');
    expect(parseEditorHash('')).toBeNull();
  });
});

describe('waitForFinalSession', () => {
  it('follows the status mirror until the session is final', async () => {
    await putSession(base);
    await publishSessionStatus(base);
    const progress: number[] = [];
    const done = waitForFinalSession('abc', { onProgress: (s) => progress.push(s.progress.done) });

    const ready = { ...base, status: 'ready' as const, progress: { done: 3, total: 3 } };
    await new Promise((r) => setTimeout(r, 10));
    await putSession(ready);
    await publishSessionStatus(ready);

    expect((await done).status).toBe('ready');
    expect(progress).toEqual([1, 3]);
  });

  it('falls back to IndexedDB when there is no mirror', async () => {
    await putSession({ ...base, status: 'partial' });
    expect((await waitForFinalSession('abc')).status).toBe('partial');
  });

  it('rejects for unknown sessions', async () => {
    fakeBrowser.reset();
    await expect(waitForFinalSession('nope')).rejects.toThrow('NO_SESSION');
  });
});
