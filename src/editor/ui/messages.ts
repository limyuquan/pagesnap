/**
 * Every user-facing sentence the editor shows about copy, download, capture problems and errors.
 * Pure functions (no React, no `browser`), so they're unit-tested in tests/unit/ui.messages.test.ts.
 *
 * Voice: plain, specific, short. Say what happened and what to do next. No exclamation marks.
 */
import type { CopyStatus, DownloadStatus } from '@/editor/engine';
import type { CaptureErrorCode, CaptureSession, CaptureWarningCode } from '@/shared/types';
import { combo } from './keys';

const nf = new Intl.NumberFormat('en-US');
export const px = (n: number) => `${nf.format(Math.round(n))} px`;
export const dims = (s: { w: number; h: number }) => `${Math.round(s.w)} × ${Math.round(s.h)}`;

export type Tone = 'ok' | 'busy' | 'warn';

export interface ToastContent {
  tone: Tone;
  title: string;
  /** Pixel size, shown dimmed after the title. */
  size?: string;
  /** One quiet line under the title: why, and what to press instead. */
  note?: string;
}

/** `pageCssH` is the full page height in CSS px (`session.css.h`). */
export function copyToast(copy: CopyStatus, pageCssH: number | null): ToastContent | null {
  const all = `${combo('mod+shift+c')} copies all of it`;
  const tall = pageCssH != null ? `The page is ${px(pageCssH)} tall.` : 'The page is very tall.';
  switch (copy.state) {
    case 'idle':
      return null;
    case 'copying':
      return { tone: 'busy', title: copy.request === 'full' ? 'Copying full page' : 'Copying' };
    case 'copied': {
      const size = dims(copy.size);
      if (copy.outcome === 'full') {
        return {
          tone: 'ok',
          title: 'Copied full page',
          size,
          ...(copy.tall && {
            note: 'It’s a tall image, so AI chats will scale it down and small text may blur.',
          }),
        };
      }
      if (copy.outcome === 'smart') {
        return {
          tone: 'ok',
          title: 'Copied the area around your marks',
          size,
          note: copy.tall
            ? `Your marks span a tall area, so AI chats will scale it down. ${all}.`
            : `${tall} ${all}.`,
        };
      }
      return {
        tone: 'ok',
        title: 'Copied the current view',
        size,
        note: `${tall} Mark something to copy around it, or ${combo('mod+shift+c')} for all of it.`,
      };
    }
    case 'failed':
      if (copy.reason === 'not-focused') {
        return {
          tone: 'warn',
          title: `Click the page, then ${combo('mod+c')} again`,
          note: 'Chrome only lets the focused tab use the clipboard.',
        };
      }
      return {
        tone: 'warn',
        title: 'Couldn’t copy the image',
        note: `${copy.message ? `${copy.message} ` : ''}Download it instead with ${combo('mod+s')}.`,
      };
  }
}

export function downloadToast(download: DownloadStatus): ToastContent | null {
  switch (download.state) {
    case 'idle':
      return null;
    case 'saving':
      return { tone: 'busy', title: 'Saving PNG' };
    case 'saved':
      return { tone: 'ok', title: `Saved ${download.filename}`, size: dims(download.size) };
    case 'failed':
      return {
        tone: 'warn',
        title: 'Couldn’t save the image',
        ...(download.message ? { note: download.message } : {}),
      };
  }
}

// ---------------------------------------------------------------- capture notices

export interface NoticeContent {
  /**
   * `warn`: the image may be missing or misplacing something (partial, visible-only, cut off,
   * page changed). `info`: nothing is wrong, the capture just worked differently (a scrolling
   * panel expanded in place). Info notices are quieter and shown once per profile.
   */
  tone: 'warn' | 'info';
  /** Which warning (or `PARTIAL`) this is; the key for "seen" bookkeeping. */
  code: CaptureWarningCode | 'PARTIAL' | 'VISIBLE';
  /** Short bold lead-in, when the text alone doesn't say what kind of notice it is. */
  lead?: string;
  /** The capture engine's own sentence (`warning.message` / `error.message`), as written. */
  text: string;
  /** Every notice for the session, most important first (the strip shows the first; the rest go in its tooltip). */
  all: string[];
}

/** Warnings in the order they matter to the user. INNER_SCROLLER is informational only. */
const WARNING_ORDER: CaptureWarningCode[] = [
  'VISIBLE_ONLY',
  'TRUNCATED',
  'HEIGHT_CHANGED',
  'IMAGES_PENDING',
  'INNER_SCROLLER',
];
const INFO_CODES: ReadonlySet<CaptureWarningCode> = new Set(['INNER_SCROLLER']);

