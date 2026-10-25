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

export type Tone = 'ok' | 'busy' | 'warn' | 'info';

export interface ToastContent {
  tone: Tone;
  title: string;
  /** Pixel size, shown dimmed after the title. */
  size?: string;
  /** One quiet line under the title: why, and what to press instead. */
  note?: string;
}

/**
 * What a default copy contained, from the user's point of view (design review §4/§5):
 * - `full`: the whole page;
 * - `fromTop`: the page from its top down to the AI size budget, marks included;
 * - `aroundMarks`: a window of the page around the marks;
 * - `fromHere`: no marks, so the page from the current view down.
 */
export type ScopeKind = 'full' | 'fromTop' | 'aroundMarks' | 'fromHere';

const SCOPE_KINDS: ReadonlySet<string> = new Set(['full', 'fromTop', 'aroundMarks', 'fromHere']);

/**
 * The scope kind of a `copied` status. Reads the engine's `scope.kind` (or `kind`) when present
 * and falls back to the v0.1 `outcome` names (`smart` → around the marks, or from the top when
 * the region starts at 0; `viewport` → from here down).
 */
export function scopeKind(copy: Extract<CopyStatus, { state: 'copied' }>): ScopeKind {
  const c = copy as unknown as {
    outcome?: string;
    kind?: string;
    scope?: string | { kind?: string };
    region?: { y?: number };
  };
  const raw =
    (typeof c.scope === 'string' ? c.scope : c.scope?.kind) ?? c.kind ?? c.outcome ?? 'full';
  if (SCOPE_KINDS.has(raw)) return raw as ScopeKind;
  if (raw === 'viewport') return 'fromHere';
  if (raw === 'smart') return c.region?.y === 0 ? 'fromTop' : 'aroundMarks';
  return 'full';
}

interface ScopeInfoLike {
  kind?: string;
  cssTop?: number;
  cssBottom?: number;
  cssHeight?: number;
  pageCssHeight?: number;
}

/** The engine's `copied.scope` (CONTRACTS §8, F2), when present. */
function scopeInfo(copy: Extract<CopyStatus, { state: 'copied' }>): ScopeInfoLike | null {
  const sc = (copy as unknown as { scope?: unknown }).scope;
  return sc && typeof sc === 'object' ? (sc as ScopeInfoLike) : null;
}

/** Page size in CSS px (`session.css`). */
export type PageCss = { w: number; h: number } | null;

/** Message codes and phrases that mean "the export didn't finish in time". */
const TIMEOUT_RE = /time ?out|timed out|took too long/i;
/** "The capture isn't on screen yet" (early ⌘C). */
const LOADING_RE = /nothing to copy yet|still loading|not ready/i;

/** Keep engine messages that read as a sentence; hide raw codes and stack-ish strings. */
function humanMessage(message: string | undefined): string {
  const m = message?.trim() ?? '';
  return /^[A-Z][^_{}<>]*[.!?]$/.test(m) && m.includes(' ') && m.length <= 140 ? m : '';
}

