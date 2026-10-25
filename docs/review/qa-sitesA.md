# Real sites, batch A (Wikipedia, GitHub, MDN, news, docs.python.org, react.dev)

Build: `.output/chrome-mv3-e2e-q` (HEAD 6eb6ce6). Capture path: `__pagesnap.clickAction(tabId)` (toolbar listener). Window 1280x900, so the viewport is 1280x813. Headless. Each page was loaded, given a 2.5 s settle, scrolled to y=300, then captured.
"Restored?" compares scroll positions, `<style>` count, `[data-pagesnap]` nodes, html/body inline styles, inner scrollers, and before/after viewport screenshots.
Stitched PNGs are in `/tmp/pagesnap-review/qa/sites/<tag>[.partN].png`: scale 0.5 for DPR 2 (so 1 px = 1 CSS px), 1.0 for DPR 1.
The crops, overview sheets and seam strips I inspected are in `/tmp/pagesnap-review/qa/crops/`. Scripts are in `/tmp/pagesnap-review/qa-scratch/sitesA/`.

## Results

| Site | Browser | DPR | CSS size | Slices | Capture s | Status | Warnings (shown in the editor) | Restored? | Defects seen in the stitched PNG |
|---|---|---|---|---|---|---|---|---|---|
| Wikipedia, World_War_II | Chromium | 2 | 1280x59274 | 74 | 40.7 | ready | none | yes | None. Seams are clean (sentences continue across every boundary I checked). Thumbnails are all loaded. The TOC sidebar and the Vector sticky header appear only once, at the top. |
| Wikipedia | Chromium | 1 | 1280x59315 | 74 | 49.3* | ready | none | yes | None. Sharp at 1x. |
| Wikipedia | CfT 156 | 2 | 1280x59274 | 74 | 40.9 | ready | none | yes | None. Identical to Chromium. |
| GitHub, facebook/react README | Chromium | 2 | 1280x4251 | 6 | 3.2 | ready | none | yes | None. |
| GitHub README | Chromium | 1 | 1280x4251 | 6 | 3.5 | ready | none | yes | None. |
| GitHub PR #28000 /files (1 file) | Chromium | 2 | 1280x1259 | 2 | 0.9 | ready | none | yes | None. |
| GitHub PR #28328 /files (10 files, ~600 lines) | Chromium | 2 | 1280x16175 | 20 | 11.1 | ready | none | yes | None. Diff line numbers run on across every seam. The sticky file headers and PR toolbar are not duplicated. The file-tree sidebar appears once, at the top. |
| MDN, grid-template-columns | Chromium | 2 | 1280x9985 | 13 | 7.0 | ready | none | yes | None. The left nav and "In this article" appear once. The live example iframes render. The footer is complete. |
| MDN | CfT | 2 | 1280x9985 | 13 | 6.9 | ready | none | yes | None. Identical to Chromium. |
| Guardian article, consent wall not dismissed | CfT | 2 | 1280x813 | 1 | 0.3 | ready | none | yes | Only the consent wall was captured (see S-3). |
| Guardian article, consent dismissed (Chromium run 1) | Chromium | 2 | 1280x9454 | 12 | 18.9 | ready | HEIGHT_CHANGED | yes (`<style>` count +5 from the page's own ads) | **A band is duplicated at the seam at about 3244 CSS px** (S-1). **The bottom of the page is missing** (S-2). |
| Guardian, consent dismissed (Chromium run 2) | Chromium | 2 | 1280x9294 | 12 | 13.4 | ready | HEIGHT_CHANGED | yes | The page grew to 10635 px but the capture stops at 9294 (S-2). No duplicated band in this run. |
| Guardian, consent dismissed | CfT | 2 | 1280x9294 | 12 | 13.0 | ready | HEIGHT_CHANGED | Visually yes. scrollY went 300→140 because the top ad slot shrank by 160 px (the page's own scroll anchoring) | S-2 again: the page reached 10713 px. |
| docs.python.org, stdtypes (110,317 px tall) | Chromium | 2 | 1280x80000 | 99 | 54.3 | ready | TRUNCATED | yes | Seams are clean and the sidebar appears once. The capture stops at the 80,000 px cap, as designed, with a notice (S-5). |
| react.dev, useState | Chromium | 2 | 1280x18853 | 24 | 16.0 | ready | HEIGHT_CHANGED | yes (`<style>` +1, which a plain manual scroll also causes) | **Content is lost at the seam at 13787 px**: the CountLabel sandbox is cut after line 5 and the following text butts against it (S-1). |
| react.dev | Chromium | 1 | 1280x18851 | 24 | 15.1 | ready | HEIGHT_CHANGED | yes | Same cut sandbox in the same place, so it reproduces. |

\* This run overlapped with a second browser, so the time is inflated. Capture time is bounded by the `captureVisibleTab` throttle: about 0.53 s per slice. Note that the first Chromium Guardian run without the consent click was overwritten by the consent run under the same tag. Its log (`log-chromium2.txt`) shows 813 px, 1 slice and no warnings, the same as the CfT row.

Not found on any site in this batch:
- duplicated sticky headers or sidebars;
- missing lazy images;
- blank regions.

Every capture opened the editor in under 0.3 s. Sticky and fixed bars were handled well everywhere: Wikipedia's Vector sticky header, the react.dev and docs.python.org sidebars, GitHub's sticky PR toolbar and file headers, and MDN's sidebars.

## Issues

### S-1 (P2): When the page changes height mid-capture, a seam can drop or duplicate content, and the user is only told that "a few parts may be misaligned"
- **Repro (react.dev, deterministic):**
  1. Open https://react.dev/reference/react/useState at 1280x900, at DPR 1 or 2.
  2. Click the toolbar button.
  3. Look at the stitched image around y=13787 CSS px (the "Storing information from previous renders" example).
- **Expected:** the CountLabel Sandpack block appears whole (code lines 1–N, "Show more").
- **Actual:** the block ends after code line 5 and the next slice starts with "Note that if you call a set function while rendering…". About 200+ px of the example is missing.
  - Lazily mounted Sandpack iframes grow as they scroll into view. The planner keeps the precomputed dest offsets (all parts are `dest.y = n*1622`, `src.y = 0`), so content that grows above the current slice shifts out of alignment.
  - The HEIGHT_CHANGED notice is shown, but it doesn't say where the problem is.
- **Repro (Guardian, intermittent: 1 of 3 runs):**
  1. Open the Guardian article https://www.theguardian.com/world/2026/oct/24/spain-diners-food-restaurants-menu-del-dia and accept consent.
  2. Capture.
  3. At about y=3244 the paragraph "The price was set at between 50 and 250 pesetas…" and the bottom of the image grid appear twice, about 50 px apart.
- **Artifacts:**
  - `/tmp/pagesnap-review/qa/crops/reactdev-c2-seam13787.png` (full-res)
  - `/tmp/pagesnap-review/qa/crops/reactdev-chromium-dpr2-sheet1.png` (right column, around 70% of the way down)
  - `/tmp/pagesnap-review/qa/crops/reactdev-chromium-dpr1-sheet1.png`
  - `/tmp/pagesnap-review/qa/crops/news-c2-dup.png`
  - `/tmp/pagesnap-review/qa/sites/reactdev-chromium-dpr2.part2.png` (y≈1787)
- **Suggestion:**
  - When a height change is detected, re-measure the element offsets and either re-take the affected slice or re-anchor it, for example by matching rows against the previous slice's overlap.
  - Failing that, mark the affected seam in the editor ("parts near here may be misaligned") instead of showing only a page-level banner.

### S-2 (P2): Content that loads after the last slice (footer, "Most viewed") is cut off; the capture doesn't extend when the page grows
- **Repro:**
  1. Open the Guardian article above and accept consent.
  2. Capture at DPR 2, in Chromium or CfT.
- **Expected:**
  - The capture follows the page as it grows (`progress.total` "may grow if the page grows", per types.ts) down to the footer.
  - Or, if it can't, it says the bottom was cut off.
- **Actual:**
  - In all 3 runs the image ends mid-"Most viewed" at 9294–9454 px. The page's `scrollHeight` right after the capture was 10635 (Chromium) and 10713 (CfT).
  - About 1300 px is missing: the rest of the Most viewed list and the whole footer.
  - The only notice is the generic HEIGHT_CHANGED one, which suggests misalignment, not truncation.
- **Artifacts:**
  - `/tmp/pagesnap-review/qa/crops/news-c2-end.png`
  - `/tmp/pagesnap-review/qa/crops/newsc-cft-dpr2-sheet0.png` (last column ends at "Most viewed")
  - `/tmp/pagesnap-review/qa/sites/newsrerun-chromium-dpr2.json` (`pageInfo.sh` 9454, `shAfter` 10635, `session.css.h` 9294)

### S-3 (P3): A page locked by a consent or modal wall is captured silently as one viewport
- **Repro:**
  1. Open the Guardian article fresh, without dismissing the Sourcepoint "It's your choice" wall (it sets `body{position:fixed}`).
  2. Capture.
- **Expected:** a notice along the lines of "This page isn't scrollable right now (a dialog may be open). Close it and capture again", or the VISIBLE_ONLY-style note.
- **Actual:** status `ready`, 1 slice, 1280x813, no warning. The user gets an image of a cookie dialog with no hint why.
- **Artifacts:**
  - `/tmp/pagesnap-review/qa/sites/news-cft-dpr2.png`
  - `/tmp/pagesnap-review/qa/sites/news-cft-dpr2-before.png`
  - `/tmp/pagesnap-review/qa-scratch/sitesA/log-chromium2.txt`

### S-4 (P3): Long captures are slow and bounded by the throttle
- Wikipedia (74 slices) takes about 40 s. docs.python.org (99 slices, capped) takes 54 s. That works out to about 0.53 s per slice, which matches `CAPTURE_MIN_GAP_MS`.
- That is inherent to `captureVisibleTab`'s 2 calls/s limit. Still, a 40–55 s wait with only a badge counter is long. Consider:
  - showing an ETA or percentage;
  - for long pages, using fewer, taller slices (not possible with `captureVisibleTab`), or offering a "stop here" that is already obvious.
- **Artifacts:** `/tmp/pagesnap-review/qa/sites/wiki-chromium-dpr2.json` and `/tmp/pagesnap-review/qa/sites/pydocs-chromium-dpr2.json` (timings).

### S-5 (P3, by design): docs.python.org stdtypes is truncated at 80,000 CSS px
- The TRUNCATED notice is shown ("The page is very long, so the capture stops at the length limit.").
- The notice doesn't say where the limit is configured. It is `capture.maxCssHeight`, but the options page doesn't expose it in this build. This is fine for v0.1.
- **Artifact:** `/tmp/pagesnap-review/qa/sites/pydocs-chromium-dpr2-editor.png`

## Not issues (checked)
- **react.dev `<style>` +1 and Guardian `<style>` +5 after capture:** a plain headless scroll-through without the extension gives the same +1 on react.dev (`scrollcheck.mjs`). The extra elements come from the pages' own lazy widgets and ads. No `[data-pagesnap]` nodes and no html/body inline styles were left behind on any site.
- **Guardian CfT scrollY 300→140:** the top ad slot collapsed from 295 to 135 px and Chrome's scroll anchoring adjusted the position. The before/after screenshots show the same article position (`/tmp/pagesnap-review/qa/crops/newsc-cft-before-after.png`).
- **Seam overlap:** consecutive slices overlap by 4 image px at DPR 2 (`src.h` 1626, step 1622). No visible doubling from that.
