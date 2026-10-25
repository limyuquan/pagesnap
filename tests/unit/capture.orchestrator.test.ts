import { describe, expect, it } from 'vitest';
import { progressText } from '@/capture/badge';
import { createShooter, isQuotaError } from '@/capture/limiter';
import { dataUrlToBlob, pngBlobSize, pngSize } from '@/capture/png';
import {
  classifyInjectError,
  classifyRestrictedUrl,
  restrictedErrorMessage,
  visibleOnlyMessage,
} from '@/capture/restricted';

/** Fake clock: sleeping advances time instantly. */
function clock() {
  let t = 1000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createShooter', () => {
  it('starts captures at least minGapMs apart, with no wait for the first one', async () => {
    const c = clock();
    const calls: number[] = [];
    const s = createShooter({
      ...c,
      minGapMs: 530,
      capture: async () => {
        calls.push(c.now());
        c.advance(80); // captureVisibleTab itself takes time
        return 'data:';
      },
    });
    await s.shoot();
    c.advance(100); // the agent scrolls and settles in between
    await s.shoot();
    await s.shoot();
    expect(calls).toEqual([1000, 1530, 2060]);
    expect(s.starts).toEqual(calls);
  });

  it('does not wait when the step already took longer than the gap', async () => {
    const c = clock();
    const s = createShooter({ ...c, minGapMs: 530, capture: async () => 'x' });
    await s.shoot();
    c.advance(900);
    expect(s.waitTime()).toBe(0);
    await s.shoot();
    expect(s.starts).toEqual([1000, 1900]);
  });

  it('retries quota errors and gives up on other errors', async () => {
    const c = clock();
    let n = 0;
    const s = createShooter({
      ...c,
      minGapMs: 500,
      capture: async () => {
        n++;
        if (n < 3)
          throw new Error(
            'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.',
          );
        return 'ok';
      },
    });
    expect(await s.shoot()).toBe('ok');
    expect(n).toBe(3);
    // Every retry still respects the gap.
    const gaps = s.starts.slice(1).map((t, i) => t - (s.starts[i] ?? 0));
    expect(gaps.every((g) => g >= 500)).toBe(true);

    const bad = createShooter({
      ...c,
      minGapMs: 500,
      capture: async () => Promise.reject(new Error('nope')),
    });
    await expect(bad.shoot()).rejects.toThrow('nope');
    // Other errors are retried twice (transient "Failed to capture tab"), then surface.
    expect(bad.starts).toHaveLength(3);
  });

  it('recovers from a transient non-quota failure', async () => {
    const c = clock();
    let n = 0;
    const s = createShooter({
      ...c,
      minGapMs: 500,
      capture: async () => {
        if (n++ === 0) throw new Error('Failed to capture tab: unknown error');
        return 'ok';
      },
    });
    expect(await s.shoot()).toBe('ok');
  });

  it('stops retrying after maxRetries', async () => {
    const c = clock();
    const s = createShooter({
      ...c,
      minGapMs: 500,
      maxRetries: 2,
      capture: async () => Promise.reject(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')),
    });
    await expect(s.shoot()).rejects.toThrow('MAX_CAPTURE');
    expect(s.starts).toHaveLength(3);
  });

  it('honours an aborted signal before capturing', async () => {
    const c = clock();
    const s = createShooter({ ...c, minGapMs: 500, capture: async () => 'x' });
    await expect(s.shoot(AbortSignal.abort())).rejects.toBeDefined();
    expect(s.starts).toHaveLength(0);
    expect(isQuotaError('quota exceeded')).toBe(true);
  });
});

