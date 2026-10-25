# pagesnap — plan

Full-page screenshot extension (GoFullPage-style scroll-and-stitch) with an annotation editor that
opens immediately on the result: draw arrows, boxes, underlines and highlights, then `Cmd+C` the
annotated image into an AI chat.

This plan combines the four research docs. Read them for evidence and sources:

| Doc | Covers |
|---|---|
| [01-capture-engine](research/01-capture-engine.md) | Upstream 2016 code walkthrough, MV3 capture APIs, sticky/inner-scroller/lazy-load edge cases, module design |
| [02-stack](research/02-stack.md) | Framework, UI, MV3 specifics (SW lifetime, clipboard, storage, permissions), testing, repo layout |
| [03-annotation-editor](research/03-annotation-editor.md) | Renderer choice, huge-image handling, copy pipeline, tool design, data model, shortcuts |
| [04-feature-set](research/04-feature-set.md) | What GoFullPage does today, competitors, AI-vision size limits, roadmap |

The public `mrcoles/full-page-screen-capture-chrome-extension` repo is the 2016 MV2 baseline. The
GoFullPage on the Web Store is built from a private branch. We port algorithms from the repo, not
behaviour. For current behaviour we use the 8.10 store build and gofullpage.com.

---

## 1. Why build it

- GoFullPage lets you draw for free, but **exporting edits requires a paid plan** ($12/yr).
  Copying from its editor is `Cmd+Opt+E`, and it has no pen, highlighter, underline or numbered steps.
- **A raw full-page image is a bad AI input.** Claude rejects images over 8000 px. A
  1400×30000 page is shrunk to about 120×2576 (Claude) or about 280×6000 (GPT-5.5): unreadable. The
  editor should help you send the part that matters, at a size the model can read.
- The old code is about 700 lines of MV2 (`chrome.extension`, HTML5 FileSystem, `filesystem:` URLs,
  capture driven by the popup). A rewrite beats a port.

## 2. Stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Extension framework | **WXT 0.21.x, pinned exactly** | Vite-based, MV3, HMR, zip/publish, multi-browser. Plasmo is stagnant; CRXJS is the fallback |
| Language | TypeScript strict | |
| Editor/options UI | **React 19** + **Zustand** | No popup: the toolbar click captures directly |
| Annotation rendering | **Own Canvas2D renderer** + `perfect-freehand` | See §2.1 |
| Styling | Tailwind v4 (extension pages only) | Nothing is injected visually into the captured page; progress shows on the toolbar badge |
| Storage | IndexedDB via `idb` + `unlimitedStorage` | Slices, tiles and annotation docs. Job state goes in `chrome.storage.session` |
| Tooling | pnpm, Node 24 LTS, Biome 2 | |
| Tests | Vitest (pure logic + browser mode for canvas), Playwright with bundled Chromium (`channel: 'chromium'`) | Branded Chrome can't side-load unpacked extensions via flags since Chrome 137 |

### 2.1 Resolved disagreement: Konva vs own renderer

The stack research suggested Konva + react-konva. The editor research recommends our own Canvas2D
renderer. **We go with our own renderer**, because:
- one `drawDoc(ctx, doc, view)` function renders both the on-screen viewport and the full-resolution
  export in a worker, so the copied image looks exactly like the screen;
- the editor is one viewport-sized canvas with a camera, drawing ImageBitmap tiles of the page.
  Konva's scene graph adds weight without helping with 30000-px images;
- v0.1 needs only 6 simple shape types.

Konva is the fallback if selection and transform handles slip past the first week. tldraw (licence
key or watermark), Excalidraw (2.5 MB, whiteboard) and marker.js (requires a visible link back unless
paid) are rejected.

### 2.2 Permissions

`activeTab`, `scripting`, `storage`, `unlimitedStorage`, plus `contextMenus` when we add the
right-click "Capture page" item. **No install warning.** We never request `debugger`, `<all_urls>`,
`tabs` or `clipboardWrite`. Download uses an `<a download>` link from the editor page, so no
`downloads` permission. Per-origin host permission is requested at runtime only for capturing
cross-origin iframe scrollers.

## 3. Architecture

```
toolbar click / Alt+Shift+P / context menu
        │
        ▼
Service worker: CaptureOrchestrator ── scripting.executeScript ──►  page agent (isolated world)
  - rate limit: ≤2 captureVisibleTab/s (~530 ms gap), retry on quota  - measure, pick scroll target
  - verify tab/URL before every frame                                 - capture stylesheet (no scrollbars,
  - each slice → IndexedDB immediately                                  no smooth scroll, eager images)
  - opens editor.html#s=<sessionId>                                   - fixed/sticky handling per slice
        │                                                             - scroll + settle + restore
        ▼
Editor page (React)
  - compositor worker (OffscreenCanvas): slices → ≤16384-px tiles → ImageBitmaps
  - viewport canvas + camera; drawDoc() paints tiles + shapes
  - export worker pre-encodes the PNG after each edit → Cmd+C resolves almost instantly
  - hidden <img> of the latest composite swapped in on right-mouse-down → native "Copy image" works
```

