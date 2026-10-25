import { describe, expect, it } from 'vitest';
import type { CopyStatus, DownloadStatus } from '@/editor/engine';
import {
  captureNotice,
  copyToast,
  downloadToast,
  errorContent,
  innerScrollerNote,
} from '@/editor/ui/messages';
import type { SessionMeta } from '@/editor/ui/useSessionMeta';
import { viewPhase } from '@/editor/ui/viewPhase';

const at = 1;
const size = { w: 1280, h: 2400 };

const page = (h: number) => ({ w: 1280, h });

describe('copyToast', () => {
  it('names the full page and its size', () => {
    const t = copyToast(
      { state: 'copied', request: 'default', outcome: 'full', size, tall: false, at },
      page(2400),
    );
    expect(t).toMatchObject({ tone: 'ok', title: 'Copied full page', size: '1280 × 2400' });
    expect(t?.note).toBeUndefined();
  });

  it('warns when a full copy is tall', () => {
    const t = copyToast(
      { state: 'copied', request: 'full', outcome: 'full', size, tall: true, at },
      page(9000),
    );
    expect(t?.note).toMatch(/scale it down/);
  });

  const scoped = (kind: string, extra: object = {}) =>
    ({
      state: 'copied',
      request: 'default',
      outcome: kind === 'fromHere' ? 'viewport' : 'smart',
      size: { w: 1440, h: 2576 },
      tall: false,
      at,
      scope: {
        kind,
        mode: 'fill',
        region: { x: 0, y: 0, w: 1440, h: 2576 },
        cssTop: 0,
        cssBottom: 2576,
        cssHeight: 2576,
        pageCssHeight: 4348,
        ...extra,
      },
    }) as unknown as CopyStatus;
  const lms = { w: 1440, h: 4348 };

  it('from the top: says where it stops and what ⇧⌘C adds', () => {
    const t = copyToast(scoped('fromTop'), lms);
    expect(t).toMatchObject({ title: 'Copied the top of the page', size: '1440 × 2576' });
    expect(t?.note).toMatch(
      /^From the top of the page down to 2,576 px\. .*C copies all 4,348 px\.$/,
    );
  });

  it('around the marks: says how much of the page', () => {
    const t = copyToast(scoped('aroundMarks', { cssTop: 900, cssBottom: 3476 }), lms);
    expect(t?.title).toBe('Copied around your marks');
    expect(t?.note).toMatch(/^2,576 of 4,348 px\. .*C copies the whole page\.$/);
  });

  it('no marks: from here down', () => {
    const t = copyToast(scoped('fromHere', { cssTop: 1200, cssBottom: 3776 }), lms);
    expect(t?.title).toBe('Copied from here down');
    expect(t?.note).toBe('2,576 of 4,348 px. Mark something to copy around it.');
  });

  it('marks taller than the budget', () => {
    const t = copyToast({ ...scoped('aroundMarks'), tall: true } as CopyStatus, lms);
    expect(t?.note).toMatch(/span a tall area/);
  });

  it('reads v0.1 outcomes without a scope, deriving CSS heights from the PNG width', () => {
    const smart = copyToast(
      {
        state: 'copied',
        request: 'default',
        outcome: 'smart',
        size: { w: 1280, h: 1184 },
        tall: false,
        at,
      },
      page(12400),
    );
    expect(smart?.title).toBe('Copied around your marks');
    expect(smart?.note).toMatch(/^1,184 of 12,400 px\./);
    const view = copyToast(
      {
        state: 'copied',
        request: 'default',
        outcome: 'viewport',
        size: { w: 2560, h: 1600 },
        tall: false,
        at,
      },
      page(12400),
    );
    expect(view?.title).toBe('Copied from here down');
    expect(view?.note).toMatch(/^800 of 12,400 px\./);
  });

  it('asks for focus when the page lost it', () => {
    const t = copyToast(
      { state: 'failed', request: 'default', reason: 'not-focused', message: '', at },
      null,
    );
    expect(t?.tone).toBe('warn');
    expect(t?.title).toMatch(/^Click the page, then .*C again$/);
  });

  it('early ⌘C says it is still loading; timeouts and raw errors read as sentences', () => {
    const fail = (reason: string, message: string) =>
      copyToast(
        { state: 'failed', request: 'default', reason, message, at } as unknown as CopyStatus,
        null,
      );
    expect(fail('loading', 'Still loading')?.title).toBe('Still loading the capture…');
    expect(fail('error', 'Nothing to copy yet.')?.title).toBe('Still loading the capture…');
    expect(fail('timeout', 'TIMEOUT')).toMatchObject({
      tone: 'warn',
      title: 'Copying took too long',
    });
    const raw = fail('error', 'DataCloneError');
    expect(raw?.title).toBe('Couldn’t copy the image');
    expect(raw?.note).not.toContain('DataCloneError');
  });

  it('is silent when idle and busy while copying', () => {
    expect(copyToast({ state: 'idle' }, page(100))).toBeNull();
    expect(copyToast({ state: 'copying', request: 'default' }, page(100))?.tone).toBe('busy');
  });
});

