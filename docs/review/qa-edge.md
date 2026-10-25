# Edge interactions (task 5)

Build: `.output/chrome-mv3-e2e-q` (HEAD 6eb6ce6). All runs were headless. The main runs used Playwright Chromium 156 at DPR 2, and each case was repeated in Chrome for Testing 156.0.8078.47 at DPR 1, with the same results unless noted. Scripts are in `/tmp/pagesnap-review/qa-scratch/edge/`; artifacts and raw logs are in `/tmp/pagesnap-review/qa/edge/`. The fixtures came from `scripts/serve-fixtures.mjs` on :4321. A local streaming server (`slowserver.mjs`, :4399) provided `slow.html`: 16 bands of 500 px streamed over 8 s, each with an image delayed by 2–12.5 s.

## Issues

### E1 (P2): capturing a page that is still parsing fails with an internal error after 5 s
- **Repro:** open a page whose HTML is still streaming (`slow.html?ms=500`, about 8 s to finish parsing). Click the toolbar button about 300 ms after navigation, while `readyState=loading`.
- **Expected:** the capture waits for the page to finish parsing, or captures what is there, or shows a friendly "page still loading, try again" message.
- **Actual:** `executeScript` (no `injectImmediately`) waits for document_idle, but the agent's 5 s connect timer (`AgentLink.inject(tabId, 5000)`) starts before that. The session ends `error` with `INTERNAL: Capture failed: The page agent did not respond`, and the editor shows "The capture didn't work / Capture failed: The page agent did not respond". This happened in both browsers at DPR 1 and 2. The page itself was left clean, and a second capture after load worked.
- **Artifacts:** `edge/c1-slow-commit-chromium-dpr2-editor.png`, `edge/c1-chromium-dpr2.json`, `edge/c1-cft-dpr1.json`, `qa-scratch/edge/c1c.mjs`.

### E2 (P2): the `IMAGES_PENDING` warning is never raised, so missing images go unreported
- **Repro:** open `slow.html?ms=0`. The HTML is fully parsed, but each image takes 2–12.5 s. Capture at domcontentloaded.
- **Expected:** the agent waits a little for in-view images and, if they are still pending, flags the session with "Some images were still loading" (the code exists in `WARNING_MESSAGES`).
- **Actual:** the session is `ready` with `warnings: []`. All 16 images are blank boxes in the stitched image, and `readyState` was still `interactive` when the capture finished. The pending count from `waitForImages()` is thrown away in `agent/session.ts:175`. Nothing ever emits `IMAGES_PENDING` (grep finds it only in the message table).
- **Artifacts:** `edge/c1-slow-dcl-imgs-preview.png` (all bands present, every image missing), `edge/c1-slow-dcl-imgs-chromium-dpr2.png`.

### E3 (P2): right-click "Copy image" uses a stale composite for several seconds after each edit
- **Repro:** capture Wikipedia "World War II" (118,548 image px at DPR 2). Draw an arrow, then right-click the canvas right away.
- **Expected:** the native context-menu image shows the current annotations, or the swap is held back until it is current.
- **Actual:** the swap target works: on right-click, `elementFromPoint` is `<img data-testid=editor-composite>` and `contextmenu.target` is that IMG. But its `src` is the composite for `rev 0` while the doc is at `rev 1`, so "Copy image" would copy the page without the newest mark. Time for the composite to catch up after an edit:

  | Page | Catch-up time |
  |---|---|
  | bands, DPR 2 | 0.64 s |
  | bands, CfT DPR 1 | 0.48 s |
  | huge.html, DPR 2 | 2.2 s |
  | Wikipedia, DPR 2 | 3.5 s |

  For the first 3.2 s after the Wikipedia editor is ready there is no composite at all, so the right-click falls through to the canvas and there is no "Copy image" item. Every commit re-encodes the full page in the background: 1280×59274 for Wikipedia, and 1198×65535 for huge.html (downscaled to the 65,535 px side limit). That cost is paid on every edit.
- **Artifacts:** `edge/r-c6-wiki.log`, `edge/r-c6-cft1.log`, `qa-scratch/edge/c6_rightclick.mjs`.

### E4 (P2): Cmd+C while a text box is open (caret, no selection) silently does nothing
- **Repro:** press T, click the canvas, type "Hello copy", then press Cmd+C without selecting anything.
- **Expected:** commit the text and copy the image. "Type a note, then ⌘C" is the core flow into an AI chat.
- **Actual:** `handleEditorKey` returns early while `editingTextId` is set, and a native copy of an empty selection writes nothing. The clipboard still held the sentinel, `copy.state` stayed `idle`, there was no toast, and the text stayed uncommitted.
- **Related behaviour:**
  - With text selected (Cmd+A, then Cmd+C), the text is copied as `text/plain`. That is reasonable.
  - Cmd+Z inside the textarea does a native undo of the typing and leaves the shapes alone. That is fine.
  - Clicking the toolbar Copy button while editing commits the text first and copies the image with it (rev 2 key). That is correct.
- **Consistency:** identical in Chromium DPR 2, Chromium DPR 1 and CfT DPR 1.
- **Artifacts:** `edge/r-c5-*.log`, `edge/c5-editing-chromium-dpr2.png`.

