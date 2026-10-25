/**
 * Human-readable reasons for pages the agent can't script (owner: A). We never pre-filter by URL:
 * we try to inject and only use the URL to explain a failure (01 §3.10).
 */

export type RestrictedKind =
  | 'browser-page'
  | 'web-store'
  | 'pdf'
  | 'file-no-access'
  | 'extension-page'
  | 'data-url'
  | 'unknown';

export function classifyRestrictedUrl(url: string | undefined, fileAccess = true): RestrictedKind {
  if (!url) return 'unknown';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (['chrome', 'chrome-untrusted', 'devtools', 'edge', 'about', 'view-source'].includes(scheme)) {
    return 'browser-page';
  }
  if (scheme === 'chrome-extension' || scheme === 'moz-extension') return 'extension-page';
  if (scheme === 'data' || scheme === 'blob') return 'data-url';
  if (
    u.hostname === 'chromewebstore.google.com' ||
    (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))
  ) {
    return 'web-store';
  }
  if (scheme === 'file' && !fileAccess) return 'file-no-access';
  if (/\.pdf$/i.test(u.pathname)) return 'pdf';
  return 'unknown';
}

/** Fallback when the URL is hidden from us: Chrome's `executeScript` error text. */
export function classifyInjectError(message: string): RestrictedKind {
  if (/chrome(-untrusted)?:\/\/|devtools:\/\/|about:|view-source:/i.test(message))
    return 'browser-page';
  if (/extensions gallery|webstore/i.test(message)) return 'web-store';
  if (/chrome-extension:\/\//i.test(message)) return 'extension-page';
  if (/file:\/\//i.test(message)) return 'file-no-access';
  if (/data:/i.test(message)) return 'data-url';
  return 'unknown';
}

const NAMES: Record<RestrictedKind, string> = {
  'browser-page': 'Chrome doesn’t let extensions scroll its own pages',
  'web-store': 'The Chrome Web Store doesn’t let extensions scroll its pages',
  pdf: 'Chrome’s PDF viewer can’t be scrolled by extensions',
  'file-no-access': 'Page Snap isn’t allowed to read local files',
  'extension-page': 'Pages of other extensions can’t be scrolled',
  'data-url': 'This kind of page (data: URL) can’t be scrolled by extensions',
  unknown: 'This page can’t be scrolled by extensions',
};

/** Message for a successful visible-area fallback (`VISIBLE_ONLY` warning). */
export function visibleOnlyMessage(kind: RestrictedKind): string {
  return `${NAMES[kind]}, so only the visible area was captured.`;
}

/** Message when even the visible area couldn't be captured (`RESTRICTED` error). */
export function restrictedErrorMessage(kind: RestrictedKind): string {
  if (kind === 'file-no-access') {
    return 'Page Snap can’t capture local files yet. Turn on “Allow access to file URLs” for Page Snap in chrome://extensions, then try again.';
  }
  return `${NAMES[kind]}, and Chrome didn’t allow a screenshot of the visible area either.`;
}
