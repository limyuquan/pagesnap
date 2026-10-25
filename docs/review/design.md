# Page Snap v0.1 — design & UX review

Reviewed at HEAD 6eb6ce6 from /tmp/pagesnap-qa/{ui,flow} plus 30 extra headless renders in
/tmp/pagesnap-review/design-scratch/out (selection handles, text overlay, pen, drawn arrows, every toast,
hover/focus states, 1100/1000 px bars, 0.55× downscale of the clipboard PNG, and three copy-scope
simulations on the dumped 1440×4348 LMS page: `scope-current.png`, `scope-top-tight.png`, `scope-fill.png`).

Overall: the chrome is already in the right family (graphite, hairlines, native type, no cards, no gradients).
The marks are robust. The gaps are (a) what `⌘C` copies and how that is communicated, (b) a few defaults
that make marks look heavier than CleanShot, and (c) toolbar details that read as "greyed out" or break narrow.
Severity: **M** must-fix · **S** should-fix · **N** nice.

---

## 1. First impression, first 3 seconds

- **S — The hint is generic; the pre-selected tool is nearly invisible.** `--ps-on` is 13 % white on
  `#1b1b1d` (≈ `#2a2a2d`): the pressed Arrow button barely differs from idle. The user's cue that they can
  draw is a faint square and a crosshair.
  Fix: pressed state `background: rgb(255 255 255 / 0.17)` + `box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08)`;
  icon colour full `--ps-ink`. Light: `--ps-on: rgb(0 0 0 / 0.11)`. Hint text:
  `Drag to draw an arrow` · `⌘C copies` (replace "Draw on the page"); it stays first-run only.
- **S — The INNER_SCROLLER info strip steals the first capture on Canvas.** Every Canvas page triggers it, so
  the user's very first editor shows a 32 px strip of engineering prose ("…that panel was expanded in
  place") above the hint. Fix: drop it from the strip; keep it in the title tooltip (`title=` on
  `.ps-ident`) as `Captured the scrolling panel as one page.` If kept, auto-dismiss after 6 s.
- **N — Hint never goes away unless you draw or copy** (`drew` only flips on shapes). Fade it out
  on the first `pointerdown` on the canvas or after 8 s, whichever first; hide it during any drag.
- Good: fit-width open, top of page visible, inert toolbar at 38 % while capturing, no flash of empty UI.

## 2. Toolbar

Hierarchy and grouping (ident | tools · colour · size | history · zoom · download · **Copy**) is right.
46 px bar, 30 px buttons, 18 px glyphs, 16 px separators: correct native density.

- **M — Narrow windows break.** At 1000 px (`out/narrow-1000.png`) the tool and swatch groups overlap and
  the whole bar packs into the left ~650 px; at 1100 the host is gone but the bar is already tight.
  Split-screen on a 13" laptop is 720–900 px. Fix, in order of width: ≤1180 hide host (exists) → ≤1040 hide
  title (exists) → ≤960 collapse the 8 swatches to one 16 px colour well that opens the row as a popover
  (keys 1–8 still work) → ≤820 hide the `⌘C` kbd in the Copy button and the size label (dot + chevron only).
  Also give `.ps-bar` `overflow: hidden` and the centre column `min-width: max-content` so nothing can overlap.
- **S — Colour swatches.** Eight 15 px dots at 1 px gap are the busiest thing in an otherwise quiet bar and
  the one element that reads "pill cluster". Two options; I recommend the first:
  1. One colour well (16 px dot, `--ps-swatch-rim` 1 px) + chevron; click/hover opens the 8-swatch row as a
     `.ps-pop` with `1…8` kbd hints. Current colour stays visible; most sessions never leave red.
  2. Keep the row but 12 px dots, 6 px gap, 20 px cells; selected ring 18 px / 1.5 px.
  Either way: the chrome-coloured swatch disappears (black on dark, white on light = empty ring).
  Set rim to `rgb(255 255 255 / 0.32)` dark / `rgb(0 0 0 / 0.22)` light, and for the swatch whose luminance is
  within 10 % of `--ps-chrome` use a 1.5 px rim at 0.5 alpha.
