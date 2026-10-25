# 01 — Capture engine

Status: research / proposal · Written 2026-10-25 · Scope: everything from "user clicks capture" to "editor has the pixels".

Two different things are called "GoFullPage" in this doc. Keep them apart:

- **Upstream (2016)**: the MIT clone at `reference/full-page-screen-capture` (MV2, v1.0.1, 2016-05-14). Its own README says "the webstore version is now running on a private branch of this repo" (`README.md`, "From the webstore").
- **GoFullPage (current)**: the closed-source Web Store build, v8.10 (2026-10-22), MV3 since 8.0 (2024-05-21). We only know it from public sources: the Web Store listing and changelog, the gofullpage.com FAQ, and the marketing copy. We are not copying its code.

---

## 1. Upstream (2016 baseline) analysis

### 1.1 Control flow

| Step | Where | What happens |
|---|---|---|
| 1 | `popup.js:114-121` | The popup opens, queries the active tab and calls `CaptureAPI.captureToFiles`. **All orchestration runs inside the popup page**, so if the popup closes the capture dies. |
| 2 | `api.js:240-242` | `isValidUrl` checks a hard-coded allow/deny list (`api.js:13-33`). On failure it calls `errback` but does **not** return, so execution continues anyway (bug). |
| 3 | `api.js:245-261` | Registers a `runtime.onMessage` listener **on every capture**, never removed, so listeners stack (the `TODO` at `api.js:244` admits it). |
| 4 | `api.js:263-282` | `chrome.tabs.executeScript('page.js')` (MV2) with a 3 s watchdog. |
| 5 | `page.js:15-18` | Idempotent listener guard (`window.hasScreenCapturePage`). |
| 6 | `page.js:24-97` | `getPositions` measures the page and builds the list of scroll positions ("arrangements"), see 1.2. |
| 7 | `page.js:107-153` | For each arrangement: `scrollTo` → wait `CAPTURE_DELAY`=150 ms (`page.js:2`) → `sendMessage({msg:'capture', x, y, ...})` → wait for the reply → next. A 1250 ms `cleanUp` timer (`page.js:137`) is the only failure recovery. |
| 8 | `api.js:45-97` | The popup calls `captureVisibleTab(png)`, loads the result into an `Image`, rescales coordinates and draws the slice into one or more output canvases. If `dataURI` is falsy it does nothing, never replies, and the page hangs until the 1250 ms cleanup (`api.js:48`). |
| 9 | `api.js:165-187, 190-216` | Each canvas goes `toDataURL` → `atob` → `Blob` → written to the **TEMPORARY HTML5 FileSystem** (`webkitRequestFileSystem`) and opened via a `filesystem:chrome-extension://…/temporary/<name>` URL. |
| 10 | `popup.js:44-86` | One new tab per output file. Incognito tabs can't reach the filesystem, so it opens a non-incognito window (`popup.js:60-72`). |

### 1.2 Arrangement calculation (`page.js:24-97`)

- Overflow fix: sets `body.style.overflowY='visible'` so pages with `body{overflow-y:scroll}` scroll via `window.scrollTo` (`page.js:32-36`). This was an early, narrow version of "the scroller isn't the document" (see §3.4).
- Page size: takes the `max()` of five width metrics and five height metrics (clientWidth/Height, body scroll/offset, documentElement scroll/offset; `page.js:38-57`). `max()` drops falsy values (`page.js:20-22`). This overestimates on pages with margins or collapsing `offsetHeight` and leaves blank space at the bottom.
- Off-by-one fix: if `fullWidth <= innerWidth + 1`, treat the page as one column (`page.js:70-73`), because zoom causes a phantom 1px of horizontal overflow.
- Scrollbars are hidden with `documentElement.style.overflow='hidden'` (`page.js:77`). This happens **after** measuring (`page.js:38-59`). Removing the scrollbar re-flows the page wider, so the measurements are stale (bug).
- **Bottom-up order with a 200 px overlap** (`page.js:61-64, 79-86`): `yPos` starts at `fullHeight - innerHeight` and moves up by `innerHeight - 200` per step. Columns step by `innerWidth`. Because later (higher) slices are drawn over the top 200 px of earlier (lower) ones, **a fixed or sticky header of ≤200 px is painted over in every slice except the top one**. This is the whole sticky-header strategy. Its limits:
  - Headers over 200 px still repeat.
  - Fixed footers, chat bubbles and sticky sidebars **do** repeat.
  - About 22% more captures than needed at a 900 px viewport.
- The loop condition `yPos > -yDelta` allows negative positions, which the browser clamps to 0. That's harmless, but it can capture the top twice.
- Placement uses the **actual** `window.scrollX/scrollY` after `scrollTo` (`page.js:123-124`), not the requested value. That correctly handles clamping at the page edges. With CSS `scroll-behavior: smooth` it breaks: the read happens mid-animation. Current GoFullPage fixed this in 8.4 ("unexpected smooth scroll").

### 1.3 DPR / zoom (`api.js:51-62`)

It ignores the `devicePixelRatio` it sends (`page.js:129`). Instead it computes `scale = image.width / window.innerWidth` from the **actual captured bitmap** and scales `x, y, totalWidth, totalHeight`. This is correct and robust: it covers retina, browser zoom (where `innerWidth` is in zoomed CSS px), and DevTools device emulation (comment at `api.js:53-55`). The changelog shows several "retina" fixes (0.0.9, 0.0.13, 0.0.14) before landing on this. **Port this.** Its gaps:

- Fractional scales (125% Windows scaling, 110% zoom) are not rounded, so canvas sizes truncate. Current GoFullPage needed several "white lines" fixes (4.1, 4.5, 6.4).
- `scale` is only recomputed when the widths differ.

### 1.4 Canvas splitting (`api.js:4-6, 100-162`)

