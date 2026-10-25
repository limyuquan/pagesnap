# Real sites (batch B) and browser zoom

All runs were headless, used the e2e build `.output/chrome-mv3-e2e-q`, and went through the real toolbar path (`__pagesnap.clickAction`). Window size was 1280x900, giving a 1280x813 viewport, except the horizontal-overflow run, which used an 800 px wide window. For every run I saved the stitched PNG at 1 image px per CSS px, an overview montage and seam strips (±60 to 80 px around every slice boundary). I looked at them directly.

- Artifacts: `/tmp/pagesnap-review/qa/sites/<site>-<browser>-dpr<N>{.png,.partN.png,-overview.png,-seams0.png,-before.png,-after.png,-editor.png,.json}`
- Scripts: `/tmp/pagesnap-review/qa-scratch/sitesB/` (`site.mjs`, `view.mjs`, `crop.mjs`, `zoom.mjs`)

## Real-site table

"Restored?" compares scroll position, style tags, `[data-pagesnap]` nodes, html/body inline style, and the inner scroller's `scrollTop` before vs after.

| Site | Browser | DPR | CSS size | Slices | Capture s | Status | Warnings (editor notice) | Restored? | Defects seen in PNG |
|---|---|---|---|---|---|---|---|---|---|
| HN front page | Chromium | 1 | 1280x1249 | 2 | 0.9 | ready | none | yes | none |
| HN front page | Chromium | 2 | 1280x1267 | 2 | 0.9 | ready | none | yes | none |
| HN item, 267 comments | Chromium | 1 | 1280x28706 | 36 | 19.5 | ready | none | yes | none: 35 seams checked, all clean |
| HN item, 267 comments | Chromium | 2 | 1280x28296 | 35 | 19.0 | ready | none | yes | none |
| ChatGPT share (inner scroller, 11.5k px) | Chromium | 1 | 1280x12216 | 16 | 15.5 | ready | INNER_SCROLLER + HEIGHT_CHANGED | yes | none. A wide table inside its own overflow-x box is cut at the right edge (I-6) |
| ChatGPT share | Chromium | 2 | 1280x12216 | 16 | 15.0 | ready | INNER_SCROLLER + HEIGHT_CHANGED | yes | same; seams clean, sidebar appears once |
| ChatGPT share, scroller pre-scrolled to 4000 | CfT | 2 | 1280x12216 | 16 | 26.4 | ready | INNER_SCROLLER + HEIGHT_CHANGED | yes (scrollTop 4580 back to 4580) | identical to the Chromium run |
| Notion public page (inner scroller), at top | Chromium | 2 | 1280x2031 | 3 | 1.5 | ready | INNER_SCROLLER | yes | none |
| Notion, scroller pre-scrolled to 600 | Chromium | 2 | 1280x2031 | 3 | 5.1 | ready | INNER_SCROLLER + HEIGHT_CHANGED | yes (scrollTop 600 back to 600) | Notion's top bar is missing and the top ~100 px is blank (I-5) |
| Notion, scroller pre-scrolled to 600 | Chromium | 1 | 1280x2031 | 3 | 1.6 | ready | INNER_SCROLLER + HEIGHT_CHANGED | yes | same as above |
| Notion | CfT | 2 | n/a | 1 | 0.4 | ready | none | yes | Blocked: Cloudflare "Just a moment..." page, so the capture is of the challenge page |
| IKEA category (lazy images) | Chromium | 2 | 1280x9684 | 12 | 7.0 | ready | none | yes | none: every image loaded, cookie bar only at the bottom, header once |
| IKEA category | CfT | 2 | 1280x9684 | 12 | 7.8 | ready | none | yes | none |
| Amazon search (redirected to amazon.sg; lazy images) | Chromium | 2 | 1280x7418 | 10 | 6.3 | ready | HEIGHT_CHANGED | yes. The diff (+1 style tag, `--nav-pinned-height`) is Amazon's own scroll handler: a plain scroll without the extension produces the same diff | none; images loaded. The page's own region-picker modal dims the page, faithfully |
| w3schools HTML iframes (7 iframes) | Chromium | 2 | 1280x6125 | 8 | 4.8 | ready | HEIGHT_CHANGED | yes | **The top nav repeats in all 8 slices and covers content (I-1). The fixed left sidebar is missing entirely (I-2)** |
| linear.app (natively dark) | Chromium | 2 | 1280x9614 | 12 | 7.8 | ready | none | yes | none |
| vercel.com (`prefers-color-scheme: dark`) | Chromium | 2 | 1280x5683 | 8 | 4.5 | ready | none | yes | none |
| Wikipedia "Comparison of programming languages", 800 px window (horizontal overflow, scrollWidth 1136) | Chromium | 1 | 1136x19676 | 50 (2 columns) | 27.1 | ready | HEIGHT_CHANGED | yes | none: horizontal and vertical seams are clean |
| Same page | Chromium | 2 | 1136x19677 | 50 | 27.1 | ready | HEIGHT_CHANGED | yes | none |
| claude.ai/share/... (2 links) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Not reachable headless: Cloudflare challenge |