describe('downloadToast', () => {
  it('names the saved file', () => {
    expect(
      downloadToast({ state: 'saved', filename: 'a.png', size: { w: 10, h: 20 }, at }),
    ).toMatchObject({ title: 'Saved a.png', size: '10 × 20' });
  });

  it('explains a timeout without a raw code', () => {
    const t = downloadToast({
      state: 'failed',
      message: 'TIMEOUT',
      reason: 'timeout',
      at,
    } as DownloadStatus);
    expect(t?.title).toBe('Saving took too long');
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
  updatedAt: 0,
  ...over,
});

describe('captureNotice', () => {
  it('prefers partial over other warnings and uses the engine message', () => {
    const n = captureNotice(
      meta({
        status: 'partial',
        error: { code: 'TAB_CHANGED', message: 'You switched tabs, so the capture stopped early.' },
        warnings: [{ code: 'TRUNCATED', message: 'Cut at the limit.' }],
      }),
    );
    expect(n).toMatchObject({ tone: 'warn', code: 'PARTIAL', lead: 'Partial capture.' });
    expect(n?.text).toBe(
      'You switched tabs, so the capture stopped early. The image stops at 4,200 px.',
    );
    expect(n?.all).toEqual([
      'Partial capture. You switched tabs, so the capture stopped early. The image stops at 4,200 px.',
      'Cut at the limit.',
    ]);
  });

  it('shows visible-only, truncated and height-changed messages as written', () => {
    const vis =
      'Chrome doesn’t let extensions scroll its own pages, so only the visible area was captured.';
    expect(
      captureNotice(meta({ mode: 'visible', warnings: [{ code: 'VISIBLE_ONLY', message: vis }] })),
    ).toMatchObject({ tone: 'warn', code: 'VISIBLE_ONLY', text: vis });
    expect(captureNotice(meta({ mode: 'visible' }))?.text).toBe(
      'Only the visible area was captured.',
    );
    expect(
      captureNotice(meta({ warnings: [{ code: 'TRUNCATED', message: 'Stopped at the limit.' }] })),
    ).toMatchObject({ tone: 'warn', text: 'Stopped at the limit.' });
    const moved = 'The page changed while it was captured (content loaded or moved).';
    expect(
      captureNotice(
        meta({
          warnings: [
            { code: 'INNER_SCROLLER', message: 'panel' },
            { code: 'HEIGHT_CHANGED', message: moved },
          ],
        }),
      ),
    ).toMatchObject({ tone: 'warn', code: 'HEIGHT_CHANGED', text: moved, all: [moved] });
  });

  it('keeps an expanded inner scroller out of the strip, in the title tooltip', () => {
    const m = meta({ warnings: [{ code: 'INNER_SCROLLER', message: 'Expanded in place.' }] });
    expect(captureNotice(m)).toBeNull();
    expect(innerScrollerNote(m)).toBe('Captured the scrolling panel as one page.');
    expect(innerScrollerNote(meta({}))).toBeNull();
  });

  it('shows a page that would not scroll', () => {
    const msg = 'A dialog stopped the page from scrolling, so one screen was captured.';
    expect(
      captureNotice(meta({ warnings: [{ code: 'NOT_SCROLLABLE', message: msg }] })),
    ).toMatchObject({ tone: 'warn', code: 'NOT_SCROLLABLE', text: msg });
  });

  it('says nothing for a clean capture', () => {
    expect(captureNotice(meta({}))).toBeNull();
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
    expect(errorContent({ code: 'CAPTURE_FAILED', message: 'Odd failure.' }).body).toBe(
      'Odd failure.',
    );
    expect(errorContent({ code: 'LOAD_FAILED', message: 'x' }).retry).toBe('reload');
    expect(
      errorContent({ code: 'CAPTURE_FAILED', message: '', captureCode: 'INTERRUPTED' }).title,
    ).toBe('The capture stopped responding');
    const esc = 'You pressed Esc, so the capture stopped early.';
    expect(
      errorContent({ code: 'CAPTURE_FAILED', message: esc, captureCode: 'ABORTED_BY_USER' }).body,
    ).toBe(esc);
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
