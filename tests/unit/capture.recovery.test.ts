import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { recoverAllInterrupted, recoverInterrupted } from '@/capture/orchestrator';
import { getSession, putSession } from '@/shared/db';
import { ACTIVE_CAPTURE_KEY } from '@/shared/protocol';
import type { CaptureSession, SliceMeta } from '@/shared/types';

const slice = (index: number, y: number): SliceMeta => ({
  index,
  scroll: { x: 0, y },
  bitmap: { w: 2560, h: 1600 },
  capturedAt: 0,
  target: {
    kind: 'document',
    clientRect: { x: 0, y: 0, w: 1280, h: 800 },
    range: { x0: 0, x1: 0, y0: 0, y1: 4000 },
    content: { w: 1280, h: 4800 },
  },
});

const capturing = (id: string, slices: SliceMeta[]): CaptureSession => ({
  v: 1,
  id,
  url: 'https://example.com/',
  title: 'x',
  createdAt: 1,
  updatedAt: 1,
  mode: 'full',
  status: 'capturing',
  error: null,
  warnings: [],
  progress: { done: slices.length, total: 6 },
  viewport: { w: 1280, h: 800 },
  dpr: 1, // not written until the end
  css: { w: 0, h: 0 },
  image: { w: 0, h: 0 },
  slices,
  layout: { size: { w: 0, h: 0 }, background: '#ffffff', fills: [], parts: [] },
});

describe('recovery after the service worker died mid-capture', () => {
  it('marks the active capture partial with a usable layout', async () => {
    await putSession(capturing('a', [slice(0, 0), slice(1, 798)]));
    await fakeBrowser.storage.session.set({ [ACTIVE_CAPTURE_KEY]: 'a' });
    await recoverInterrupted();
    const s = await getSession('a');
    expect(s?.status).toBe('partial');
    expect(s?.error?.code).toBe('INTERRUPTED');
    expect(s?.dpr).toBe(2);
    expect(s?.image).toEqual({ w: 2560, h: (798 + 800) * 2 });
    expect(s?.layout.parts).toHaveLength(2);
    expect(
      (await fakeBrowser.storage.session.get(ACTIVE_CAPTURE_KEY))[ACTIVE_CAPTURE_KEY],
    ).toBeUndefined();
  });

  it('marks a capture without slices as an error, and sweeps all on browser start', async () => {
    await putSession(capturing('b', []));
    await recoverAllInterrupted();
    const s = await getSession('b');
    expect(s?.status).toBe('error');
    expect(s?.error?.message).toMatch(/interrupted/);
  });
});
