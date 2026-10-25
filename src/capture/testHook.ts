/**
 * A-owned e2e hook on the SW global as `__pagesnapCapture` (e2e builds only, wired in
 * background.ts). Separate from the Phase-0 `__pagesnap` hook so that contract stays unchanged.
 */
import { openCaptureSource } from '@/compositor';
import { compositeRegion } from '@/shared/composite';
import { getSession, getSliceBlob } from '@/shared/db';
import type { CaptureSession, Rect, SessionId } from '@/shared/types';
import { activeCaptureId, cancelCapture, testFlags } from './orchestrator';
import type { PopupState, PopupToSw } from './popupProtocol';
import { getProgress, lastPopupPerf, viewerCount } from './progress';
import { type RetentionOptions, type RetentionResult, runRetention } from './retention';
import { type CaptureTimings, getTimings } from './timings';

export interface CaptureTestHook {
  /** Make the next captures behave as if the page couldn't be scripted. */
  forceRestricted(on: boolean): void;
  /** Set test-only switches (slice/final write failures, pause limit). Returns the new flags. */
  setFlags(flags: Partial<typeof testFlags>): typeof testFlags;
  activeId(): SessionId | null;
  /** What Stop in the popup does during a capture. */
  cancel(): boolean;
  /** Popups connected right now. */
  viewers(): number;
  /** The progress the popup of `tabId` is shown, if any. */
  progress(tabId: number): PopupState | null;
  /** The last popup's first-paint report. */
  popupPerf(): Extract<PopupToSw, { t: 'perf' }> | null;
  session(id: SessionId): Promise<CaptureSession | null>;
  timings(id: SessionId): Promise<CaptureTimings | null>;
  /** Composite `region` (image px, default the whole image) at `scale` with `compositeRegion`. Base64 PNG. */
  compositePng(id: SessionId, region?: Rect, scale?: number): Promise<string>;
  /** Display tile `index` through `openCaptureSource` (the editor's path). Base64 PNG. */
  tilePng(id: SessionId, index: number): Promise<string>;
  /** Run the SW retention pass now (default `force: true`, so the start-up throttle is skipped). */
  runRetention(opts?: RetentionOptions): Promise<RetentionResult>;
}

declare global {
  var __pagesnapCapture: CaptureTestHook | undefined;
}

export const captureTestHook: CaptureTestHook = {
  forceRestricted(on) {
    testFlags.forceRestricted = on;
  },
  setFlags(flags) {
    Object.assign(testFlags, flags);
    return { ...testFlags };
  },
  activeId: activeCaptureId,
  cancel: () => cancelCapture('button'),
  viewers: viewerCount,
  progress: getProgress,
  popupPerf: lastPopupPerf,
  async session(id) {
    return (await getSession(id)) ?? null;
  },
  timings: getTimings,
  runRetention: (opts = {}) => runRetention({ force: true, ...opts }),
  async compositePng(id, region, scale = 1) {
    const session = await getSession(id);
    if (!session) throw new Error('NO_SESSION');
    const r = region ?? { x: 0, y: 0, w: session.image.w, h: session.image.h };
    const canvas = new OffscreenCanvas(Math.round(r.w * scale), Math.round(r.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    await compositeRegion(ctx, session.layout, r, scale, (i) => getSliceBlob(id, i));
    return toBase64(await canvas.convertToBlob({ type: 'image/png' }));
  },
  async tilePng(id, index) {
    const source = await openCaptureSource(id);
    try {
      const bmp = await source.getTileBitmap(index);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
      return toBase64(await canvas.convertToBlob({ type: 'image/png' }));
    } finally {
      source.dispose();
    }
  },
};

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
