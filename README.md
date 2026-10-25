# Page Snap (`pagesnap`)

Chrome extension: full-page screenshot → annotate instantly (arrows, boxes, underline, highlight,
pen, text) → `⌘C` the marked-up image into an AI chat.

Plan: [docs/PLAN.md](docs/PLAN.md). Contracts and conventions: [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Install (load unpacked)

1. `pnpm install && pnpm build` (output: `.output/chrome-mv3`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick
   `.output/chrome-mv3`.
3. Pin Page Snap to the toolbar. It asks for no host permissions: it only works on the tab you
   click it on.

`pnpm zip` builds the store zip in `.output/pagesnap-<version>-chrome.zip`.

## Use

- **Capture:** click the toolbar icon or press **Alt+Shift+P** (change it at
  `chrome://extensions/shortcuts`). A small panel shows the page filling in as it's captured;
  keep the tab in front, and press Esc or Stop to end early (closing the panel doesn't stop it).
  The editor opens next to the page with the **Arrow** tool armed.
- **Tools:** `A` arrow · `R` rectangle · `U` underline · `H` highlighter · `P` pen · `T` text ·
  `V` select (drag a box to select several). Shift snaps arrows to 45° and rects to squares.
- **Edit marks with any tool:** click a mark to select it and drag to move it; its handles resize,
  rotate (the circle above it) and bend arrows (the middle dot), Shift snaps to 15°. Hold `⌥` to
  draw on top of a mark instead, or `⌥`-drag a selected mark to duplicate it. `⌘D` duplicates,
  `⌘A` selects all, `Delete` removes, double-click (or `Enter`) edits text, `Esc` deselects.
- **Style:** `1`–`8` colour, `[` `]` thinner/thicker. With marks selected these (and the toolbar)
  change the selected marks; otherwise the tool's defaults. Text: Enter to finish, Shift+Enter for
  a new line.
- **Undo/redo:** `⌘Z` / `⇧⌘Z`. **Zoom:** `⌘+` / `⌘-`, `⌘0` fit width, `⌘1` 100%.
- **Copy:** `⌘C` copies the whole page if it's at most 2576 px tall (what AI chats read at full
  resolution). On taller pages it copies 2576 px around your marks, starting from the top of the
  page when the marks fit there; with no marks, from where you're looking down. `⇧⌘C` always
  copies the full page. The copied area flashes, and the toast says what was copied and its size.
  You can also right-click the canvas and choose Copy image.
- **Download:** the download button or `⌘S` saves the full page as PNG at full resolution.
- Marks are saved automatically; reopening the editor tab keeps them. Settings (starting colour,
  copy size, contrast shadow) are on the extension's options page.

## Develop and test

```sh
pnpm dev             # WXT dev build with HMR; load .output/chrome-mv3-dev unpacked
pnpm check           # typecheck + Biome + Vitest (unit and browser mode)
pnpm test:e2e        # e2e build + Playwright in bundled Chromium, headless
pnpm test:e2e:cft    # the same suite in Chrome for Testing, headless
```

- Chrome for Testing (real Chrome builds that still allow `--load-extension`):
  `npx @puppeteer/browsers install chrome@stable --path ~/.cache/pagesnap-cft`, or set
  `PAGESNAP_CFT_PATH` to the binary.
- Runs are always headless; `PAGESNAP_HEADED=1` opts into a visible window.
- `tests/e2e/flow.*.spec.ts` drive the real pipeline: capture a fixture page, draw with the mouse,
  `⌘C` / `⇧⌘C` read back from the clipboard, download, reload, and check the page was restored.
  `flow.perf.spec.ts` asserts the performance budgets.
- Walkthrough screenshots: `PAGESNAP_WALKTHROUGH=1 PAGESNAP_BROWSER=cft pnpm exec playwright test
  flow.walkthrough` writes them to `/tmp/pagesnap-qa/flow/`.
- Fixture pages: `node scripts/serve-fixtures.mjs` serves them on `http://127.0.0.1:4321/`.

Prior art: [mrcoles/full-page-screen-capture-chrome-extension](https://github.com/mrcoles/full-page-screen-capture-chrome-extension)
(MIT, MV2, 2016), used as a reference only.
