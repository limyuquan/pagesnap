/**
 * What the stage shows when there's no image to draw on yet (capturing, opening) or ever (error),
 * plus the quiet notice strip for partial and visible-only captures.
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CloseIcon, NoticeIcon } from './icons';
import { prettyCommandShortcut } from './keys';
import { captureNotice, errorContent } from './messages';
import type { SessionMeta } from './useSessionMeta';
import type { ViewPhase } from './viewPhase';

// ---------------------------------------------------------------- loading

export function LoadingState({
  phase,
  stalled = false,
}: {
  phase: Extract<ViewPhase, { kind: 'waiting' | 'loading' }>;
  /** The capture stopped sending updates (see stuck.ts). */
  stalled?: boolean;
}) {
  const waiting = phase.kind === 'waiting';
  const { done, total } = waiting ? phase.progress : { done: 0, total: 0 };
  const determinate = waiting && total > 0;
  const p = determinate ? Math.min(1, done / total) : 0;
  const shortcut = useCaptureShortcut();
  if (waiting && stalled) {
    return (
      <div className="ps-center" data-testid="state-loading" data-phase="stalled">
        <div className="ps-loading" role="status" aria-live="polite">
          <b>The capture stopped responding</b>
          <span className="tnum">
            {determinate ? `Stuck at ${done} of ${total}` : 'No progress'}
          </span>
          <div className="ps-progress" data-stalled="" style={{ '--p': p } as React.CSSProperties}>
            <i />
          </div>
          <p className="ps-loading-hint">
            Page Snap will save what it has in a moment. To start over, go back to the page and{' '}
            <RetryHow shortcut={shortcut} />
          </p>
        </div>
      </div>
    );
  }
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

/** "press ⌥⇧P." or "click Page Snap in the toolbar." */
function RetryHow({ shortcut }: { shortcut: string }) {
  return shortcut ? (
    <>
      press <kbd>{prettyCommandShortcut(shortcut)}</kbd>.
    </>
  ) : (
    <>click Page Snap in the toolbar.</>
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
  const canReopen = c.retry === 'capture' && !!meta && /^https?:/.test(meta.url);
  return (
    <div className="ps-center" data-testid="state-error" data-code={c.code}>
      <section className="ps-error" role="alert" aria-labelledby="ps-error-title">
        <h1 id="ps-error-title">{c.title}</h1>
        <p>{c.body}</p>
        {c.retry === 'reload' ? (
          <p className="ps-error-hint">The capture itself is still saved on this device.</p>
        ) : (
          <p className="ps-error-hint">
            To try again, go back to the page and <RetryHow shortcut={shortcut} />
          </p>
        )}
        {c.retry === 'reload' && (
          <button
            type="button"
            className="ps-error-action"
            onClick={() => window.location.reload()}
          >
            Reload this tab
          </button>
        )}
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

/**
 * The quiet strip under the top bar, for warnings only (partial, visible-only, cut off, page
 * changed, couldn't scroll). Informational facts (a scrolling panel captured as the page) go in
 * the page title's tooltip, not here: they'd sit over every first capture of a Canvas page.
 */
export function CaptureNotice({ meta }: { meta: SessionMeta | null | undefined }) {
  const [dismissed, setDismissed] = useState(false);
  const notice = meta && meta.status !== 'capturing' ? captureNotice(meta) : null;
  if (!notice || dismissed) return <div />;
  return (
    <div
      className="ps-notice"
      role="note"
      data-testid="capture-notice"
      data-tone={notice.tone}
      data-code={notice.code}
      title={notice.all.join('\n')}
    >
      <NoticeIcon className="ps-notice-icon" />
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
