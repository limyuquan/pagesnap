import { describe, expect, it } from 'vitest';
import { dateStamp, exportFilename, siteOf, slugify } from '@/editor/engine/filename';

// Local time, so the stamp is the same in every timezone.
const AT = new Date(2026, 9, 25, 14, 22).getTime();
const STAMP = '2026-10-25-1422';

describe('slugify', () => {
  it('lower-cases and dash-separates words', () => {
    expect(slugify('Pull Requests')).toBe('pull-requests');
    expect(slugify('  Hello   World  ')).toBe('hello-world');
  });

  it('folds diacritics to ASCII', () => {
    expect(slugify('Crème brûlée — Recipes!')).toBe('creme-brulee-recipes');
    expect(slugify('Ångström Über Café')).toBe('angstrom-uber-cafe');
  });

  it('collapses punctuation and trims dashes', () => {
    expect(slugify('GitHub - foo/bar: Issues #12 (open)')).toBe('github-foo-bar-issues-12-open');
    expect(slugify('--- ??? ---')).toBe('');
    expect(slugify('a_b.c,d')).toBe('a-b-c-d');
  });

  it('applies compatibility folding', () => {
    expect(slugify('ﬁle №5')).toBe('file-no5');
  });

  it('keeps unicode letters and digits', () => {
    expect(slugify('Привет, мир!')).toBe('привет-мир');
    expect(slugify('你好 世界 2026')).toBe('你好-世界-2026');
    expect(slugify('Straße')).toBe('straße');
  });

  it('returns an empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('caps the length at a word boundary', () => {
    const title =
      'The quick brown fox jumps over the lazy dog while the cat watches from the window sill';
    const full = slugify(title, 1000);
    const s = slugify(title);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.length).toBeGreaterThan(36);
    expect(full.startsWith(s)).toBe(true);
    expect(full[s.length]).toBe('-');
    expect(s.endsWith('-')).toBe(false);
  });

  it('respects a custom max', () => {
    expect(slugify('alpha beta gamma delta', 12)).toBe('alpha-beta');
  });

  it('hard-cuts when there is no boundary near the limit', () => {
    const word = 'a'.repeat(80);
    expect(slugify(word)).toBe('a'.repeat(60));
    expect(slugify(`ab ${'c'.repeat(80)}`)).toBe(`ab-${'c'.repeat(57)}`);
  });

  it('never ends with a dash after cutting', () => {
    for (let n = 1; n < 30; n++) {
      const s = slugify('ab cd ef gh ij kl mn op qr st uv wx yz', n);
      expect(s.length).toBeLessThanOrEqual(n);
      expect(s.endsWith('-')).toBe(false);
    }
  });
});

describe('siteOf', () => {
  it('returns the host without www.', () => {
    expect(siteOf('https://www.github.com/foo/bar?x=1')).toBe('github.com');
    expect(siteOf('https://github.com/')).toBe('github.com');
    expect(siteOf('https://docs.google.com/document/d/1')).toBe('docs.google.com');
  });

  it('only strips a leading www.', () => {
    expect(siteOf('https://www2.example.com/')).toBe('www2.example.com');
    expect(siteOf('https://foo.www.example.com/')).toBe('foo.www.example.com');
  });

  it('drops the port and keeps localhost / IPs', () => {
    expect(siteOf('http://localhost:4321/page.html')).toBe('localhost');
    expect(siteOf('http://127.0.0.1:8080/')).toBe('127.0.0.1');
  });

  it('gives punycode for IDN hosts', () => {
    expect(siteOf('https://www.bücher.de/')).toBe('xn--bcher-kva.de');
  });

  it("returns '' for URLs without a host", () => {
    expect(siteOf('file:///Users/me/page.html')).toBe('');
    expect(siteOf('about:blank')).toBe('');
    expect(siteOf('data:text/html,<p>hi</p>')).toBe('');
  });

  it("returns '' for invalid URLs", () => {
    expect(siteOf('not a url')).toBe('');
    expect(siteOf('')).toBe('');
  });
});