## Browser zoom (`chrome.tabs.setZoom`)

I ran 80%, 100%, 125% and 150% at DPR 1 and 2. Pages: `bands.html` and `sticky-header.html?jump=1` (private fixture server on :4391) and en.wikipedia.org/wiki/Screenshot (DPR 2). Artifacts are in `/tmp/pagesnap-review/qa/zoom/` (`*-top.png` vs `*-cdp.png`, `*-label.png`, `*-seam.png`, `zoom-*.json`).

| Zoom | DPR 1: session.dpr / image | DPR 2: session.dpr / image | Pixel diff vs Chrome's own viewport screenshot | Band rules (15 per page) | Sticky header rows | Zoom after capture |
|---|---|---|---|---|---|---|
| 80% | 0.8 / 1280x6400 | 1.6 / 2560x12800 | 0 (identical) | all exact | 51 / 102 (exactly 64 x dpr) | kept |
| 100% | 1 / 1280x8000 | 2 / 2560x16000 | 0 | all exact | 64 / 128 | kept |
| 125% | 1.25 / 1280x10000 | 2.5 / 2560x19999 | 0 (Wikipedia: 0.01) | all exact | 80 / 160 | kept |
| 150% | 1.5006 / 1280x12005 | 3.0012 / 2560x24009 | 0 | 3 to 4 of 15 rules off by 1 px | 96 / 192 | kept |

**Verdict: correct and sharp.**

- The first viewport of the capture is pixel-identical to CDP `Page.captureScreenshot` at every zoom, so nothing is resampled or blurred. Text crops at 125% and 150% look crisp (`wikipedia-chromium-dpr2-z1.25-seam.png`).
- Band colours are right at every band centre.
- The sticky/jump header appears exactly once and the sticky panel once.
- The page is restored and the tab's zoom is left alone.
- Minor: at 150%, `session.dpr` is measured as 2560/853 = 3.0012 rather than 3, because `innerWidth` is 853.33 and gets rounded. The image is 9 px taller than 8000 x 3 and some rules land 1 px off. The bottom rows are the correct band colour, so this is cosmetic (I-7).

## Issues

### I-1 (P1): fixed header in a zero-height `position: fixed` wrapper repeats in every slice and hides content

**Repro:**
1. Open https://www.w3schools.com/html/html_iframe.asp at 1280x900, DPR 2.
2. Click the toolbar button.

**Expected:** the top nav (56 CSS px) appears once, at the top.

**Actual:**
- The nav is stamped at the top of all 8 slices, at y = 811, 1622, 2433, … CSS.
- Each copy covers the 56 px of page content beneath it, so that content is missing from the capture.
- The editor only shows the generic HEIGHT_CHANGED notice.

**Cause:** the outer element `#top-nav-bar` is `position: fixed` with a 0 px tall box (`getBoundingClientRect` = 0x1280). Its visible child `#pagetop` is `position: absolute` and 56 px tall. `SessionAgent.classify()` (`src/capture/agent/session.ts:245`) passes `rectOf(el)` of the fixed element itself to `classifyFloat`, so a zero-height wrapper is never classified as `top` and never hidden. The fix is to use the union of the descendants' rects (or `scrollHeight`) for fixed elements with an empty box. This pattern is common on CMS and "app shell" sites.