export function copyToast(copy: CopyStatus, page: PageCss): ToastContent | null {
  const fullKey = combo('mod+shift+c');
  const pageH = page?.h ?? null;
  switch (copy.state) {
    case 'idle':
      return null;
    case 'copying': {
      const c = copy as unknown as { waiting?: boolean; loading?: boolean; phase?: string };
      if (c.waiting || c.loading || c.phase === 'loading')
        return { tone: 'busy', title: 'Still loading the capture…' };
      return { tone: 'busy', title: copy.request === 'full' ? 'Copying full page' : 'Copying' };
    }
    case 'copied': {
      const size = dims(copy.size);
      const kind = scopeKind(copy);
      if (kind === 'full') {
        return {
          tone: 'ok',
          title: 'Copied full page',
          size,
          ...(copy.tall && {
            note: 'It’s a tall image, so AI chats will scale it down and small text may blur.',
          }),
        };
      }
      // CSS px figures: the engine's (`scope`, after edge snapping) when it reports them, else
      // derived from the PNG size (copies are always full width, so scale by width).
      const sc = scopeInfo(copy);
      const derivedH = page && copy.size.w > 0 ? (copy.size.h * page.w) / copy.size.w : copy.size.h;
      const cssH = sc?.cssHeight ?? derivedH;
      const bottom = sc?.cssBottom ?? cssH;
      const pageTotal = sc?.pageCssHeight ?? pageH;
      const of =
        pageTotal != null ? `${nf.format(Math.round(cssH))} of ${px(pageTotal)}` : px(cssH);
      if (kind === 'fromHere') {
        return {
          tone: 'ok',
          title: 'Copied from here down',
          size,
          note: `${of}. Mark something to copy around it.`,
        };
      }
      if (copy.tall) {
        return {
          tone: 'ok',
          title: 'Copied around your marks',
          size,
          note: `Your marks span a tall area, so AI chats will scale it down. ${fullKey} copies the whole page.`,
        };
      }
      if (kind === 'fromTop') {
        return {
          tone: 'ok',
          title: 'Copied the top of the page',
          size,
          note: `From the top of the page down to ${px(bottom)}. ${fullKey} copies all ${pageTotal != null ? px(pageTotal) : 'of it'}.`,
        };
      }
      return {
        tone: 'ok',
        title: 'Copied around your marks',
        size,
        note: `${of}. ${fullKey} copies the whole page.`,
      };
    }
    case 'failed': {
      const reason = copy.reason as string;
      if (reason === 'not-focused') {
        return {
          tone: 'warn',
          title: `Click the page, then ${combo('mod+c')} again`,
          note: 'Chrome only lets the focused tab use the clipboard.',
        };
      }
      if (reason === 'loading' || LOADING_RE.test(copy.message)) {
        return {
          tone: 'info',
          title: 'Still loading the capture…',
          note: `Press ${combo('mod+c')} again in a moment.`,
        };
      }
      if (reason === 'timeout' || TIMEOUT_RE.test(copy.message)) {
        return {
          tone: 'warn',
          title: 'Copying took too long',
          note: `Try again, or download the image with ${combo('mod+s')}.`,
        };
      }
      const why = humanMessage(copy.message);
      return {
        tone: 'warn',
        title: 'Couldn’t copy the image',
        note: `${why ? `${why} ` : ''}Download it instead with ${combo('mod+s')}.`,
      };
    }
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
    case 'failed': {
      const reason = (download as { reason?: string }).reason;
      if (reason === 'timeout' || TIMEOUT_RE.test(download.message)) {
        return {
          tone: 'warn',
          title: 'Saving took too long',
          note: 'The image may be very large. Try again in a moment.',
        };
      }
      const why = humanMessage(download.message);
      return {
        tone: 'warn',
        title: 'Couldn’t save the image',
        note: why || 'Something went wrong while making the PNG. Try again in a moment.',
      };
    }
  }
}

// ---------------------------------------------------------------- capture notices

export interface NoticeContent {
  /** The image may be missing or misplacing something (partial, visible-only, cut off, page changed). */
  tone: 'warn';
  /** Which warning (or `PARTIAL`) this is. */
  code: CaptureWarningCode | 'PARTIAL' | 'VISIBLE';
  /** Short bold lead-in, when the text alone doesn't say what kind of notice it is. */
  lead?: string;
  /** The capture engine's own sentence (`warning.message` / `error.message`), as written. */
  text: string;
  /** Every notice for the session, most important first (the strip shows the first; the rest go in its tooltip). */
  all: string[];
}

/**
 * Warnings in the order they matter to the user. `INNER_SCROLLER` is not here: a scrolling panel
 * expanded in place is how the capture works on Canvas-style pages, not a problem, so it lives in
 * the page title's tooltip (`innerScrollerNote`) instead of a strip over the first capture.
 */
const WARNING_ORDER: CaptureWarningCode[] = [
  'VISIBLE_ONLY',
  'TRUNCATED',
  'NOT_SCROLLABLE',
  'HEIGHT_CHANGED',
  'IMAGES_PENDING',
];