- Limits: `MAX_PRIMARY_DIMENSION = 30000`, `MAX_SECONDARY_DIMENSION = 8000`, area = 240 M px.
- If the page is "bad size", it builds a grid of output canvases. The long axis gets 30000 and the short axis 8000 (`api.js:106-116`), and the last row/column gets the remainder (`api.js:124-127`).
- Canvases are created lazily on the first capture, because the scale isn't known until then (`api.js:64-77`).
- Each slice is drawn into every canvas it intersects (`_filterScreenshots`, `api.js:150-162`), offset by the canvas origin (`api.js:83-87`).
- The popup shows a "split" notice and the number of parts (`api.js:71-76`, `popup.js:105-107`).

The **tile-grid and intersect logic is worth porting nearly verbatim** (in TypeScript, with integer rounding). The constants are stale: see §3.9 for Chromium's real limits.

### 1.5 Restoring state (`page.js:99-105`)

It restores `documentElement.style.overflow`, `body.style.overflowY` and the original scroll position. It writes inline styles and restores the saved strings, so it clobbers any change the page itself made in the meantime. If the popup dies, the only safety net is the 1250 ms timer.

### 1.6 Result display

Results open as one tab per split file, from `filesystem:` URLs (`api.js:196-200`, `popup.js:54-86`). There is no viewer, history or editor.

### 1.7 Port vs obsolete

| Port (algorithm / idea) | Obsolete or replace |
|---|---|
| Scale from the measured bitmap width (`api.js:56-62`) | MV2 `browser_action`/`manifest_version:2` (`manifest.json:4-8`) → MV3 `action` |
| Place slices by the *actual* post-scroll position (`page.js:123-124`) | `chrome.tabs.executeScript` (`api.js:263`) → `chrome.scripting.executeScript` |
| Output tile grid + intersect filter (`api.js:100-162`), lazy init after the first frame | Orchestration in the popup (`popup.js:114`) → service worker (SW) |
| Overlap between slices (`page.js:61-64`), kept tiny (a few px) only to hide rounding seams | Using a 200 px overlap as the sticky-header strategy → explicit fixed/sticky handling (§3.1) |
| Zoom off-by-one threshold (`page.js:70-73`), generalized to "ignore overflow < 16 px" | `max()`-of-five height heuristic (`page.js:38-57`) → `scrollingElement` and the real scroll range |
| Body-overflow fix (`page.js:32-36`), generalized into scroller detection | 150 ms delay (`page.js:2`). Since Chrome 92 the quota is 2 captures/s, so this would error |
| Idempotent injection guard (`page.js:15-18`) | `new Image()` + data URL decode (`api.js:49`): there is no DOM in the SW → `createImageBitmap` |
| Restore scroll and styles on exit (`page.js:99-105`), made robust (§5.5) | `toDataURL`→`atob`→`Blob` (`api.js:165-187`) → `OffscreenCanvas.convertToBlob` |
| Filename slug (`popup.js:22-36`) | HTML5 FileSystem + `filesystem:` URLs (`api.js:190-216`) → IndexedDB |
| Split-image UX notice | Incognito non-incognito-window workaround (`popup.js:60-72`) → decide incognito mode (§5.8) |
| | Hard-coded URL validity list (`api.js:13-33`; old Web Store domain only) → try to inject, then degrade |
| | Missing `lastError` handling (`api.js:47-48`), stacking listeners (`api.js:245`), no return after errback (`api.js:240`) |

---

## 2. MV3 capture options (verified Oct 2026)

### 2.1 `chrome.tabs.captureVisibleTab` + scroll-and-stitch

Facts from developer.chrome.com, `tabs` reference:

- Signature: `captureVisibleTab(windowId?, {format:'jpeg'|'png', quality?}) → Promise<dataURL>` (promises since Chrome 88).
- Requires `activeTab` **or** `<all_urls>`. It "allows extensions to capture sensitive sites that are otherwise restricted, including chrome:-scheme pages, other extensions' pages, and data: URLs. These sensitive sites can only be captured with the activeTab permission." File URLs need the user's file-access toggle.
- `chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2` (Chrome 92+). Going over it rejects with "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."
- `activeTab` has **no install warning**. It is granted by an action click, popup open, keyboard command or context-menu click, and lasts until the tab navigates or closes. Combined with `scripting`, this is exactly current GoFullPage's "without requesting any extra permissions" posture.

What it can't do:

- It only captures the visible viewport of the **active tab of that window**. If the user switches tabs, you capture the wrong tab, so check before every frame.
- A minimized window doesn't work.
- It captures whatever is painted: hover states (lost on scroll; the current GoFullPage FAQ admits this), focus rings, our own overlays, and native `<select>` popups are not reliable either way.
- It can't scroll anything a content script can't reach: the PDF viewer, the Web Store, chrome:// pages (visible-only there), and cross-origin iframes without host permission.
- It fails under enterprise `DisableScreenshots` / DLP policies.

Cost: about 500 ms per viewport. A 15,000 CSS px page in a 900 px viewport is about 17 frames, about 9 s.

### 2.2 `chrome.debugger` + CDP `Page.captureScreenshot`

Protocol facts (devtools-protocol `browser_protocol.json`, tip-of-tree):

- `Page.captureScreenshot{format, quality, clip, fromSurface*, captureBeyondViewport*, optimizeForSpeed*}`. The starred parameters are experimental. `captureBeyondViewport` defaults to false.
- `Page.getLayoutMetrics` gives `cssContentSize` and `cssVisualViewport`.
- `Emulation.setDeviceMetricsOverride{width, height, deviceScaleFactor, mobile, ...}` and `Emulation.setScrollbarsHidden` (experimental).

Costs, all verified:

