import { describe, expect, it } from 'vitest';
import { captureNotice, copyToast, downloadToast, errorContent } from '@/editor/ui/messages';
import type { SessionMeta } from '@/editor/ui/useSessionMeta';
import { viewPhase } from '@/editor/ui/viewPhase';

const at = 1;
const size = { w: 1280, h: 2400 };

describe('copyToast', () => {
  it('names the full page and its size', () => {
    const t = copyToast(
      { state: 'copied', request: 'default', outcome: 'full', size, tall: false, at },
      2400,
    );
    expect(t).toMatchObject({ tone: 'ok', title: 'Copied full page', size: '1280 × 2400' });
    expect(t?.note).toBeUndefined();
  });

  it('warns when a full copy is tall', () => {
    const t = copyToast(
      { state: 'copied', request: 'full', outcome: 'full', size, tall: true, at },
      9000,
    );
    expect(t?.note).toMatch(/scale it down/);
  });

  it('explains the smart region and points at Shift+Cmd+C', () => {
    const t = copyToast(
      { state: 'copied', request: 'default', outcome: 'smart', size, tall: false, at },
      12400,
    );
    expect(t?.title).toBe('Copied the area around your marks');
    expect(t?.note).toMatch(/^The page is 12,400 px tall\. .*C copies all of it\.$/);
  });

  it('explains the current-view copy', () => {
    const t = copyToast(
      { state: 'copied', request: 'default', outcome: 'viewport', size, tall: false, at },
      12400,
    );
    expect(t?.title).toBe('Copied the current view');
    expect(t?.note).toMatch(/Mark something to copy around it, or .*C for all of it\.$/);
  });

  it('asks for focus when the page lost it', () => {
    const t = copyToast(
      { state: 'failed', request: 'default', reason: 'not-focused', message: '', at },
      null,
    );
    expect(t?.tone).toBe('warn');
    expect(t?.title).toMatch(/^Click the page, then .*C again$/);
  });

  it('is silent when idle and busy while copying', () => {
    expect(copyToast({ state: 'idle' }, 100)).toBeNull();
    expect(copyToast({ state: 'copying', request: 'default' }, 100)?.tone).toBe('busy');
  });
});

describe('downloadToast', () => {
  it('names the saved file', () => {
    expect(
      downloadToast({ state: 'saved', filename: 'a.png', size: { w: 10, h: 20 }, at }),
    ).toMatchObject({ title: 'Saved a.png', size: '10 × 20' });
  });
});

const meta = (over: Partial<SessionMeta>): SessionMeta => ({
  id: 's',
  title: 'T',
  url: 'https://x.test/',
  status: 'ready',
  error: null,
  warnings: [],
  css: { w: 1280, h: 4200 },
  mode: 'full',
  progress: { done: 1, total: 1 },
  ...over,
});

describe('captureNotice', () => {
  it('prefers partial over other warnings', () => {
    const n = captureNotice(
      meta({
        status: 'partial',
        error: { code: 'ABORTED_BY_USER', message: 'x' },
        warnings: [{ code: 'TRUNCATED', message: '' }],
      }),
    );
    expect(n?.lead).toBe('Partial capture.');
    expect(n?.text).toBe('You pressed Esc mid-capture. The image stops at 4,200 px.');
  });

  it('explains visible-only and cut-off captures', () => {
    expect(captureNotice(meta({ mode: 'visible' }))?.lead).toBe('Visible area only.');
    expect(captureNotice(meta({ warnings: [{ code: 'TRUNCATED', message: '' }] }))?.lead).toBe(
      'Cut off.',
    );
  });

  it('says nothing for a clean capture', () => {
    expect(captureNotice(meta({ warnings: [{ code: 'INNER_SCROLLER', message: '' }] }))).toBeNull();
  });
});

describe('errorContent', () => {
  it('maps capture codes to human copy', () => {
    expect(
      errorContent({ code: 'CAPTURE_FAILED', message: 'raw', captureCode: 'RESTRICTED' }).title,
    ).toBe('Chrome doesn’t allow capturing this page');
    expect(errorContent({ code: 'NO_SESSION', message: '' }).title).toBe(
      'This capture isn’t here anymore',
    );
    expect(errorContent({ code: 'CAPTURE_FAILED', message: 'Odd failure' }).body).toBe(
      'Odd failure',
    );
  });
});

describe('viewPhase', () => {
  it('trusts the engine, then the session record', () => {
    expect(viewPhase(true, { phase: 'ready' }, undefined)).toEqual({ kind: 'ready' });
    expect(viewPhase(true, { phase: 'loading' }, undefined)).toEqual({ kind: 'loading' });
    expect(viewPhase(true, { phase: 'loading' }, null).kind).toBe('error');
    expect(viewPhase(false, { phase: 'idle' }, undefined)).toMatchObject({
      kind: 'error',
      code: 'NO_SESSION',
    });
    expect(
      viewPhase(
        true,
        { phase: 'loading' },
        meta({ status: 'capturing', progress: { done: 2, total: 5 } }),
      ),
    ).toEqual({ kind: 'waiting', progress: { done: 2, total: 5 } });
    expect(
      viewPhase(
        true,
        { phase: 'loading' },
        meta({ status: 'error', error: { code: 'RESTRICTED', message: 'm' } }),
      ),
    ).toMatchObject({ kind: 'error', code: 'CAPTURE_FAILED', captureCode: 'RESTRICTED' });
    expect(
      viewPhase(true, { phase: 'error', code: 'LOAD_FAILED', message: 'x' }, meta({})),
    ).toMatchObject({ kind: 'error', code: 'LOAD_FAILED' });
  });
});
