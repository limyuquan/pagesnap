/**
 * Every user-facing sentence the editor shows about copy, download, capture problems and errors.
 * Pure functions (no React, no `browser`), so they're unit-tested in tests/unit/ui.messages.test.ts.
 *
 * Voice: plain, specific, short. Say what happened and what to do next. No exclamation marks.
 */
import type { CopyStatus, DownloadStatus } from '@/editor/engine';
import type { CaptureErrorCode, CaptureSession } from '@/shared/types';
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
  /** Short bold lead-in. */
  lead: string;
  text: string;
}

const PARTIAL_REASONS: Partial<Record<CaptureErrorCode, string>> = {
  TAB_CHANGED: 'The tab changed mid-capture.',
  ABORTED_BY_USER: 'You pressed Esc mid-capture.',
  SCROLL_JACKED: 'The page stopped scrolling the way Page Snap expected.',
  PINCH_ZOOM: 'The page was pinch-zoomed.',
  SCALE_CHANGED: 'The window moved to a display with a different scale.',
  CAPTURE_FAILED: 'Chrome stopped returning screenshots.',
  INTERRUPTED: 'Chrome interrupted the capture.',
};

type NoticeSession = Pick<CaptureSession, 'status' | 'error' | 'warnings' | 'css' | 'mode'>;

/** The one notice worth showing for a session, or `null`. Partial beats visible-only beats cut-off. */
export function captureNotice(session: NoticeSession | null): NoticeContent | null {
  if (!session) return null;
  const has = (code: string) => session.warnings.some((w) => w.code === code);
  if (session.status === 'partial') {
    const reason =
      (session.error && PARTIAL_REASONS[session.error.code]) ??
      session.error?.message ??
      'The capture stopped early.';
    return {
      lead: 'Partial capture.',
      text: `${reason} The image stops at ${px(session.css.h)}.`,
    };
  }
  if (has('VISIBLE_ONLY') || session.mode === 'visible') {
    return {
      lead: 'Visible area only.',
      text: 'Chrome doesn’t let extensions scroll this page.',
    };
  }
  if (has('TRUNCATED')) {
    return {
      lead: 'Cut off.',
      text: `Very long pages stop at ${px(session.css.h)} so the image stays workable.`,
    };
  }
  if (has('IMAGES_PENDING')) {
    return {
      lead: 'Some images were still loading.',
      text: 'Scroll through the page once, then capture again if any are blank.',
    };
  }
  return null;
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