describe('dateStamp', () => {
  it('formats local YYYY-MM-DD-HHMM', () => {
    expect(dateStamp(AT)).toBe(STAMP);
  });

  it('zero-pads month, day, hours and minutes', () => {
    expect(dateStamp(new Date(2026, 0, 5, 3, 7).getTime())).toBe('2026-01-05-0307');
    expect(dateStamp(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe('2026-12-31-2359');
    expect(dateStamp(new Date(2027, 0, 1, 0, 0).getTime())).toBe('2027-01-01-0000');
  });
});

describe('exportFilename', () => {
  it('is <site>-<title>-<date>.png', () => {
    expect(
      exportFilename({ url: 'https://github.com/pulls', title: 'Pull requests', capturedAt: AT }),
    ).toBe(`github.com-pull-requests-${STAMP}.png`);
  });

  it('drops the site name when the title leads with it', () => {
    expect(
      exportFilename({
        url: 'https://www.github.com/foo/bar',
        title: 'GitHub - foo/bar',
        capturedAt: AT,
      }),
    ).toBe(`github.com-foo-bar-${STAMP}.png`);
    expect(
      exportFilename({
        url: 'https://docs.google.com/document/d/1',
        title: 'Google Docs - Quarterly plan',
        capturedAt: AT,
      }),
    ).toBe(`docs.google.com-docs-quarterly-plan-${STAMP}.png`);
  });

  it('keeps a site word that only appears later or as a whole title', () => {
    expect(
      exportFilename({ url: 'https://github.com/', title: 'Welcome to GitHub', capturedAt: AT }),
    ).toBe(`github.com-welcome-to-github-${STAMP}.png`);
    expect(exportFilename({ url: 'https://github.com/', title: 'GitHub', capturedAt: AT })).toBe(
      `github.com-github-${STAMP}.png`,
    );
    // Only a whole-word prefix counts.
    expect(
      exportFilename({ url: 'https://github.com/', title: 'GitHubber stories', capturedAt: AT }),
    ).toBe(`github.com-githubber-stories-${STAMP}.png`);
  });

  it('handles an empty or punctuation-only title', () => {
    expect(exportFilename({ url: 'https://example.com/', title: '', capturedAt: AT })).toBe(
      `example.com-${STAMP}.png`,
    );
    expect(exportFilename({ url: 'https://example.com/', title: ' — ', capturedAt: AT })).toBe(
      `example.com-${STAMP}.png`,
    );
  });

  it("uses 'page' when there is no host", () => {
    expect(
      exportFilename({ url: 'file:///Users/me/report.html', title: 'Report', capturedAt: AT }),
    ).toBe(`page-report-${STAMP}.png`);
    expect(exportFilename({ url: 'about:blank', title: '', capturedAt: AT })).toBe(
      `page-${STAMP}.png`,
    );
    expect(exportFilename({ url: 'garbage', title: 'Hello', capturedAt: AT })).toBe(
      `page-hello-${STAMP}.png`,
    );
  });

  it('caps a long title', () => {
    const name = exportFilename({
      url: 'https://example.com/',
      title: 'word '.repeat(40),
      capturedAt: AT,
    });
    const title = name.slice('example.com-'.length, -`-${STAMP}.png`.length);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith('word-word')).toBe(true);
  });

  it('produces filesystem-safe names', () => {
    const name = exportFilename({
      url: 'https://www.example.com/a?b=c',
      title: 'A/B: "quotes" <tags> | pipes * stars? back\\slash',
      capturedAt: AT,
    });
    expect(name).not.toMatch(/[/\\:*?"<>|\s]/);
    expect(name.endsWith('.png')).toBe(true);
  });
});

describe('regression: slugify splits words on non-Latin combining marks', () => {
  // Only U+0300–U+036F are stripped after NFKD; other combining marks (\p{M}: Japanese dakuten
  // U+3099, Devanagari vowel signs and virama) fall outside [\p{L}\p{N}] and become dashes, and
  // the result is left decomposed (Hangul comes out as conjoining jamo, not NFC).
  it('keeps Japanese words with dakuten intact', () => {
    expect(slugify('データ')).toBe('データ');
  });

  it('keeps Devanagari words intact', () => {
    expect(slugify('हिन्दी')).toBe('हिन्दी');
  });

  it('returns NFC text', () => {
    expect(slugify('한국어')).toBe('한국어');
  });
});