- **S — Size control looks broken in Select with nothing selected**: `•  ⌄` with no number
  (`out/bar-hover-rect.png`). Keep showing the last draw tool's size, dimmed via `[data-inactive]`, instead of
  blanking. In the menu, preview each step as a 22 px long line of the real width (round caps) rather than a
  rank-scaled dot; it is more honest and still monochrome.
- **S — Zoom label.** Fit-width yields "97 %", "96 %", "73 %": noise. Show `Fit` while the camera is in
  fit-width mode and the percentage only after the user zooms; add a check mark to the active item
  (Fit width / Actual size) in the menu. Keep tabular nums.
- **S — Hover/pressed contrast.** `--ps-hover` 6 % white is almost invisible on dark. Use 0.09 hover,
  0.14 press, 0.17 pressed (above). Light: 0.06 / 0.10 / 0.11.
- **N — Copy vs Download.** Correct: Copy is the only filled control. Consider a split button
  (`Copy ⌘C` | `⌄` with `Copy around marks ⌘C` · `Copy full page ⇧⌘C` · `Download PNG ⌘S`): today
  `⇧⌘C` is only discoverable via the Copy tooltip and the options page. Keep the 1600 ms "Copied" swap.
- **N — Title/host.** Fine left-aligned, 13 px/500 + 12 px host. Add `cursor: pointer` and an underline on
  hover to the host only (the title itself should not look like a link). Truncation is handled.
- Icons at 18 px / 1.5 px: Select, Arrow, Rect, Underline, Text, Undo/Redo, Download all read without the
  tooltip. Highlighter is the weak one: the 45 % stripe vanishes at 18 px, so it reads as "pen or eraser"
  next to the actual Pen. Set the stripe to `opacity .75` and `strokeWidth 3`, shorten the body 1 px.
  Pen (squiggle) is fine.
- Light vs dark: keep following `prefers-color-scheme`; dark is the better reference (white page pops on
  `#2b2b2f`). Light surround `#dddddf` is right; do not lighten it. HUD always-dark is correct.

## 3. Annotation aesthetics

Marks survive AI downscaling: at 0.55× (`out/clip-down-0.55.png`) rect, arrow, text, underline and
highlight are all unambiguous. Sizes are right; the finish is slightly heavier than CleanShot.

- **S — Contrast shadow is too strong on white pages.** `rgba(0,0,0,.35)` blur 3 px, 1 px down under a red
  5–6 px stroke gives a grey halo (`out/zoom-arrow-text.png`, rect edges). Fix: `SHADOW_COLOR =
  rgba(0,0,0,0.22)`, `SHADOW_BLUR_CSS = 2`, offset 1. Keep the option; it still rescues red on dark headers.
- **S — Text reads as a sticker.** 26 px/700 with a 4 px white outline **and** the shadow under the outline.
  Fix: `TEXT_OUTLINE_RATIO = 3/26`, shadow (as above) applied to the outline pass only, fill unshadowed
  (already). Keep `lineJoin: round`, `miterLimit 2`. Default weight 700 is right for AI legibility.
- **S — Highlighter is indistinguishable from the page's own highlights.** `#FFD60A @ .45 multiply` on
  white gives ≈ `#FFED91`; Canvas's own `<mark>`/info boxes are `#FFFF00`/`#FFFBD6`, so the user's mark on
  "Submitting · an external tool" looks like a Canvas tag (`ready-annotated`). Fix: opacity `0.6`
  (≈ `#FFE66C`) and hue `#FFCC00`; keep multiply and butt caps. Band 22 px is right for 16 px body text.
- **N — Arrow.** 6 px shaft, head = 4× width at 26° half-angle, flat back, round-joined via a 35 % stroke:
  clean and CleanShot-like. For a touch more presence after downscale: head length `4.5 × width`
  (min 18 CSS px, max 60 % of length), half-angle 28°. Implement the planned drop of arrows shorter than
  `1.5 × headLen` (today only `MIN_DRAG_CSS = 5` applies, so a 6 px drag leaves a red blob).
- Rect 5 px / radius 4 CSS px: correct. Underline 5 px square caps: correct, keep. Pen (thinning .5,
  simulated pressure) tapers nicely; actual-size render is good.