- **Permission:** `debugger` triggers the install warnings "Access the page debugger backend" **and** "Read and change all your data on all websites" (permissions list). It is on the short list of permissions that **cannot be optional** (`permissions` API docs), so it can't be requested on demand. Every user sees the scary warning at install. Adding it in an update disables the extension until the user re-approves.
- **Infobar:** while attached, Chrome shows the "“pagesnap” started debugging this browser" bar. The user's Cancel detaches us. The bar appearing and disappearing resizes the viewport, which fires `resize` and causes a layout shift mid-capture. The only ways to suppress it are the `--silent-debugger-extension-api` flag or an enterprise force-install.
- **Restricted targets:** it can't attach to chrome://, the Web Store or other extensions. In Chrome 155 (stable rollout from 2026-10-06), attach is rejected outright under `runtime_blocked_hosts` or screenshot/DLP policies ("Host access is restricted by policy", "Screenshot capture is restricted by policy"). The error strings are in the debugger docs; the timeline comes from a secondary source.
- **Layout side effects:** `captureBeyondViewport` resizes the layout to the content. 100vh heroes stretch, resize handlers fire, and sticky/fixed elements render once (good).
- **Can't capture the hard cases:** inner scroll containers and virtualized lists are **not** expanded. Gmail, Slack, ChatGPT and Notion come out as one viewport. Those are exactly the hard cases.
- **Very tall pages:** past roughly the GPU max texture size (commonly 16384 device px), captures are reported to repeat or go blank. You must chunk with `clip`, and huge base64 payloads cross the protocol.
- Upsides: no 2/s quota, custom width/DPR (2× output on a 1× screen, mobile emulation), media emulation (`prefers-reduced-motion`).

### 2.3 Other APIs worth knowing

- **`chrome.tabCapture`** (`getMediaStreamId` from the SW since Chrome 116, consumed by `getUserMedia` in an offscreen doc, frames read via `MediaStreamTrackProcessor`). No 2/s quota, so it could make a fast mode. Downsides: the docs list its warning as "Read and change all your data on all websites", it shows a tab recording indicator, and frame resolution must be pinned with constraints. Not for v1.
- **DOM rasterization** (html2canvas, modern-screenshot via SVG `foreignObject`): needs no scrolling or quota, but drops cross-origin images, iframes, video, canvas/WebGL and some CSS. Wrong output is worse than slow output. No.
- **HTML-in-Canvas (`drawElementImage`)**: a WICG proposal in origin trial in 2026 (extended; API renames in Chrome 150/155). It lets a page draw its *own* elements into its *own* canvas. It is not an extension capture API. Watch only.
- **getDisplayMedia / Region Capture / Element Capture**: for pages capturing themselves, behind a picker. Not applicable.
- **Firefox `tabs.captureTab/captureVisibleTab` with `rect`** can capture beyond the viewport in one call. It's Firefox-only, so remember it for a future port.

### 2.4 Comparison

| | captureVisibleTab stitch | CDP debugger | tabCapture frames |
|---|---|---|---|
| Install warning | none (`activeTab`+`scripting`) | "all your data" + debugger, **not optional** | "all your data" |
| Visible UX cost | page scrolls visibly | global infobar + resize | recording indicator |
| Speed | 2 frames/s | one shot (chunked) | about 30+ fps |
| Inner scrollers / virtualized lists | **yes** (we scroll them) | no | yes (we scroll) |
| Fixed/sticky | must handle (§3.1) | free | must handle |
| chrome:// visible area | yes | no | no |

### 2.5 Recommendation