**Artifacts:**
- `sites/w3iframe-chromium-dpr2-seams0.png`: every strip shows the nav at the seam.
- `sites/w3iframe-chromium-dpr2-overview.png`
- `sites/w3iframe-chromium-dpr2.png`

### I-2 (P2): full-height fixed left sidebar is removed from the whole capture, including the first viewport

**Repro:** same page as I-1.

**Expected:** the left tutorial menu (`#sidenav`, fixed, 230x813) appears at least in the first viewport, as the user saw it. Alternatively, it appears once.

**Actual:**
- It is absent everywhere.
- A blank grey 230 px column runs the full 6125 px height.
- The subnav bar, the other fixed element, is correctly shown only in slice 0.

**Artifacts:**
- `sites/w3iframe-chromium-dpr2-before.png` (sidebar visible)
- `sites/w3iframe-chromium-dpr2-crop-top.png` (sidebar gone)

### I-3 (P3): the HEIGHT_CHANGED notice is shown on most real pages, with no misalignment found

**Repro:** capture the ChatGPT share link, Notion, Amazon, w3schools, the Wikipedia comparison page, or Wikipedia at 125% or 150% zoom.

**Expected:** the notice appears only when a seam is actually affected.

**Actual:**
- The editor shows "The page changed while it was captured (content loaded or moved), so a few parts may be misaligned." on 6 of the 10 real sites.
- Seam strips on all of them are clean.
- On ChatGPT the change is the scroller growing 12128 → 12216 px (+88, the sticky composer's padding).
- The notice is alarming and trains users to ignore warnings.

**Artifacts:** `sites/chatgpt-chromium-dpr2-seams0.png` and `sites/hscroll-chromium-dpr2-crop1500.png` (clean seams under the warning), and the `.json` files (`notice` field).

### I-4 (P3, observation): capture is slower in Chrome for Testing on the inner-scroller page

The ChatGPT share took 26.4 s in CfT vs 15.0 s in Chromium for the same 16 slices (1.45 vs 0.85 s per slice; prepare 1.8 vs 1.2 s). The CfT run also started with the scroller at 4000, so the comparison isn't perfectly clean. IKEA showed only a small gap (7.8 vs 7.0 s).

**Artifacts:** `sites/chatgpt-mid-cft-dpr2.json` and `sites/chatgpt-chromium-dpr2.json` (`timings`).

### I-5 (P3): Notion's auto-hiding top bar is lost if the user had scrolled down

**Repro:** open a notion.site page, scroll its inner scroller down (Notion hides its breadcrumb/top bar), then capture.

**Expected:** the page header (breadcrumb, "Get Notion free") at the top.

**Actual:** the top ~100 px is blank. Capturing from scrollTop 0 includes the bar. The capture reflects the page's own hidden state, so this is low severity, but users will usually capture after scrolling.

**Artifacts:**
- `sites/notion-chromium-dpr2-crop0.png` (blank)
- `sites/notion-top-chromium-dpr2-crop0.png` (bar present)
- `sites/notion-chromium-dpr2-before.png`

### I-6 (P3, limitation): horizontally scrolling boxes inside the page aren't expanded

On the ChatGPT share, "Table B" sits in its own overflow-x container, and its last column ("BOM used dollars") is cut at x = 1280. The capture matches what the page shows without scrolling the box. The capture has no warning for this.

**Artifact:** `sites/chatgpt-chromium-dpr2-crop10600.png`

### I-7 (P3): the measured dpr is slightly off at 150% zoom

`session.dpr` is 3.0012 (DPR 2) or 1.5006 (DPR 1), because the capture measures 2560/853 and `innerWidth` (853.33) is rounded. As a result `image.h` is 24009 instead of 24000, and 3 to 4 of the 15 band rules land 1 px off. There is no visible effect. Tool sizes and copy scaling inherit the 0.04% error.

**Artifact:** `zoom/zoom-chromium-dpr2.json`

## Blocked or not reachable

- claude.ai/share links: Cloudflare challenge in headless.
- notion.site: Cloudflare-throttled after a few loads; the CfT run captured the challenge page.
- The first Google Docs `/pub` link found was deleted, and Docs `/pub` pages scroll the body rather than an inner scroller. Notion and ChatGPT were used as the inner-scroller cases instead.