- Selection: 8 px white squares with 1.5 px `#0A84FF`, dashed 4/3 bounds 3 px outside, r = 5 endpoint
  dots: all fine. One nit: handles sit directly on the 5 px red stroke; inset the dashed box to the
  stroke centre and draw handles with a 1 px `rgba(0,0,0,.25)` outer ring so they read on red.
- Text editing overlay: dashed blue 1 px box around a textarea with `-webkit-text-stroke` matches the
  committed look minus the shadow. Fine. Enter commits, Shift+Enter newline, Esc cancels: correct.

## 4. States and copy

- Capturing ("Capturing the page / 4 of 9" + 168×2 px hairline): exactly right. Error page: right.
- Notices: "Partial capture. The tab changed mid-capture. The image stops at 4,348 px." and "Visible area
  only. Chrome doesn't let extensions scroll this page." are good. INNER_SCROLLER: see §1.
- Toast layout (icon, title, dimmed size, one note line; 3.2/5.2/5.6 s; hover pauses) is right.
- **S — Smart-region toast wording.** "Copied the area around your marks 1440 × 828 / The page is 4,348 px
  tall. ⇧⌘C copies all of it." says what happened but not *what is missing*. With the scope change in §5:
  - top included: title `Copied around your marks`, size, note `From the top of the page down to 2,576 px.
    ⇧⌘C copies all 4,348 px.`
  - window: `Copied around your marks` / `2,576 of 4,348 px. ⇧⌘C copies the whole page.`
  - no marks: `Copied from here down` / `2,576 of 4,348 px. Mark something to copy around it.`
  Keep the pixel size dimmed; keep "Copied full page" and the tall note as they are.