Key capture decisions (01-capture-engine §3, §5):
- **Primary:** `captureVisibleTab` scroll-and-stitch. **No CDP or debugger in the store build**:
  it can't be optional, and it shows "Read and change all your data" plus a debugging infobar. Keep a
  `CaptureBackend` interface so a dev build can add it.
- **Sticky/fixed:** unstick sticky elements. Show top-fixed elements only in the first slice and
  bottom-fixed elements only in the last. Re-scan every step for headers that become fixed on scroll.
- **Inner scrollers** (Canvas LMS, Gmail, Notion, AI chat UIs): find the main scroller by score,
  handle reversed chat scrollers, and expand it in place by default, with a "scroller only" option.
- **Before measuring:** eager-load lazy images, force `content-visibility` sections to render,
  finish animations, then pre-scroll with a time limit.
- **Size:** the measured Chromium limits are 65,535 px per side and 268M px of area. We tile at
  ≤16384 px and ≤64M px per tile, and export a single file only when a size check passes. Very large
  pages become multi-part instead of failing.
- **Restricted pages** (chrome://, Web Store, PDF viewer): fall back to a visible-area capture with
  a clear message.

Port from upstream: scale computed from the captured image's width (handles DPR, zoom and emulation),
slices placed at the real scroll position after scrolling, and the tile-grid math. Fix its bugs:
it measures before hiding scrollbars, a failed capture hangs, and listeners pile up on every capture.

## 4. Editor UX

- The result tab opens with the **Arrow tool already active**. Draw within a second of the capture.
- **v0.1 tools:**
  - `A` arrow, `R` rectangle, `U` underline (snaps horizontal), `H` highlighter (multiply blend,
    yellow), `P` pen, `T` text, `V` select/move/delete
  - keys `1–8` pick a colour (red `#FF3B30` default); `[` `]` change stroke width
  - `Cmd+Z` / `Shift+Cmd+Z` undo/redo
- **Sized for AI input:** default sizes are in CSS px multiplied by the capture's DPR (6 px arrows,
  26 px bold text with a white outline, a subtle contrast shadow), so marks survive the model's
  downscaling.
- **Copy and download:**
  - `Cmd+C` copies the annotated PNG via `ClipboardItem` with a Promise<Blob>, so copy is safe even
    if focus changes.
  - Shows a toast with the copied size.
  - **Download PNG** button. The annotation doc autosaves to IndexedDB for re-editing.
- **Undo:** immutable snapshots of the doc, one per finished gesture.

### Open product question: what `Cmd+C` copies by default

The research recommends copying a **smart region** by default: the annotations plus padding, full
width, capped at about 2576 px tall, so it reaches Claude at native resolution. `Shift+Cmd+C` would
copy the full page. The alternative is to always copy the full page and warn when it's too tall for
AI models to read. **Proposed:** copy the full image when it's ≤ ~2576 px tall (most pages, including
the Canvas assignment page). Above that, copy the smart region and say so in the toast. `Shift+Cmd+C`
always copies the full page.

## 5. Roadmap

**v0.1 — MVP: GoFullPage, but the editor is free and Cmd+C works**
1. Scaffold: WXT + React + Tailwind + Biome + Vitest + Playwright, with fixture pages (bands, sticky
   header, fixed footer, inner scroller, lazy images, huge).
2. Capture engine: orchestrator, page agent, planner (unit-tested), slices in IndexedDB, compositor
   worker, multi-part split, visible-area fallback.
3. Editor shell: tiled viewport with pan/zoom (fit-width default), right-click Copy image, Download.
4. Tools: arrow, rect, underline, highlighter, pen, text, select; undo/redo; Cmd+C copy with
   pre-encoded export.
5. E2E pixel tests on the fixtures, plus a manual checklist: toolbar click, shortcut, paste into
   ChatGPT/Claude/Gemini, and the Canvas LMS page.

**v0.2 — Built for pasting into AI**
- Copy a section (box-select, then Cmd+C)
- "Copy for AI" slices (≤1280×1900 with overlap, copied one after another)
- Numbered step markers
- Redact (solid or pixelate)
- Crop
- Region and visible capture modes
- URL/title context strip and "copy context as Markdown"
- Spotlight
- Optional auto-copy right after capture

**Later**
- Automatic redaction suggestions from the page's own text (emails, student IDs)
- Markdown of the text under each mark
- Highlights that snap to text lines
- Capture a picked page element
- Capture history
- JPG/WebP export, Edge/Firefox builds

Not planned: cloud/share links, accounts, video, emoji/stickers, "send to AI" injectors.

## 6. Risks to spike early

- Right-click "Copy image" swap on the native context menu: verify manually on macOS and Windows.
- Clipboard write after the editor tab loses focus. Measured OK at a 3 s delay; verify in branded
  Chrome.
- Inner-scroller detection on the user's real targets: Canvas LMS, ChatGPT/Claude chat pages.
- WXT 0.x breaking changes: pin exact versions.