/** Fallback sentences, only for records without a message. */
const FALLBACK: Record<CaptureWarningCode, string> = {
  VISIBLE_ONLY: 'Only the visible area was captured.',
  TRUNCATED: 'The page is very long, so the capture stops at the length limit.',
  HEIGHT_CHANGED: 'The page changed while it was captured, so a few parts may be misaligned.',
  IMAGES_PENDING: 'Some images were still loading when they were captured.',
  INNER_SCROLLER: 'The page scrolls inside a panel, so that panel was expanded in place.',
};

type NoticeSession = Pick<CaptureSession, 'status' | 'error' | 'warnings' | 'css' | 'mode'>;

/**
 * The notice worth showing for a session, or `null`. A partial capture beats every warning;
 * warnings follow `WARNING_ORDER`. `seenInfo` lists info codes the user has already been told
 * about: those are left out, so an informational line appears once, not on every capture.
 */
export function captureNotice(
  session: NoticeSession | null,
  seenInfo: ReadonlySet<string> = new Set(),
): NoticeContent | null {
  if (!session) return null;
  const items: Omit<NoticeContent, 'all'>[] = [];
  if (session.status === 'partial') {
    const reason = session.error?.message?.trim() || 'The capture stopped early.';
    items.push({
      tone: 'warn',
      code: 'PARTIAL',
      lead: 'Partial capture.',
      text: `${reason} The image stops at ${px(session.css.h)}.`,
    });
  }
  for (const code of WARNING_ORDER) {
    const w = session.warnings.find((x) => x.code === code);
    if (!w) continue;
    if (INFO_CODES.has(code) && seenInfo.has(code)) continue;
    items.push({
      tone: INFO_CODES.has(code) ? 'info' : 'warn',
      code,
      text: w.message?.trim() || FALLBACK[code],
    });
  }
  if (session.mode === 'visible' && !items.some((i) => i.code === 'VISIBLE_ONLY')) {
    items.push({ tone: 'warn', code: 'VISIBLE', text: FALLBACK.VISIBLE_ONLY });
  }
  const first = items[0];
  if (!first) return null;
  return {
    ...first,
    all: items.map((i) => (i.lead ? `${i.lead} ${i.text}` : i.text)),
  };
}

// ---------------------------------------------------------------- errors

export interface ErrorContent {
  title: string;
  body: string;
  /** Technical code, shown small for bug reports. */
  code: string;
}

export function errorContent(input: {
  code: 'NO_SESSION' | 'CAPTURE_FAILED' | 'LOAD_FAILED';
  message: string;
  captureCode?: CaptureErrorCode | null;
}): ErrorContent {
  const { code, message, captureCode } = input;
  if (code === 'NO_SESSION') {
    return {
      title: 'This capture isn’t here anymore',
      body: 'Captures stay on this device for a while and are then cleared. This one is gone, or it never finished.',
      code,
    };
  }
  if (code === 'LOAD_FAILED') {
    return {
      title: 'This capture couldn’t be opened',
      body: message || 'Something went wrong reading it from storage.',
      code,
    };
  }
  switch (captureCode) {
    case 'RESTRICTED':
      return {
        title: 'Chrome doesn’t allow capturing this page',
        body: 'Extensions can’t read pages like the Chrome Web Store, chrome:// settings or the built-in PDF viewer.',
        code: captureCode,
      };
    case 'TAB_CHANGED':
      return {
        title: 'The capture stopped before it started',
        body: 'The tab was switched, closed or navigated while Page Snap was scrolling it. Keep the tab in front until the toolbar badge clears.',
        code: captureCode,
      };
    case 'ABORTED_BY_USER':
      return {
        title: 'Capture cancelled',
        body: 'You pressed Esc before the first screenshot was taken.',
        code: captureCode,
      };
    case 'PINCH_ZOOM':
      return {
        title: 'The page is pinch-zoomed',
        body: 'Pinch back out to normal size, then capture again.',
        code: captureCode,
      };
    case 'SCROLL_JACKED':
      return {
        title: 'This page wouldn’t scroll',
        body: 'It takes over scrolling, so Page Snap couldn’t step through it.',
        code: captureCode,
      };
    default:
      return {
        title: 'The capture didn’t work',
        body: message || 'Chrome didn’t return any screenshots.',
        code: captureCode ?? code,
      };
  }
}