### E5 (P3): Cmd+C in the first ~100 ms of the editor gives a misleading failure toast
- **Repro:** press Cmd+C as soon as the editor tab commits (while `load.phase=loading`).
- **Actual:**
  - Before React mounts: the press is ignored, with no toast.
  - While loading: the toast says "Couldn't copy the image. Nothing to copy yet. Download it instead with ⌘S". But ⌘S is also a no-op until the editor is ready (`download()` returns early).
  - The next press after ready works. Short pages copied in full; bands copied the viewport.
  - The clipboard was never overwritten with wrong content.
- **Expected:** queue the copy until ready (a `ClipboardItem` accepts a Promise), or say "Still loading, press ⌘C again".
- **Artifacts:** `edge/c4-*-editor.png`, `edge/r-c4-cft1.log`.

### E6 (P3): a toolbar click on tab B shortly after starting a capture of tab A is swallowed
- **Repro 2b:** start a capture on A, then within 800 ms switch to B and click the toolbar.
  - The B click returns `null` because of the `captureJustStarted()` double-click guard.
  - A is aborted by the tab switch (`error/TAB_CHANGED`, 0 slices).
  - A's error editor opens in the background, and A gets a red `!` badge.
  - The user, now on B, sees nothing happen.
- **Repro 2a race:** switch to B mid-capture and click B within about 20–50 ms. `cancelCapture()` still sees A's job in its finalize phase and eats the click. In CfT the click was eaten even at 50 ms. At 100 ms and later, B is captured correctly.
- **Expected:** a click on a different tab than the running capture's tab should start that tab's capture once A finishes, or at least not be treated as "cancel".
- **Artifacts:** `edge/c2-chromium-dpr2.json`, `edge/c2-cft-dpr1.json`, `qa-scratch/edge/c2b.mjs`.

### E7 (P3): keyboard-only users cannot pan the capture
- **Actual:**
  - The canvas has `tabIndex=-1` and no role or label.
  - Arrow, PageDown, Space and End do not move the camera. Only ⌘= / ⌘- (zoom around the centre), ⌘0 and ⌘1 work.
  - A keyboard-only user can't reach anything below the first screen of a tall capture. That also means Cmd+C's "current view" outcome is stuck at the top.
  - Arrow keys don't nudge selected shapes either.
  - Drawing needs a pointer. That is expected for v0.1, but it is worth noting.
- **What works:**
  - Tab order: page link, then 7 tools, the colour radiogroup (one tab stop, arrows move between colours), stroke width, zoom, Download, Copy. Undo and Redo are skipped while disabled.
  - Every stop has a visible 2 px blue `:focus-visible` ring and a tooltip.
  - Toolbar ARIA is good: a toolbar with groups, `aria-pressed` on tools, radios for colours, and labelled buttons.
  - The zoom menu opens with Enter, moves with arrows and closes with Esc, returning focus to its button.
  - Enter on Copy copies; ⌘S downloads; V, A, R and the other tool keys work even when a toolbar button has focus; Esc goes to select.
  - The options page is fully keyboard reachable with focus rings.
- **Not confirmed:** Space on the stroke-width button did not visibly move focus into a menu.
- **Artifacts:** `edge/c7-tab{1,2,9,13}-*.png`, `edge/c7-chromium-dpr2.json` (contains the ARIA snapshots), `edge/c7-cft-dpr1.json`.

### E8 (P3): capturing the editor tab itself gives a wrong reason in its warning
- **Repro:** press Alt+Shift+P on Page Snap's own editor tab.
- **Actual:** the result is a visible-only capture whose warning says "Pages of other extensions can't be scrolled". It is our own editor, and capturing it is almost certainly a mistake.
- **Expected:** a no-op, or a hint that Copy (⌘C) is the way to get the image.
- **Artifact:** `edge/c2-chromium-dpr2.json` (2e).

## Cases that passed

- **Capture at `commit` on a real site** (Wikipedia "Python", `readyState=interactive`): `ready` with 40 slices in 25 s (Chromium DPR 2) or 22 s (CfT DPR 1). The stitched image looks correct: no seams, images present, page restored to scroll 0,0. lazy-images.html captured at commit was also correct. Artifacts: `edge/c1-wiki-commit-*.png`, `edge/c1-lazy-commit-*.png`.
- **Capture B after A's editor opens:** works, and B's editor opens in front. When B is clicked again after its own capture finishes, a second capture runs. That is expected.
- **Closing the editor mid-encode** (huge.html, 70k CSS px; 2560×140000 at DPR 2 and 1280×70000 at DPR 1): closing 150 ms or 1.5 s after ⌘S or ⇧⌘C, or 50 ms after drawing, left the following clean:
  - no SW errors;
  - no stuck `activeCapture`;
  - the editor reopens in about 150 ms;
  - the latest shape is always persisted (the pagehide flush and the localStorage backup work);
  - a new capture works afterwards.

  Artifact: `edge/r-c3-cft1.log`.
- **Esc during capture:** the result is `partial` with `ABORTED_BY_USER`, and the page is restored.
- **Right-click swap target:** it is present and hit-tested correctly. After the menu, a pointer move releases `pointer-events`. The only problem is staleness (E3).
