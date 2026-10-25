/**
 * Download filename: `<site>-<title>-<date>.png`, e.g.
 * `github.com-pull-requests-2026-10-25-1422.png`. Pure.
 */

const MAX_TITLE = 60;

/** Lower-case, ASCII-folded, dash-separated slug of letters and digits. */
export function slugify(text: string, max = MAX_TITLE): string {
  const slug = text
    .normalize('NFKD')
    // Strip Latin combining diacritics only; other scripts keep their marks (dakuten, vowel signs).
    .replace(/\p{Script=Inherited}/gu, (m) => (/[̀-ͯ]/u.test(m) ? '' : m))
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  // Cut at a word boundary when one is reasonably close.
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return (dash > max * 0.6 ? cut.slice(0, dash) : cut).replace(/-+$/g, '');
}

/** Host without `www.`, or `''` for URLs without one (file:, data:, about:). */
export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.replace(/[^a-z0-9.-]+/gi, '-').replace(/^[-.]+|[-.]+$/g, '');
  } catch {
    return '';
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD-HHMM`. */
export function dateStamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function exportFilename(opts: { url: string; title: string; capturedAt: number }): string {
  const site = siteOf(opts.url);
  let title = slugify(opts.title);
  // Titles often repeat the site name ("GitHub - foo"); drop it when it leads.
  const siteWord = site.split('.').slice(-2, -1)[0] ?? '';
  if (siteWord && title.startsWith(`${siteWord}-`)) title = title.slice(siteWord.length + 1);
  const parts = [site || 'page', title, dateStamp(opts.capturedAt)].filter(Boolean);
  return `${parts.join('-')}.png`;
}