- **Primary:** `captureVisibleTab` scroll-and-stitch with `activeTab` + `scripting` + `unlimitedStorage` (zero install warnings), and a smart page agent (§3).
- **Fallback chain**, all on the same backend:
  1. Visible-only capture whenever the agent can't be injected or the page won't scroll (chrome://, Web Store, PDF viewer, scroll-jacking sites), with an explanation to the user.
  2. "Unroll" mode for a broken inner-scroller page (§3.4).
  3. On-demand `optional_host_permissions` for cross-origin iframe scrollers (§3.5).
- **Don't ship CDP in the store build.** Hide the backend behind a `CaptureBackend` interface so a CDP backend can live in a separate dev/enterprise build later.

---

## 3. Hard edge cases

### 3.1 Sticky / fixed elements repeating

Use a capture stylesheet plus data attributes instead of inline-style surgery (see §5.5). The agent then works as follows.

1. **Before the first slice:** convert `position: sticky` → `relative` with `inset: auto`. This is layout-neutral (sticky elements already take flow space) and paints them once at their natural place. `relative` keeps them as the containing block for absolute children. Without `inset: auto`, a sticky `top: 60px` would shift the element.
2. **Classify every `position: fixed` element** in the viewport. Walk all elements, including open and closed shadow roots via `chrome.dom.openOrClosedShadowRoot`.
   - `shell`: covers ≥50% of the viewport or contains the scroll target. Keep it; it's the app layout.
   - `top`: `rect.top < vh/2`. Show in the first slice only.
   - `bottom`: anchored low, e.g. a cookie bar or chat bubble. Hide until the last slice, then show.
   - Zero-size or invisible elements are skipped.
   - Option: "remove floating elements" hides `top` and `bottom` everywhere.
3. **Hide with `opacity: 0 !important`, not `visibility: hidden`.** A child with `visibility: visible` overrides the latter, while opacity can't be undone by descendants.
4. **Header jump** (current GoFullPage 4.4): many sites switch a header to fixed only after scroll > 0, sometimes with a placeholder that changes height. Re-scan for newly fixed elements after every scroll; a MutationObserver on `class`/`style` keeps this cheap. Hide them before capturing, and **re-plan from the actual `scrollY`** if `scrollHeight` changed.
5. `background-attachment: fixed` repeats per slice (GoFullPage 3.11/4.6) → force `scroll` on the elements that have it. Parallax driven by scroll-JS can't be fully fixed; accept it.

### 3.2 Lazy loading, animations, `content-visibility`

- Set `img[loading=lazy]` and `iframe[loading=lazy]` to `eager`, and restore afterwards.
- Elements whose computed `content-visibility` is `auto` → `visible`. Otherwise placeholder sizes (`contain-intrinsic-size`) change the page height mid-capture. Do **not** touch `hidden` (used by `hidden=until-found`).
- **Pre-scroll pass** (default auto: pages over 3 viewports, capped at about 3 s): step through the scroller without capturing, wait about 100 ms per step to trigger IntersectionObserver loaders, then return to the start. Current GoFullPage's FAQ instead asks users to "scroll the length of the page … before engaging", so automating this is a small win.
- Before each frame:
  - Await `img.decode()` for images intersecting the viewport (800 ms budget).
  - Finish finite animations and pause infinite ones: `document.getAnimations()` → `a.effect.getTiming().iterations === Infinity ? a.pause() : a.finish()`. This handles scroll-reveal libraries that would otherwise leave content at opacity 0. Also apply `transition: none`.
  - Wait for 2× `requestAnimationFrame`.
- Pause `<video>`. Add `caret-color: transparent` to the capture stylesheet.
- The 500 ms quota gap is "free" settle time. Scroll right after a capture returns, then wait for `max(settle, limiter)`.

### 3.3 Infinite scroll and virtualized lists

- Freeze the planned range at the start: `min(initialScrollHeight, maxCssHeight)`. Default cap is about 60k CSS px; the user can raise it.
- Don't chase growth unless the user picks "keep loading up to N px".
- Hard caps: 250 slices, plus a total-time cap.
- Virtualized lists (Slack, X, chat UIs) work with stitching because each viewport is real DOM at capture time. CDP's beyond-viewport mode can't do this.
- Disable scroll anchoring (`overflow-anchor: none`) so images loading above the fold don't shift content between frames.

### 3.4 Inner scroll containers (Gmail, Notion, Slack-like apps, LMS shells, ChatGPT/Claude)

Current GoFullPage has done this since 3.0 ("new advanced scrolling algorithm for difficult pages like Gmail"), and the FAQ says "identify inner scrollable elements (like in Gmail…)". 8.6 added "capture improvements for LLM chat UIs". Its method isn't public; ours is below.

**Detection.**
- Candidate scrollers:
  - `overflow-y` is auto/scroll/overlay, and `scrollHeight - clientHeight ≥ 50`;
  - visible area clipped to the viewport ≥ 20% of the viewport (this rejects dropdowns and code blocks).
- Score = `areaFraction × log2(2 + scrollRange/vh)`. Boost the candidate containing the viewport center (`document.elementsFromPoint`).
- Prefer the document if `scrollingElement` has ≥ 25% of a viewport of overflow, unless the inner candidate covers ≥ 50% of the viewport and has more overflow.
- Escape hatch in the popup: "Scroll target: Auto / Page / Pick…". With Pick, the user clicks the region to scroll.

**Reversed scrollers.** Chat UIs often use `flex-direction: column-reverse`. In Chrome their `scrollTop` runs from `-(scrollHeight-clientHeight)` to 0. Derive the range from computed style. Don't probe with `scrollTop = ±1e9`: in Slack-style apps that triggers history loading. (This is plausibly what GoFullPage 8.6 fixed; unverified.)

**Compositing.** The output is the viewport with the scroller expanded in place:
- The band above the scroller comes from the first slice.
- The scroller's client rect is stitched from every slice.
- The band below comes from the last slice and is shifted down by `contentH - clientH`.
- Left/right side regions (nav rails) come from the first slice for the scroller's original height. Below that they're filled with the median color of their bottom pixel row, which works for solid sidebars.
- An editor toggle offers "scroller only" (crop to the scroller). It's cheap because the raw slices are kept (§5.7).

**Unroll fallback** (opt-in, for when scrolling the element fails): set `[data-ps-scroller]{height:auto; max-height:none; overflow:visible}` and `html, body{height:auto; overflow:visible}`, then capture as a document. This works for simple flex shells and breaks JS-sized ones (Gmail), so it can't be the default.

**Nested scrollers** (a scroller inside a scroller): pick only one. Others stay as seen.

### 3.5 Iframes

1. **Decorative iframes** (ads, YouTube, maps) paint into the capture. Nothing to do.
2. **An iframe or frameset is the main scroller** (Javadoc, legacy LMS and enterprise apps; GoFullPage 4.0 added "iframes and framesets").
   - Same-origin: the top agent scrolls `iframe.contentDocument` directly, with no extra permission.
   - Cross-origin needs host permission for that origin. `activeTab` only covers the tab's top origin. Declare `optional_host_permissions: ["https://*/*","http://*/*"]` and request the specific origin from the popup's click handler (a user gesture is required). That mirrors current GoFullPage's on-demand "iFrame" permission ("You cannot pre-emptively grant permission … before the app has encountered a need").
   - Map frames without the `webNavigation` permission (which warns "Read your browsing history"): inject with `allFrames: true` (results carry `frameId`). The top agent then `postMessage`s a random token to each `iframe.contentWindow`, and each child agent echoes the token to the SW with its `sender.frameId`. That gives an iframe-element ↔ frameId map, and the child agent becomes the scroll driver. The frame's rect in the top viewport is the scroller rect for compositing.

### 3.6 Smooth scroll

- Always use `scrollTo({left, top, behavior: 'instant'})`, which overrides CSS `scroll-behavior`.
- Also set `scroll-behavior: auto !important` on html, body and the scroller, because some apps animate with their own JS.
- After scrolling, read back the actual position. If it differs from the target by more than 1 px after 2 rAF, wait up to 300 ms for it to stop moving. If it never reaches the target, the page is scroll-jacked (Adobe Spark-style, per the GoFullPage FAQ). Stop and offer visible-only.

### 3.7 Scrollbars

- Apply the capture stylesheet first, then measure:
  - `scrollbar-width: none` on html, body and `[data-ps-scroller]` (standard, Chrome 121+; when set it overrides `::-webkit-scrollbar` on that element);
  - `::-webkit-scrollbar{display:none}` as a belt-and-braces rule.
- Removing classic Windows scrollbars re-flows the width, which is why measuring must come second (the upstream bug in §1.2).
- macOS overlay scrollbars flash on programmatic scroll, so hide them too.
- If a scrollbar survives (custom JS scrollbars), crop to `clientWidth` instead of `innerWidth`.
- Current GoFullPage keeps shipping scrollbar fixes (3.2, 3.4, 3.9, 8.4, 8.6), so expect a long tail.

### 3.8 devicePixelRatio, zoom, emulation

- `scale = bitmap.width / viewportCssWidth`, measured **per slice** (the upstream approach, §1.3). If it changes mid-capture (window dragged to another monitor, zoom changed), abort.
- Rounding:
  - Place slices at `destY = Math.round((scrollY - y0) * scale)`.
  - Step the scroll by `viewportH - 2` CSS px so each slice overlaps the previous by 2 px. That kills the 1 px white seams at fractional scales (GoFullPage 4.1/4.5/6.4). The later slice overwrites the overlap.
  - `scrollY` can be fractional at non-100% zoom. Use the reported value.
- Pinch zoom (`visualViewport.scale !== 1`) captures only the visual viewport. Warn and ask the user to reset.
- DevTools device mode: the emulated device must be fully on screen (GoFullPage FAQ).

### 3.9 Max canvas size, tiling, memory

- Chromium source (`third_party/blink/renderer/core/html/canvas/canvas_rendering_context_host.cc:138-146`, main branch): `kMaxCanvasArea = 32768 * 8192` (268,435,456 px) and `kMaxSkiaDim = 65535` per side. This is shared by `<canvas>` and `OffscreenCanvas`. Past either limit the canvas is unusable and drawing silently fails, which is current GoFullPage's "blank white page".
- In practice the area limit is 1 GiB of RGBA, and the GPU texture limit (often 16384) pushes big canvases to the slower software path.
- **Tiles are the internal representation:** bands of at most 16384 device px per side and at most 64 M px each. Peak memory is one tile (4K-wide × 8192 ≈ 128 MB) plus one or two decoded slices.
- Decode only the crop you need: `createImageBitmap(blob, sx, sy, sw, sh)`, then call `close()` immediately.
- **Single-file export**, only when it fits:
  - It must stay under the Chromium limits and pass a probe: allocate an `OffscreenCanvas`, `fillRect` its last pixel, `getImageData` → alpha 255.
  - Format limits: WebP ≤ 16383 px per side, JPEG ≤ 65535.
  - Otherwise, offer split files (zip) or PDF.
- Current GoFullPage's FAQ notes that 10+ splits "may not complete". Designing tiles in from the start avoids that cliff.
- Use `navigator.deviceMemory` to shrink tile height on 4 GB machines.
- Store PNG slices as Blobs immediately. Never keep data URLs or decoded slices around.

### 3.10 Restricted pages

Don't hard-code a URL list (upstream `api.js:13-33`). Try `scripting.executeScript`; if it fails, degrade to visible-only, and only map the error to a friendly message.

| Page | Scroll capture? | Visible capture? |
|---|---|---|
| `chrome://`, `chrome-untrusted://`, `devtools://`, `view-source:`, other extensions | no | yes, with activeTab (per docs) |
| Chrome Web Store (`chromewebstore.google.com`, legacy `chrome.google.com/webstore`) | no (scripting blocked) | yes (verify) |
| Built-in PDF viewer | no. GoFullPage can't either (FAQ). A later option is to re-render the PDF with pdf.js in our own page | yes |
| `file://` | only if `chrome.extension.isAllowedFileSchemeAccess()` is on; otherwise deep-link the user to the toggle | same |
| Enterprise `runtime_blocked_hosts` / `DisableScreenshots` | no | no. Show the policy message |

### 3.11 Selected-area / visible / element modes

Current GoFullPage's public materials mention none of these; crop is in its premium editor. This is our differentiation.

- **Visible:** one `captureVisibleTab`, with an optional delay of 3/5/10 s so hover menus can be captured. That fixes the hover limitation the GoFullPage FAQ admits to.
- **Selection:**
  - The agent shows a full-viewport overlay in a closed shadow root. Dragging gives a document-space rect, with auto-scroll while dragging near the edges.
  - Before capturing, remove the overlay and wait 2 rAF.
  - If the rect fits in the viewport: one frame, then crop.
  - Otherwise: the same full-page pipeline with `range = [rect.top, rect.bottom]`, then crop.
- **Element:** hover-highlight and click to pick. Its document rect is the selection; if the element is itself a scroller, use it as the scroll target.

### 3.12 Integrity checks

Before every frame the SW checks:
- the tab is still `active` in the same window;
- its URL is unchanged;
- the window isn't minimized.

Abort and restore when any check fails, when the user presses Esc in the page, or on `pagehide` or port disconnect. Show progress on the action badge, not in the page, so it never shows up in the capture.

---

## 4. What current GoFullPage does that upstream (2016) doesn't — capture side

Sources: the Web Store changelog (8.10, 2026-10-22, 11 M users) and the gofullpage.com FAQ (FAQ text read from the site's JS bundle; the site is a SPA).

| Capability | Evidence | Upstream (2016) |
|---|---|---|
| Inner scrollable elements (Gmail, email clients) | 3.0 (2018-02-27) "new advanced scrolling algorithm for difficult pages like Gmail"; FAQ | only the `body` overflow fix |
| Iframes and framesets | 4.0 (2018-06-10); 8.2 "frame capture fixes for MV3"; Web Store copy "inner scrollable elements as well as embedded iframes" | none |
| Fixed elements don't repeat ("prevent most fixed elements from … repeating") | FAQ; 3.4, 3.13, 3.15 | 200 px overlap trick |
| Fixed header jump | 4.4 (2018-07-16) | none |
| Fixed backgrounds, parallax | 3.11, 4.6; 4.4, 4.7 | none |
| Zoom white-line / blank-section fixes | 4.1, 4.5, 6.4 | partial (scale only) |
| Smooth scroll, scrollbars | 8.4 (2025-02-04), 8.6 (2026-01-14), 3.2/3.4/3.9 | `overflow:hidden` only |
| LLM chat UIs, ChatGPT, Google Search, Twitch, Salesforce Lightning, Behance/BBC, imgur | 8.6, 7.8, 7.1, 4.9, 5.5, 5.7 | none |
| Long-page Chrome 77 blank-end fix | 5.6, 6.4 | n/a |
| Split images viewed in-extension (not N tabs); PDF "full image" exports as one page; 10+ parts "may not complete" | FAQ | N tabs |
| Storage: "HTML5 filesystem and the IndexedDB API", plus a Files/history view | FAQ, 8.10 | temp FileSystem |
| Zero install-time extra permissions; optional **Downloads** and **iFrame** permissions requested on demand and revocable in Options | Web Store copy + FAQ | `activeTab` only |
| MV3 | 8.0 (2024-05-21) | MV2 |

Unknowns:
- 8.9: "bugfix for new URL requirement in Chromium 153". We couldn't find the matching Chromium change. Possibly related to `filesystem:` URLs; unverified.
- Selection, visible-only, delayed and element capture: not mentioned in any public material.

Non-capture features, for context (premium is $12/yr with a 7-day trial; editor since 6.0):
- PNG/JPG/PDF export with paper sizes;
- smart PDF page splitting that avoids cutting text lines (6.6);
- crop, annotations (blur, text, highlight), shapes and emoji;
- URL + datestamp;
- custom filename date tokens, auto-download, download folder, "Save as" option.

---

## 5. Proposed module design (TypeScript)

### 5.1 Processes and responsibilities

```
popup / command / context menu ──► SW: CaptureOrchestrator ──scripting.executeScript──► page: agent.js (ISOLATED world)
                                     │  ▲            Port "ps-capture" (long-lived, typed msgs)        │
                                     │  └──────────────────────────────────────────────────────────────┘
                                     ├─ RateLimiter → tabs.captureVisibleTab
                                     ├─ SessionStore (IndexedDB: sessions, slices, tiles)
                                     └─ tabs.create(editor.html#s=<id>)
editor.html ──► compositor.worker.ts (OffscreenCanvas): slices → tiles → ImageBitmaps (display) + Blobs (export)
offscreen.html (only for headless flows: auto-download / copy-to-clipboard without the editor) → same compositor
```

- **The SW owns timing and truth.** It handles the quota, tab-integrity checks, persistence and opening the editor. It holds no pixels beyond one in-flight Blob.
- **The agent owns the DOM.** It handles measuring, target detection, the capture stylesheet, fixed/sticky handling, planning, scrolling and settling, and restore. It's stateful per session, gets injected on demand (no static content scripts, hence no host warnings), and is guarded against double injection.
- **Stitching happens in a worker owned by the editor page, not in the SW.** Reasons:
  - The editor must decode and display the pixels anyway.
  - SW termination can't lose a half-built canvas.
  - Recompositing (scroller only vs. in frame, show/hide the fixed footer) needs no recapture, because slices persist.
  - There's no canvas `Reason` for offscreen docs (closest: `WORKERS`/`BLOBS`), so we only open one when there's no editor.
- SW keepalive: extension API calls (Chrome 110+) and port messages (Chrome 114+) reset the 30 s idle timer, and we make one every 500 ms. Even so, the session is persisted incrementally, so a dead SW yields a `partial` session the editor can still open.

### 5.2 Manifest (permissions)

```jsonc
{
  "manifest_version": 3,
  "permissions": ["activeTab", "scripting", "unlimitedStorage", "contextMenus", "offscreen"], // none warn
  "optional_permissions": ["downloads"],                    // auto-download / Save-as only; editor uses <a download>
  "optional_host_permissions": ["https://*/*", "http://*/*"], // cross-origin iframe scrollers, per-origin on demand
  "commands": { "capture-full": { "suggested_key": { "default": "Alt+Shift+S" } }, "capture-visible": {} },
  "incognito": "split"   // see 5.8
}
```

### 5.3 Message protocol (`src/shared/protocol.ts`)

```ts
export type Mode = 'full' | 'visible' | 'selection' | 'element';
export interface CaptureOptions {
  mode: Mode; maxCssHeight: number; preScroll: 'auto' | 'on' | 'off';
  floating: 'smart' | 'remove' | 'keep'; target: 'auto' | 'page' | 'pick'; delayMs: number;
}
export interface Rect { x: number; y: number; w: number; h: number }      // CSS px
export interface TargetGeometry {
  kind: 'document' | 'element' | 'frame';
  clientRect: Rect;                // scroller's visible box in top-viewport CSS px
  range: { y0: number; y1: number; x0: number; x1: number }; // scroll offsets covered (reverse-aware)
  content: { w: number; h: number }; // CSS px of content to output
}
// SW -> agent
export type ToAgent =
  | { t: 'prepare'; session: string; opts: CaptureOptions }
  | { t: 'step' }                  // scroll to the next planned position and settle
  | { t: 'pick'; kind: 'selection' | 'element' }
  | { t: 'restore' };
// agent -> SW (each request gets exactly one reply)
export type FromAgent =
  | { t: 'prepared'; viewport: { w: number; h: number }; target: TargetGeometry; estSlices: number; warnings: string[] }
  | { t: 'positioned'; i: number; scrollX: number; scrollY: number; last: boolean; target: TargetGeometry }
  | { t: 'done' }
  | { t: 'picked'; rect: Rect | null }
  | { t: 'restored' }
  | { t: 'error'; code: 'NO_SCROLL' | 'SCROLL_JACKED' | 'PINCH_ZOOM' | 'ABORTED_BY_USER' | 'INTERNAL'; detail?: string };
```

Planning lives in the agent, because only it can see height changes and header jumps. That's why the SW says `step` instead of `scrollTo(x,y)`, and `target` is re-sent on every step.

### 5.4 Orchestrator (`src/sw/orchestrator.ts`)

```ts
const MIN_GAP = 1000 / (chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND ?? 2) + 30;
let lastShot = 0;
async function shoot(windowId: number): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastShot + MIN_GAP - performance.now();
    if (wait > 0) await sleep(wait);
    lastShot = performance.now();
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      return await (await fetch(url)).blob();             // data URL -> Blob, no DOM needed
    } catch (e) {
      if (attempt < 3 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(e))) continue;
      throw e;
    }
  }
}

export async function captureFull(tab: chrome.tabs.Tab, opts: CaptureOptions) {
  const s = await store.createSession(tab, opts);          // status 'capturing'
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['agent.js'] }); }
  catch { return captureVisibleOnly(tab, s, 'RESTRICTED'); } // §3.10 degrade
  const agent = await AgentPort.connect(tab.id!, s.id);     // agent calls runtime.connect({name:'ps-capture'})
  try {
    const prep = await agent.req({ t: 'prepare', session: s.id, opts }, 'prepared');
    await store.patch(s.id, { viewport: prep.viewport, warnings: prep.warnings });
    for (;;) {
      const at = await agent.req({ t: 'step' }, ['positioned', 'done']);
      if (at.t === 'done') break;
      await assertCapturable(tab);                          // active, same URL, not minimized (§3.12)
      const blob = await shoot(tab.windowId);
      await store.addSlice(s.id, { i: at.i, scrollX: at.scrollX, scrollY: at.scrollY, target: at.target }, blob);
      badge(tab.id!, at.i + 1, prep.estSlices);
    }
    await store.patch(s.id, { status: 'complete' });
  } catch (e) {
    await store.patch(s.id, { status: 'partial', error: String(e) });
  } finally {
    await agent.req({ t: 'restore' }, 'restored').catch(() => {}); // agent also self-restores on disconnect
    agent.close(); badge(tab.id!, 0, 0);
  }
  await chrome.tabs.create({ url: `editor.html#s=${s.id}`, index: tab.index + 1, openerTabId: tab.id });
}
```

Open the editor **after** the capture, because opening a foreground tab changes what `captureVisibleTab` sees. Allow one capture at a time globally.

### 5.5 Agent (`src/agent/*.ts`)

```ts
// agent/session.ts — every mutation is reversible by construction
const STYLE = `
html,body,[data-ps-scroller]{scroll-behavior:auto!important;overflow-anchor:none!important;scrollbar-width:none!important}
html::-webkit-scrollbar,body::-webkit-scrollbar,[data-ps-scroller]::-webkit-scrollbar{display:none!important}
*,*::before,*::after{transition:none!important;caret-color:transparent!important}
[data-ps-unstick]{position:relative!important;inset:auto!important}
[data-ps-hide]{opacity:0!important}
[data-ps-bgscroll]{background-attachment:scroll!important}
[data-ps-cv]{content-visibility:visible!important}`;

class CaptureSession {
  private marked = new Set<Element>(); private styleEl?: HTMLStyleElement;
  private saved: { docX: number; docY: number; el?: Element; elTop?: number; elLeft?: number; lazy: HTMLImageElement[] };
  mark(el: Element, attr: string) { el.setAttribute(attr, ''); this.marked.add(el); }
  async prepare(opts: CaptureOptions) {
    this.saved = { docX: scrollX, docY: scrollY, lazy: [] };
    this.styleEl = Object.assign(document.createElement('style'), { textContent: STYLE });
    (document.head ?? document.documentElement).append(this.styleEl);
    for (const el of walkAll(document.documentElement)) {      // incl. chrome.dom.openOrClosedShadowRoot
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky') this.mark(el, 'data-ps-unstick');
      if (cs.backgroundAttachment.includes('fixed')) this.mark(el, 'data-ps-bgscroll');
      if (cs.contentVisibility === 'auto') this.mark(el, 'data-ps-cv');
    }
    for (const img of document.querySelectorAll<HTMLImageElement>('img[loading=lazy]')) { img.loading = 'eager'; this.saved.lazy.push(img); }
    await frames(2);                                            // measure only AFTER scrollbars are gone (§1.2 bug)
    this.target = findScrollTarget(opts.target);                // §3.4
    this.floating = classifyFixed(this.target);                 // shell | top | bottom (§3.1)
    if (needsPreScroll(this.target, opts)) await preScroll(this.target, 3000);
    this.plan = planPositions(this.target, opts);               // step = viewportH - 2, last aligned to range end
  }
  restore() {
    this.styleEl?.remove();
    for (const el of this.marked) for (const a of ['data-ps-unstick','data-ps-hide','data-ps-bgscroll','data-ps-cv','data-ps-scroller']) el.removeAttribute(a);
    for (const img of this.saved.lazy) img.loading = 'lazy';
    this.target?.restoreScroll();
    scrollTo({ left: this.saved.docX, top: this.saved.docY, behavior: 'instant' });
  }
}
// agent/main.ts: port.onDisconnect -> session.restore(); keydown Escape -> post {t:'error',code:'ABORTED_BY_USER'}
```

A `step` does, in order:
1. scroll the target with `behavior: 'instant'`;
2. on slice ≥ 1, hide `top` floats; on the last slice, unhide `bottom` floats;
3. re-scan for newly fixed elements (header jump);
4. finish animations and await decode of visible images;
5. 2 rAF, plus `delayMs`;
6. reply with the actual position and the current `TargetGeometry`.

### 5.6 Planner (`src/agent/plan.ts`, pure and unit-testable)

```ts
export function planPositions(range: { y0: number; y1: number }, viewH: number, overlap = 2, maxCss = 60000): number[] {
  const end = Math.min(range.y1, range.y0 + maxCss);           // y1 = last scroll offset (scrollHeight - clientHeight)
  const step = Math.max(1, viewH - overlap), ys: number[] = [];
  for (let y = range.y0; y < end; y += step) ys.push(y);
  if (ys[ys.length - 1] !== end) ys.push(end);                  // last slice bottom-aligned, overlap absorbs remainder
  return ys;
}
```

Horizontal tiling only applies when `scrollWidth - clientWidth ≥ 16` (generalizing `page.js:70-73`). Column-major or row-major order doesn't matter, but slices in the same row must share a `scrollY`.

### 5.7 Compositor (`src/compositor/*`, a worker, pure math plus OffscreenCanvas)

```ts
export const TILE = { maxSide: 16384, maxArea: 64 * 2 ** 20 };  // conservative vs Chromium 65535 / 268,435,456
export interface Placement { sliceKey: string; src: Rect; dest: { x: number; y: number } } // device px
export function layout(session: CaptureSession, mode: 'inFrame' | 'scrollerOnly'): { w: number; h: number; parts: Placement[]; fills: FillRect[] } {
  // scale per slice = bitmapW / viewport.w (assert constant ±0.5%)
  // document target: src = full viewport (minus surviving scrollbar), dest.y = round((scrollY - y0) * scale)
  // element target (inFrame): top band ← slice0, scroller rect ← every slice, bottom band ← last slice shifted by
  //   (content.h - clientRect.h) * scale, side bands ← slice0 + FillRect(median bottom-row colour)
}
export function planTiles(w: number, h: number): Rect[] { /* upstream api.js:100-147 grid, integer, ≤ TILE limits */ }
// worker: for each tile -> new OffscreenCanvas(tile.w, tile.h); for each intersecting Placement (api.js:150-162 filter)
//   createImageBitmap(blob, src.x, src.y, src.w, src.h) -> drawImage at dest - tile.origin -> bmp.close();
//   postMessage(transferToImageBitmap()) for display; convertToBlob() lazily on export only.
```

The editor treats a capture as a **tiled image document from day one**: stacked tile canvases, with annotation coordinates in output device px plus `scale`. That way 100k px pages and split exports are not special cases.

### 5.8 Storage and hand-off

- **IndexedDB** (`pagesnap` DB) with these stores:
  - `sessions`: the manifest, i.e. url, title, viewport, target geometry, warnings, status, incognito flag;
  - `slices`: `[sessionId, i]` → PNG Blob plus placement metadata;
  - `tiles`: cached composited Blobs, optional;
  - `docs`: editor annotations.
- Blobs in IndexedDB are disk-backed and transactional, and both the SW and pages can reach them. OPFS adds nothing here; keep it for later "project files".
- `unlimitedStorage` prevents eviction. Garbage-collect raw slices N days after the user exports or saves, keeping only the flattened result plus annotations.
- Hand-off is just `editor.html#s=<id>`. The editor opens IndexedDB, spawns the compositor, and streams tiles in top-down so the first screen appears before the whole page is composited.
- **Incognito:** in the default `spanning` mode, captures from incognito tabs land in the regular profile's on-disk IndexedDB. The editor can't open in the incognito window either; that's upstream's old problem (`popup.js:60-72`). Use `"incognito": "split"`, which gives a separate in-memory extension instance for incognito and an editor that opens there. Verify the MV3 split-mode SW behavior in a spike before committing.