/** Fallback sentences, only for records without a message. */
const FALLBACK: Partial<Record<CaptureWarningCode, string>> = {
  VISIBLE_ONLY: 'Only the visible area was captured.',
  TRUNCATED: 'The page is very long, so the capture stops at the length limit.',
  HEIGHT_CHANGED: 'The page changed while it was captured, so a few parts may be misaligned.',
  IMAGES_PENDING: 'Some images were still loading when they were captured.',
  NOT_SCROLLABLE: 'The page wouldn’t scroll, so one screen was captured.',
};

type NoticeSession = Pick<CaptureSession, 'status' | 'error' | 'warnings' | 'css' | 'mode'>;

/** The notice worth showing for a session, or `null`. A partial capture beats every warning. */
export function captureNotice(session: NoticeSession | null): NoticeContent | null {
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
    items.push({ tone: 'warn', code, text: w.message?.trim() || FALLBACK[code] || '' });
  }
  if (session.mode === 'visible' && !items.some((i) => i.code === 'VISIBLE_ONLY')) {
    items.push({ tone: 'warn', code: 'VISIBLE', text: FALLBACK.VISIBLE_ONLY ?? '' });
  }
  const first = items[0];
  if (!first) return null;
  return {
    ...first,
    all: items.map((i) => (i.lead ? `${i.lead} ${i.text}` : i.text)),
  };
}

/** Line for the page title's tooltip when a scrolling panel was captured as the page. */
export function innerScrollerNote(session: Pick<CaptureSession, 'warnings'> | null | undefined) {
  return session?.warnings.some((w) => w.code === 'INNER_SCROLLER')
    ? 'Captured the scrolling panel as one page.'
    : null;
}

// ---------------------------------------------------------------- errors

export interface ErrorContent {
  title: string;
  body: string;
  /** Technical code, shown small for bug reports. */
  code: string;
  /** How to try again: capture the page again, or reload this tab (the capture itself is fine). */
  retry: 'capture' | 'reload';
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
      retry: 'capture',
    };
  }
  if (code === 'LOAD_FAILED') {
    return {
      title: 'This capture couldn’t be opened',
      body: humanMessage(message) || 'Something went wrong reading it from storage.',
      code,
      retry: 'reload',
    };
  }
  switch (captureCode) {
    case 'RESTRICTED':
      return {
        title: 'Chrome doesn’t allow capturing this page',
        body: 'Extensions can’t read pages like the Chrome Web Store, chrome:// settings or the built-in PDF viewer.',
        code: captureCode,
        retry: 'capture',
      };
    case 'TAB_CHANGED':
      return {
        title: 'The capture stopped before it started',
        body: 'The tab was switched, closed or navigated while Page Snap was scrolling it. Keep the tab in front until the toolbar badge clears.',
        code: captureCode,
        retry: 'capture',
      };
    case 'ABORTED_BY_USER':
      return {
        title: 'Capture cancelled',
        body:
          humanMessage(message) ||
          'It was stopped with Esc or Stop before the first screenshot was taken.',
        code: captureCode,
        retry: 'capture',
      };
    case 'INTERRUPTED':
      return {
        title: 'The capture stopped responding',
        body: 'Chrome stopped Page Snap partway through, before any of the page was saved.',
        code: captureCode,
        retry: 'capture',
      };
    case 'STORAGE_FAILED':
      return {
        title: 'The capture couldn’t be saved',
        body:
          humanMessage(message) ||
          'Chrome couldn’t write it to disk. The disk may be full, or Page Snap’s storage may be.',
        code: captureCode,
        retry: 'capture',
      };
    case 'PINCH_ZOOM':
      return {
        title: 'The page is pinch-zoomed',
        body: 'Pinch back out to normal size, then capture again.',
        code: captureCode,
        retry: 'capture',
      };
    case 'SCROLL_JACKED':
      return {
        title: 'This page wouldn’t scroll',
        body: 'It takes over scrolling, so Page Snap couldn’t step through it.',
        code: captureCode,
        retry: 'capture',
      };
    default:
      return {
        title: 'The capture didn’t work',
        body: humanMessage(message) || 'Chrome didn’t return any screenshots.',
        code: captureCode ?? code,
        retry: 'capture',
      };
  }
}
