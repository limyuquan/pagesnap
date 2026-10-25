/**
 * What the stage shows when there's no image to draw on yet (capturing, opening) or ever (error),
 * plus the quiet notice strip for partial and visible-only captures.
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CloseIcon, InfoIcon, NoticeIcon } from './icons';
import { prettyCommandShortcut } from './keys';
import { captureNotice, errorContent } from './messages';
import type { SessionMeta } from './useSessionMeta';
import type { ViewPhase } from './viewPhase';

// ---------------------------------------------------------------- loading

export function LoadingState({
  phase,
}: {
  phase: Extract<ViewPhase, { kind: 'waiting' | 'loading' }>;
}) {
  const waiting = phase.kind === 'waiting';
  const { done, total } = waiting ? phase.progress : { done: 0, total: 0 };
  const determinate = waiting && total > 0;
  const p = determinate ? Math.min(1, done / total) : 0;
  return (
    <div className="ps-center" data-testid="state-loading" data-phase={phase.kind}>
      <div className="ps-loading" role="status" aria-live="polite">
        <b>{waiting ? 'Capturing the page' : 'Opening capture'}</b>
        <span className="tnum">{determinate ? `${done} of ${total}` : 'Just a moment'}</span>
        <div
          className="ps-progress"
          role="progressbar"
          aria-label={waiting ? 'Capture progress' : 'Opening capture'}
          aria-valuemin={determinate ? 0 : undefined}
          aria-valuemax={determinate ? total : undefined}
          aria-valuenow={determinate ? done : undefined}
          data-indeterminate={!determinate || undefined}
          style={{ '--p': p } as React.CSSProperties}
        >
          <i />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- error

function useCaptureShortcut(): string {
  const [shortcut, setShortcut] = useState('Alt+Shift+P');
  useEffect(() => {
    let alive = true;
    browser.commands
      ?.getAll()
      .then((cmds) => {
        const s = cmds.find((c) => c.name === '_execute_action')?.shortcut;
        if (alive && s !== undefined) setShortcut(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return shortcut;
}

export function ErrorState({
  phase,
  meta,
}: {
  phase: Extract<ViewPhase, { kind: 'error' }>;
  meta: SessionMeta | null | undefined;
}) {
  const c = errorContent(phase);
  const shortcut = useCaptureShortcut();
  const canReopen = !!meta && /^https?:/.test(meta.url);
  return (
    <div className="ps-center" data-testid="state-error" data-code={c.code}>
      <section className="ps-error" role="alert" aria-labelledby="ps-error-title">
        <h1 id="ps-error-title">{c.title}</h1>
        <p>{c.body}</p>
        <p className="ps-error-hint">
          To try again, go back to the page and{' '}
          {shortcut ? (
            <>
              press <kbd>{prettyCommandShortcut(shortcut)}</kbd>.
            </>
          ) : (
            'click Page Snap in the toolbar.'
          )}
        </p>
        {canReopen && meta && (
          <a className="ps-error-action" href={meta.url} target="_blank" rel="noreferrer">
            Open the page
          </a>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- notice

const SEEN_INFO_KEY = 'pagesnap:seen-info';

function readSeenInfo(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_INFO_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function markInfoSeen(code: string): void {
  try {
    const seen = readSeenInfo();
    if (seen.has(code)) return;
    seen.add(code);
    localStorage.setItem(SEEN_INFO_KEY, JSON.stringify([...seen]));
  } catch {
    // Storage unavailable: the info line just shows again next time.
  }
}

/**
 * The quiet strip under the top bar. Warnings (partial, visible-only, cut off, page changed) use
 * the warning icon and show on every capture that has them. Informational lines (a scrolling
 * panel was expanded in place) use a neutral icon and show once per profile: the capture is
 * fine, the user only needs to hear how it works the first time.
 */
export function CaptureNotice({ meta }: { meta: SessionMeta | null | undefined }) {
  const [dismissed, setDismissed] = useState(false);
  // Read once per editor, so marking an info line as seen doesn't hide it right away.
  const [seenInfo] = useState(readSeenInfo);
  const notice = meta && meta.status !== 'capturing' ? captureNotice(meta, seenInfo) : null;
  const infoCode = notice?.tone === 'info' ? notice.code : null;
  useEffect(() => {
    if (infoCode) markInfoSeen(infoCode);
  }, [infoCode]);
  if (!notice || dismissed) return <div />;
  const Icon = notice.tone === 'info' ? InfoIcon : NoticeIcon;
  return (
    <div
      className="ps-notice"
      role="note"
      data-testid="capture-notice"
      data-tone={notice.tone}
      data-code={notice.code}
      title={notice.all.join('\n')}
    >
      <Icon className="ps-notice-icon" />
      <p className="ps-notice-text m-0">
        {notice.lead && <strong>{notice.lead} </strong>}
        {notice.text}
      </p>
      <button
        type="button"
        className="ps-btn"
        aria-label="Dismiss notice"
        data-tip="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