### 5.9 Testing

- Build a local fixture site (`test/fixtures/`) covering:
  - sticky header, a 300 px fixed header, fixed footer plus chat bubble, a header that turns fixed on scroll;
  - Gmail-like inner scroller with side rails, a `column-reverse` chat, a virtualized list;
  - lazy images plus `content-visibility:auto`, `scroll-behavior:smooth`, `background-attachment:fixed`;
  - same-origin and cross-origin (second port) iframe scrollers;
  - a 120k px page (tiling), horizontal overflow.
- Run them with headless Playwright: `launchPersistentContext` with `--load-extension`, and `deviceScaleFactor` 1 / 1.25 / 2 plus zoom 110%.
- `activeTab` can't be granted by automation, so a **test manifest** adds `host_permissions: ["<all_urls>"]` (which also satisfies `captureVisibleTab` on normal pages).
- Oracle for static fixtures with no floats: CDP `captureBeyondViewport` from Playwright. Compare the stitched output with a pixel diff allowing ≤ 0.1% mismatch.
- Unit-test `planPositions`, `layout` and `planTiles` as pure functions.

---

## Sources

- Chrome `tabs` API reference (captureVisibleTab, MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND=2 since 92): https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome `debugger` API reference (allowed domains, flat sessions 125+, policy errors): https://developer.chrome.com/docs/extensions/reference/api/debugger
- Permission warnings list (debugger, tabCapture, webNavigation, downloads): https://developer.chrome.com/docs/extensions/reference/permissions-list
- Permissions API (debugger cannot be optional; user gesture; optional host permissions): https://developer.chrome.com/docs/extensions/reference/api/permissions
- Offscreen API (reasons, one doc, runtime-only): https://developer.chrome.com/docs/extensions/reference/api/offscreen
- CDP protocol JSON (captureScreenshot, getLayoutMetrics, setDeviceMetricsOverride, setScrollbarsHidden): https://cdn.jsdelivr.net/npm/devtools-protocol/json/browser_protocol.json
- Chromium canvas limits: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/canvas_rendering_context_host.cc
- Chrome 155 debugger policy changes (secondary): https://www.c-sharpcorner.com/article/chrome-155-chrome-debugger-changes-what-extension-developers-need-to-know
- Debugger infobar UX and suppression (UiPath doc): https://docs.uipath.com/studio-web/automation-cloud/latest/user-guide/debugging-banner-notification-after-extension-upgrade-to-manifest-v3
- HTML-in-Canvas origin trial updates: https://developer.chrome.com/blog/html-in-canvas-ot-changes
- 16384 px texture artifacts on tall CDP screenshots (secondary): https://fullpage-screenshot.ai.studio/long-webpage-screenshot
- GoFullPage Web Store listing and changelog (v8.10): https://chromewebstore.google.com/detail/gofullpage-full-page-scre/fdpohaocaechififmbbbbbknoalclacl
- GoFullPage FAQ (SPA; text extracted from the site bundle): https://gofullpage.com/faq

Unverified / to spike:
- whether the Web Store and PDF viewer allow visible capture;
- MV3 `incognito: "split"` SW behavior;
- tabCapture frame fidelity;
- what GoFullPage 8.9's "Chromium 153 URL requirement" refers to;
- Chrome Split View tabs and `captureVisibleTab`.