describe('restricted pages', () => {
  it('classifies URLs only to explain failures', () => {
    expect(classifyRestrictedUrl('chrome://settings')).toBe('browser-page');
    expect(classifyRestrictedUrl('https://chromewebstore.google.com/detail/x')).toBe('web-store');
    expect(classifyRestrictedUrl('https://chrome.google.com/webstore/detail/x')).toBe('web-store');
    expect(classifyRestrictedUrl('https://example.com/paper.PDF')).toBe('pdf');
    expect(classifyRestrictedUrl('file:///Users/me/a.html', false)).toBe('file-no-access');
    expect(classifyRestrictedUrl('file:///Users/me/a.html', true)).toBe('unknown');
    expect(classifyRestrictedUrl('chrome-extension://abc/x.html')).toBe('extension-page');
    expect(classifyRestrictedUrl('data:text/html,hi')).toBe('data-url');
    expect(classifyRestrictedUrl(undefined)).toBe('unknown');
    expect(classifyRestrictedUrl('https://example.com/')).toBe('unknown');
  });

  it('falls back to the executeScript error when the URL is hidden', () => {
    expect(classifyInjectError('Cannot access a chrome:// URL')).toBe('browser-page');
    expect(classifyInjectError('The extensions gallery cannot be scripted.')).toBe('web-store');
    expect(classifyInjectError('Cannot access contents of url "file:///x"')).toBe('file-no-access');
    expect(classifyInjectError('something else')).toBe('unknown');
  });

  it('has human-readable messages', () => {
    expect(visibleOnlyMessage('pdf')).toMatch(/PDF viewer.*only the visible area/);
    expect(restrictedErrorMessage('file-no-access')).toMatch(/Allow access to file URLs/);
    expect(restrictedErrorMessage('browser-page')).toMatch(/^Chrome doesn’t let extensions/);
  });
});

describe('png helpers', () => {
  // 1×1 transparent PNG, then a 3×2 IHDR.
  const ONE =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('reads the size from IHDR without decoding', async () => {
    const blob = dataUrlToBlob(ONE);
    expect(blob.type).toBe('image/png');
    expect(await pngBlobSize(blob)).toEqual({ w: 1, h: 1 });
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(bytes.buffer).setUint32(16, 2560);
    new DataView(bytes.buffer).setUint32(20, 1626);
    expect(pngSize(bytes)).toEqual({ w: 2560, h: 1626 });
    expect(() => pngSize(new Uint8Array(24))).toThrow('Not a PNG');
  });
});

describe('badge', () => {
  it('shows a percentage that never reaches 100 before the end', () => {
    expect(progressText(0, 0)).toBe('…');
    expect(progressText(1, 10)).toBe('10%');
    expect(progressText(10, 10)).toBe('99%');
  });
});

describe('snapScale', () => {
  it('snaps the measured scale to devicePixelRatio when they agree (browser zoom)', async () => {
    const { snapScale } = await import('@/capture/orchestrator');
    // 110% zoom at DPR 2: innerWidth 1163 is rounded, so 2560 / 1163 = 2.2012.
    expect(snapScale(2560 / 1163, 2.200000047683716)).toBe(2.2);
    expect(snapScale(2560 / 853, 3.0000001)).toBe(3); // 150%
    expect(snapScale(2, 2)).toBe(2);
    // Disagreement (emulation, forced scale): keep what the bitmap says.
    expect(snapScale(2, 1)).toBe(2);
    expect(snapScale(1.5, undefined)).toBe(1.5);
    expect(snapScale(0, 2)).toBe(1);
  });
});

describe('shiftConsensus', () => {
  it('agrees on the movement of most anchors', async () => {
    const { shiftConsensus } = await import('@/capture/anchor');
    expect(shiftConsensus([0, 0, 0.2, Number.NaN])).toEqual({
      d: 0,
      n: 3,
      reliable: true,
      moved: false,
    });
    const grown = shiftConsensus([120, 120.4, 119.8, 120, 0]);
    expect(grown.reliable).toBe(true);
    expect(grown.d).toBeCloseTo(120, 0);
    expect(shiftConsensus([-48, -48, -48]).d).toBe(-48);
  });

  it('refuses to guess when anchors disagree or are gone', async () => {
    const { shiftConsensus } = await import('@/capture/anchor');
    const split = shiftConsensus([0, 0, 50, 50, 90]);
    expect(split.reliable).toBe(false);
    expect(split.moved).toBe(true);
    expect(split.d).toBe(0);
    expect(shiftConsensus([Number.NaN, Number.NaN])).toEqual({
      d: 0,
      n: 0,
      reliable: false,
      moved: false,
    });
  });
});