- **S — Options page should expose the scope choice.** The page is calm and well-set (hairline sections,
  two-column rows). Add under *Copying*: `⌘C on tall pages` ◉ `As much as an AI can read, including your
  marks` ○ `Just around your marks` (maps to the §5 algorithm vs today's). Nits: toggle 38×22 is fine;
  "Starting colour" reuses the swatch component so the chrome-colour swatch issue applies here too.
- **N — Extension icon reads as "page blocked".** A red diagonal across a document is a strike-through
  glyph at 16 px (`icon-preview.png`). Give the stroke an arrowhead (same 26° head, pointing up-right) or
  make it a highlighter band behind one text line. Badge treatments (`…`, `42%`, `!`) are good.

## 5. What `⌘C` copies — evaluation and recommendation

Today on the 4348 px LMS page the smart region is bbox + max(160, 10 %) pad → 1440×750–828, starting at
y≈261: the breadcrumb (y≈60) and H1 "Final Reflection Paper" (y≈150) are cut (`scope-current.png`).
The tight top-anchored variant (`scope-top-tight.png`, 1440×1010) restores both for 260 px.
Filling the 2576 budget from the top (`scope-fill.png`, 1440×2576) additionally brings the rubric table,
which is precisely what a follow-up question ("which rubric applies?") needs.

Trade-offs of filling the budget: ~4.7k vs ~1.5k Claude tokens per paste (irrelevant to a student);
on a 1568 px tier the image is seen at 0.61× (16 px body → ~10 px, still legible; marks are sized for
0.55×); the marks become a smaller share of the image (they are bold enough: the 0.55× test proves it).
A full-page tool's mental model is "the page with my marks"; the smart crop exists only because the model
cannot read 4348 px. The closest honest answer is "as much of the page as the model can read, marks
included, from the top when the top fits." **Recommend the fill strategy**, with the option above for
people who want the tight crop.

Precise behaviour (`planCopy`, image px, `budget = 2576 × dpr`):
1. `pageH ≤ budget` → full page (unchanged). `request === 'full'` → full (unchanged).
2. With shapes: `bbox`, `pad = max(160·dpr, 0.1·bbox.h)`, `need = bbox.h + 2·pad`.
   - `need > budget` → bbox only, `tall = true` (unchanged).
   - `bbox.bottom + pad ≤ budget` → `y0 = 0, y1 = min(pageH, budget)` (top of page fits: take it).
   - else `spare = budget − need; y0 = bbox.top − pad − round(0.55·spare)` (slightly more context above,
     where headings live), `y1 = y0 + budget`, then `placeSpan` to shift into `[0, pageH]`.
3. No shapes: `y0 = max(0, view.y)`, `y1 = min(pageH, y0 + budget)`, shift up if clamped. "From here down",
   not the 813 px viewport: the user scrolled there on purpose and a viewport-only copy is just a screenshot.
4. Edge snapping (cheap, in the export worker, on the 1× composite): for the bottom edge when `y1 < pageH`,
   scan the last 48 CSS px for the lowest row whose pixels across `x ∈ [0.1W, 0.9W]` are all within ±6/255 of
   each other; cut 8 px below it. Same for the top edge when `y0 > 0`. Never shrink by more than 48 px.
   Avoids half-lines of text at the cut, which is the one visible tell of an automatic crop.
5. **M — Show the region.** Words cannot carry this; CleanShot flashes the capture. On a successful copy
   draw, in the renderer overlay: dim outside the region `rgba(0,0,0,0.28)` + 2 px `#FFFFFF` outline with a
   1 px `rgba(0,0,0,.35)` outer ring; in 120 ms, hold 500 ms, out 420 ms (`--ps-ease-out`). If the region
   exceeds the viewport, the dimmed band at the viewport edge still tells the user "more was copied".
   Also: holding `⌘` for > 400 ms could preview the same overlay without copying (N).

## 6. Micro-interactions

- Cursors: crosshair for every draw tool, `text` for Text, `default`/`move`/resize for Select, grab/grabbing
  on Space: correct and verified. N: Highlighter and Pen could use a 2 px dot crosshair
  (`cursor: url(...) 8 8, crosshair`) so a 22 px band is not drawn from a hairline crosshair.
- Esc: draft → cancel; selection → clear; tool → Select; Select with nothing → no-op. Correct. Verified.
- Tooltip: 450 ms delay, 350 ms warm swap, 90 ms fade, label + dimmed kbd: native-feeling. Keep.
- Popover 140 ms translateY(−3) scale(.98): good. Toast 200/260 ms: good. Progress bar 420 ms: good.
- Focus ring 2 px `#3d8bff` offset 1 on `:focus-visible` only: good. Swatch radiogroup arrow-key
  navigation: good.
- **S — Hover feedback is too faint** (see §2). Also give `.ps-swatch:hover::before` a rim lift
  (`box-shadow: inset 0 0 0 1px rgb(255 255 255 / .45)`) rather than only `scale(1.12)`.
- **N — `[`/`]` have no feedback beyond the number.** Flash the size dot (scale 1.3 → 1, 160 ms) or show the
  tooltip for 600 ms with `Stroke 8 px`.
- N — `prefers-reduced-motion` is honoured globally; fine.

---

## Top 10, ranked

1. **M** Flash the copied region on the canvas after `⌘C` (dim outside + white outline, 120/500/420 ms).
2. **M** Change the smart scope: fill the 2576 px budget, anchored at the top of the page when
   `bbox.bottom + pad ≤ budget`; "from here down" when there are no marks; snap edges to blank rows.
3. **M** Fix the toolbar below ~1040 px: collapse swatches to one colour well, drop the `⌘C` kbd, no overlap.
4. **S** Soften the mark finish: shadow `rgba(0,0,0,.22)` blur 2; text outline 3/26 with shadow on the
   outline only.
5. **S** Highlighter `#FFCC00 @ 0.6` so it is not mistaken for the page's own highlight.
6. **S** Make the active tool obvious: pressed 17 % + inset hairline; hint `Drag to draw an arrow · ⌘C copies`.
7. **S** Toast wording per §4; options page gets an explicit `⌘C on tall pages` choice.
8. **S** Size control never blank; zoom shows `Fit` in fit-width; hover 9 % / press 14 %.
9. **S** Swatch rim contrast so black (dark) and white (light) swatches are visible; one colour well preferred.
10. **S** Remove the INNER_SCROLLER strip from the first Canvas capture; fix the Highlighter icon stripe.
