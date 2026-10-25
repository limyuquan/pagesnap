# Page Snap: contracts, ownership and conventions

Phase 0 output. Three agents now build in parallel in this tree, each in its own directories:

- **A**: capture engine
- **B**: editor engine (renderer, tools, export)
- **C**: editor UI and design

This file is the source of truth for the boundaries between them. [PLAN.md](PLAN.md) holds the
product decisions, and the research docs hold the reasoning behind them.

Product name: **Page Snap**. Package name: `pagesnap`.

---

## 1. Commands

All of these were verified passing at the end of Phase 0 (Node 25.6, pnpm 10.0, macOS).

| Command | What it does |
|---|---|
| `pnpm install` | Installs dependencies and runs `wxt prepare` (generates `.wxt/` types) |
| `pnpm dev` | WXT dev build with HMR into `.output/chrome-mv3-dev`. Load it unpacked via `chrome://extensions` (web-ext isn't installed, so no browser is auto-launched) |
| `pnpm build` | Production build into `.output/chrome-mv3`. No host permissions, no test hooks |
| `pnpm build:e2e` | E2E build into `.output/chrome-mv3-e2e`. Adds `<all_urls>` and the `__pagesnap` test hooks |
| `pnpm zip` | Store zip in `.output/pagesnap-<version>-chrome.zip` |
| `pnpm typecheck` | `wxt prepare`, then `tsc` on `tsconfig.json` (extension code and Vitest tests) and on `tsconfig.node.json` (configs, scripts and Playwright) |
| `pnpm lint` / `pnpm format` | Biome check, or check with `--write` |
| `pnpm test` | All Vitest projects: `unit` (Node) and `browser` (headless Chromium). About 2 s |
| `pnpm test:unit` / `pnpm test:browser` | Run a single Vitest project |
| `pnpm test:e2e` | `build:e2e`, then `playwright test` (it starts the fixture server itself) |
| `pnpm check` | `typecheck` + `lint` + `test`. **Must pass before you hand work back** |
| `node scripts/serve-fixtures.mjs` | Fixture server on `http://127.0.0.1:4321/` (index page lists the fixtures) |

If Playwright's browser is missing: `pnpm exec playwright install chromium`. That gives the bundled
Chromium 156, which both Vitest browser mode and e2e use.

## 2. Pinned versions

All versions are exact (`.npmrc` has `save-exact=true`).

| Package | Version | | Package | Version |
|---|---|---|---|---|
| wxt | **0.21.4** | | vitest, @vitest/browser-playwright | 5.0.5 |
| @wxt-dev/module-react | 1.2.2 | | @playwright/test, playwright | 1.64.1 (Chromium 156.0.8078.4) |
| vite | 8.3.5 | | @biomejs/biome | 2.6.3 |
| react, react-dom | 19.3.1 | | typescript | 7.0.2 |
| zustand | 5.0.16 | | tailwindcss, @tailwindcss/vite | 4.3.3 |
| idb | 8.0.4 | | fake-indexeddb | 6.2.6 |
| perfect-freehand | 1.2.3 | | pngjs (+ @types/pngjs) | 7.0.0 (6.0.5), for decoding PNGs in e2e pixel assertions |

## 3. Ownership map

Only edit files you own. If you need a change elsewhere, write it under §8 (contract change log)
and tell the orchestrator. The one exception: everyone may add their own test files, using their
prefix (§7).

| Path | Owner | Notes |
|---|---|---|
| `src/entrypoints/background.ts` | A | Service worker. Already wires the action click, the `_execute_action` command (Alt+Shift+P), the context menu and the e2e hook. Each of them calls `startCapture(tab)` |
| `src/entrypoints/agent.ts` | A | WXT unlisted script → `/agent.js`. Injected with `scripting.executeScript` |
| `src/capture/**` | A | Orchestrator, agent internals, planner. `startCapture` lives in `orchestrator.ts` |
| `src/compositor/**` | A | Slices → display tiles. `index.ts` exports `openCaptureSource` and `planDisplayTiles` |
| `src/entrypoints/editor/` | C | `index.html` and `main.tsx` only. They mount `<App/>` and import `@/styles/app.css` |
| `src/editor/App.tsx`, `src/editor/ui/**`, `src/styles/**` | C | Shell, toolbar, toasts, colour/size pickers, empty and error states |
| `src/entrypoints/options/` | C | Minimal settings page (uses `shared/settings.ts`) |
| `src/editor/engine/**` | B | Store, renderer (`drawDoc`), tools, history, export worker, clipboard, `EditorCanvas`, shortcuts |
| `src/shared/**` | Phase 0 | Frozen contracts. Change them only through §8 |
| `public/icon/*.png` | C | Placeholder icons for now (16/32/48/128) |
| `tests/fixtures/pages/*.html` | Phase 0 | Agents may **add** fixtures. Don't change existing ones without §8 |
| `tests/e2e/fixtures.ts`, `playwright.config.ts`, `vitest.config.ts` | Phase 0 | Shared harness. Add helpers through §8 |
| `tests/unit/`, `tests/browser/`, `tests/e2e/` | everyone | Each agent adds its own files with its prefix |

C imports engine code from `@/editor/engine` only, which is the barrel in `src/editor/engine/index.ts`.
B doesn't style UI chrome. C doesn't touch the canvas internals.

## 4. Data contracts (`src/shared/`)

| File | Contents | Runs in |
|---|---|---|
| `types.ts` | Geometry, `CaptureSession`, `SliceMeta`, `BaseLayout`/`Placement`, `TileMeta`, status, errors and warnings | anywhere |
| `annotations.ts` | `AnnotationDoc`, `Shape` union, palette, default sizes, `emptyDoc`, `migrateDoc` | anywhere |
| `db.ts` | IndexedDB schema and typed helpers | SW, pages, workers |
| `protocol.ts` | SW ↔ agent messages, port name, agent path, storage key names | anywhere (types/consts) |
| `handoff.ts` | `editorUrl`, `parseEditorHash`, status mirror (`publishSessionStatus`, `watchSessionStatus`, `waitForFinalSession`) | SW, pages (uses `wxt/browser`) |
| `source.ts` | `CaptureSource` / `OpenCaptureSource`, the A ↔ editor display boundary | types |
| `composite.ts` | `compositeRegion`, `partsInRegion`: the only code that turns slices into base pixels | SW, pages, workers |
| `settings.ts` | `Settings`, defaults, `getSettings`/`updateSettings`/`watchSettings` | SW, pages (uses `wxt/browser`) |
| `limits.ts` | Canvas limits, tile sizes, `AI_MAX_LONG_EDGE_CSS = 2576`, capture throttle | anywhere |
| `ids.ts` | `newId()` (shapes), `newSessionId()` (time-sortable) | anywhere |
| `e2e.ts` | `IS_E2E`, `BackgroundTestHook`, `EditorTestHook` and their global declarations | anywhere |
| `testing/synthetic.ts` | `seedSyntheticSession()` creates a fake `ready` capture in IDB | SW, pages, workers |

### 4.1 Units

- **CSS px**: page layout pixels.
- **Image px**: pixels of the stitched output. `image = css * session.dpr`.
- **Bitmap px**: pixels of one slice PNG. Slices are placed 1:1, so bitmap px have the same scale as image px.

`session.dpr` is **measured** as `slice bitmap width / viewport CSS width`, not taken from
`window.devicePixelRatio`. Annotation shapes are stored in image px. Tool defaults are given in CSS px
and multiplied by `dpr` when a shape is created. The camera's `zoom` is in CSS px (screen) per image px,
so 100% is `1 / dpr`.

### 4.2 Capture session lifecycle

```
capturing ──► ready     (all slices stored, layout final)
          ├─► partial   (stopped early; ≥1 slice; layout final for what exists; error set)
          └─► error     (no usable slice; error set)
```

- Only A writes `sessions` and `slices`. Use `putSession`/`updateSession`/`putSlice`, and call
  `publishSessionStatus(session)` after every session write.
- `layout` is the complete recipe for the base image:
  1. fill `background`;
  2. draw every `fills` entry;
  3. draw `parts` **in order**, each one placing a `src` crop of slice `slice` at `dest`, 1:1, with later parts overwriting earlier ones.

  A builds it, including the inner-scroller "expand in place" bands and fills from 01 §3.4.
  Nobody else interprets slices.
- Retention uses `pruneSessions({ keep, maxAgeMs })` from `settings.storage`. A runs it on `runtime.onStartup`.

### 4.3 Storage

IndexedDB database `pagesnap`, version 1, defined in `db.ts`:

| Store | Key | Value | Writer |
|---|---|---|---|
| `sessions` | `id` (index `by-createdAt`) | `CaptureSession` | A |
| `slices` | `[sessionId, index]` (index `by-session`) | `{ sessionId, index, blob }` | A |
| `docs` | `sessionId` | `AnnotationDoc` | B (debounced autosave) |

`chrome.storage.session` keys (`protocol.ts`):
- `session-status:<id>`: a `SessionStatusSnapshot`, written by A and watched by B.
- `active-capture`: the running capture's id, so only one capture runs at a time. A only.

`chrome.storage.local` key `settings` holds `Settings` (`settings.ts`). Stored values are deep-merged
over `DEFAULT_SETTINGS`, so adding a field is backward compatible.

### 4.4 SW ↔ agent (A internal, typed in `protocol.ts`)

1. The SW injects `/agent.js` with `executeScript({ target: { tabId }, files: [AGENT_SCRIPT_PATH] })`.
   If that throws, the page is restricted: fall back to a visible-area capture with
   `warnings: VISIBLE_ONLY`.
2. The agent connects a port named `pagesnap/agent`. The SW sends `ToAgent` requests (`prepare`,
   `step`, `restore`), each with an `id`, and the agent answers each with one `FromAgent` reply
   carrying `re`. Unsolicited `{ t: 'abort' }` messages report Esc or pagehide.
3. The agent plans: on each `step` it scrolls, settles and replies `positioned` or `done`. The SW
   rate-limits `captureVisibleTab` (`CAPTURE_MIN_GAP_MS`), checks the tab hasn't changed, and stores
   each slice right away.
4. The agent restores the page on `restore`, port disconnect, Esc and pagehide, and restoring is
   idempotent. It never renders anything visible into the page. Progress goes on the action badge.

### 4.5 SW → editor hand-off (`handoff.ts`)

- A opens `editorUrl(id)` (`chrome-extension://<ext>/editor.html#s=<id>`) next to the captured tab
  once the session is **final**. Opening the tab earlier would change what `captureVisibleTab` sees.
- B reads the id with `parseEditorHash(location.hash)` and calls
  `waitForFinalSession(id, { onProgress })`:
  - It resolves at once for finished sessions.
  - It follows the `storage.session` mirror while the capture runs, which covers a reloaded or early editor.
  - It falls back to IDB when the mirror is gone.
  - It rejects with `NO_SESSION` for unknown ids.
- `startCapture(tab)` (A, `src/capture/orchestrator.ts`) resolves with the session id once the
  session is final and the editor is open. A second call during a capture returns the running
  capture's id.

### 4.6 A ↔ editor boundary

**Display** (`source.ts`, implemented by A in `src/compositor/index.ts`):

```ts
interface CaptureSource {
  readonly session: CaptureSession;   // final: ready | partial
  readonly tiles: readonly TileMeta[]; // row-major, cover session.image exactly, ≤ 2048 tall, ≤ 8192 wide
  getTileBitmap(index: number, signal?: AbortSignal): Promise<ImageBitmap>; // caller owns + closes
  dispose(): void;
}
openCaptureSource(sessionId): Promise<CaptureSource> // rejects NO_SESSION | NOT_FINAL | CAPTURE_FAILED
```

The Phase-0 `openCaptureSource` is a working main-thread baseline built on `compositeRegion`, so B
and C can run against real (or synthetic) sessions today. A may move the work into a worker, add
caching or prefetching, and replace the internals, but must keep the signature and semantics. B
keeps an LRU of about 6 bitmaps around the viewport and closes the ones it evicts.

**Export (full-resolution base pixels)**: B's export worker doesn't use tiles. Given `sessionId`, it
calls `getSession(id)` and then
`compositeRegion(ctx, session.layout, region, scale, (i) => getSliceBlob(id, i))`, and draws the doc
on top with the same `drawDoc`. IDB is available in workers. Both sides go through `composite.ts`,
so the display and the export always place pixels identically. If the export region is larger than
the canvas limits in `limits.ts`, B splits it or downscales.

### 4.7 Annotation document (`annotations.ts`)

```ts
AnnotationDoc { v: 1; sessionId; rev; image: { w, h, dpr }; shapes: readonly Shape[]; crop: null; updatedAt }
Shape = arrow{a,b,width,bend,heads} | rect{box,width,fill} | underline{a,b,width}
      | highlight{a,b,thickness,opacity} | pen{pts:[x,y,p][],size,marker} | text{at,text,size,weight,maxW?,style}
      // every shape: { id, kind, color, shadow }
```

- All values are in image px. Docs and shapes are immutable. `rev` increases by 1 on each commit
  and serves as the export-cache key and the autosave trigger.
- Array order is z-order, and highlights are drawn in their own pass underneath.
- Selection, camera and tool state are **not** in the doc.
- Persistence: B autosaves to the `docs` store, debounced. Load through `migrateDoc` and fall back to
  `emptyDoc(session.id, { ...session.image, dpr: session.dpr })`.
- Defaults (`DEFAULT_SIZES_CSS`, `SIZE_STEPS_CSS`, `PALETTE`, red `#FF3B30`, highlighter
  `#FFD60A` at 0.45) follow 03 §5.

### 4.8 Editor store, B ↔ C (`src/editor/engine/store.ts`)

`useEditorStore` is a Zustand store. C reads it with selectors and calls `state.actions.*`. C never
calls `setState`. The shape:

| State | Meaning |
|---|---|
| `sessionId`, `session`, `source` | The loaded capture (`session`/`source` are set once it's final) |
| `load` | `idle` / `waiting {progress}` / `loading` / `ready` / `error {code: NO_SESSION \| CAPTURE_FAILED \| LOAD_FAILED, message}` |
| `doc`, `canUndo`, `canRedo` | The present document and history flags |
| `selection`, `editingTextId` | Selected shape ids; the text shape being edited (single-key shortcuts are off while set) |
| `tool`, `styles` | Active tool (`'select'` or a shape kind; defaults to `'arrow'`); per-tool `{ color, size (CSS px) }` |
| `camera`, `viewport` | `{x, y, zoom}` (image px at the top-left, CSS px per image px); canvas size in CSS px |
| `copy` | `idle` / `copying` / `copied {request, outcome: full \| smart \| viewport, size, tall}` / `failed {reason: not-focused \| error}` |
| `download` | `idle` / `saving` / `saved {filename, size}` / `failed` |

Actions:
- `init(id)`
- `setTool`, `setColor`, `setColorIndex(0–7)`, `setSize(css)`, `stepSize(±1)`
- `undo`, `redo`
- `setSelection`, `selectAll`, `clearSelection`, `deleteSelection`
- `setCamera`, `zoomBy(factor, anchor?)`, `fitWidth`, `zoomActual`
- `copy('default' | 'full')`: **call it synchronously inside the click or keydown handler.** B
  creates the `ClipboardItem` with a Promise<Blob> before returning.
- `download()`, `dismissStatus()`

Selectors: `selectActiveStyle`, `selectZoomPercent`, `selectIsReady`. Constants: `TOOLS`,
`TOOL_SHORTCUTS`, `TOOL_LABELS`, `DEFAULT_STYLES`.

Colour semantics: all tools share one colour except the highlighter, which keeps its own (yellow by
default). `setColor` and `setSize` also apply to the current selection.

Also exported from the engine barrel:
- `<EditorCanvas className?>`: fills its parent, which C must make `position: relative` and give a
  size. B owns everything inside it, including the text `<textarea>` overlay and the hidden composite
  `<img>` used for right-click "Copy image".
- `useEditorShortcuts()`: C calls it once in `App`. B handles every key in 03 §8 (v0.1 subset)
  through the store actions.

B may add `_`-prefixed internal state and actions. Anything else follows §8.

### 4.9 Copy semantics (approved)

- `copy('full')` (Shift+Cmd+C): the whole annotated image. Outcome `full`.
- `copy('default')` (Cmd+C):
  - If `session.css.h ≤ settings.copy.fullMaxCssHeight` (2576): the whole image. Outcome `full`.
  - Otherwise, with annotations, the **smart region**. Outcome `smart`:
    - Start from the union bbox of the shapes (including stroke width), padded vertically by
      `max(160 CSS px × dpr, 10% of bbox height)`.
    - Use the full image width, clamped to the image.
    - Cap the height at `2576 × dpr` image px, centred on the bbox.
    - If the bbox alone is taller than the cap, copy the bbox and set `tall: true`.
  - Otherwise, with no annotations, the current view, at full width and capped the same way.
    Outcome `viewport`.
- Clipboard pixel density follows `settings.copy.resolution`. The default `css` copies at 1 image px
  per CSS px. Download is always native resolution, full image.
- **C's toast must say what was copied.** For `smart` and `viewport`, say it was the marked-up region
  (or the current view) because the page is tall, and that Shift+⌘C copies the full page. Show the
  pixel size. For `failed: not-focused`, show "Click the page, then ⌘C again".

### 4.10 Test hooks (e2e builds only)

They're gated on `import.meta.env.MODE === 'e2e'`, and production builds strip them (verified: no
`__pagesnap` in `.output/chrome-mv3/background.js`).
- SW `globalThis.__pagesnap: BackgroundTestHook`:
  - `startCapture(tabId)` calls A's `startCapture(await tabs.get(tabId))`.
  - `seedSyntheticSession(opts)` writes a synthetic `ready` session.
- Editor `window.__pagesnapTest: EditorTestHook`, owned by B:
  - `isReady()`
  - `exportPng('default' | 'full')` returns a base64 PNG at **native** resolution.

The DOM contract kept by C: the editor root has `data-testid="editor-root"` and
`data-session="<id>"`. The engine canvas has `data-testid="editor-canvas"`.

## 5. Fixture pages (`tests/fixtures/pages/`)

Every page is deterministic, makes no network requests, and exposes `window.__fixture` with the
values you need for assertions. Bands use the 8-colour cycle `#e6194b #3cb44b #4363d8 #f58231
#911eb4 #46f0f0 #f032e6 #bcf60c`, which matches `bandColor()` in `shared/testing/synthetic.ts`.

| Page | Size (CSS px) | What it checks |
|---|---|---|
| `bands.html` | 8000 tall; 16 × 500 bands, 2 px black top rule, labels | Seams, overlap, placement |
| `short.html` | 400 tall, no scroll | Single slice |
| `wide.html` | 3000 × 2000 grid of 500 px cells | Horizontal overflow (columns) |
| `huge.html` | 70,000 tall; 70 × 1000 bands | Beyond 65,535 image px at DPR 2: tiling, multi-part export |
| `sticky-header.html` | 5064; 64 px sticky header and a sticky side panel | Header and panel appear exactly once. `?jump=1`: header becomes `fixed` after scrollY > 100 (header jump) |
| `fixed-footer-and-chat-bubble.html` | 6056; fixed top bar, cookie footer, chat bubble | Top bar only in the first slice; footer and bubble only in the last |
| `inner-scroller.html` | Body doesn't scroll; `#content` scrolls (~4300 px) | Canvas LMS shell: fixed dark global nav, breadcrumb, course nav, yellow notice, rubric, comments, `#end-marker` |
| `lazy-images.html` | ~12,900 tall | `loading=lazy` images, IntersectionObserver loader (250 ms delay), scroll-reveal fades, `content-visibility:auto` sections that grow. `__fixture.allImagesLoaded()` |

## 6. Testing

- **Unit** (`tests/unit/**/*.test.ts`, Node):
  - `wxt/browser` is WXT's in-memory fake browser.
  - IndexedDB comes from `fake-indexeddb` (`tests/unit/setup.ts` resets both after each test).
  - Use it for pure logic: the planner, layout, history, smart-region maths, store reducers.
- **Browser** (`tests/browser/**/*.test.ts`, Vitest browser mode, headless Chromium):
  - Real canvas, `OffscreenCanvas`, `createImageBitmap` and IndexedDB.
  - Only the `@/` alias is available. WXT's plugin doesn't work in browser mode, so code under test
    there must not import `wxt/browser`.
  - `seedSyntheticSession` is the quickest way to get a realistic session.
- **E2E** (`tests/e2e/**/*.spec.ts`, Playwright): import `test`/`expect` from `tests/e2e/fixtures.ts`.
  - Fixtures:
    - `context`: the extension loaded into bundled Chromium; headless unless `HEADED=1`.
    - `serviceWorker`, `extensionId`.
    - `pagesnap`, with helpers:
      - `fixtureUrl(name)`, `openFixture(name)`, `tabIdOf(page)`;
      - `capture(page)` → `{ sessionId, editor }`: drives `__pagesnap.startCapture` and waits for the editor tab;
      - `seedSession(opts)`, `openEditor(id)`.
  - Options: `test.use({ dpr: 1 })` (default 2) and `windowSize` (default 1280 × 900).
  - **DPR caveat (measured):**
    - Playwright's `deviceScaleFactor` emulation doesn't affect `captureVisibleTab`, which still
      returns 1x bitmaps.
    - So the fixture sets `--force-device-scale-factor` and turns viewport emulation off.
    - The viewport is then the window minus the browser UI (1280 × 813 for the default window).
      Read `innerWidth`/`innerHeight` from the page instead of assuming a size.
  - **Permission caveat (measured):** `captureVisibleTab` rejects with only `http://localhost/*` host
    permissions ("Either the '<all_urls>' or 'activeTab' permission is required"), so the e2e
    manifest uses `<all_urls>`.
  - Pixel assertions: export via `__pagesnapTest.exportPng()` or read slices, decode with `pngjs`,
    and compare colours at known band offsets. Don't compare screenshots.
  - **Parallel agents:** run e2e with `PAGESNAP_E2E_ID=a|b|c pnpm test:e2e`. The build goes to
    `.output/chrome-mv3-e2e-<id>` and results to `test-results-<id>/`, so you don't overwrite each
    other. The fixture server on :4321 is shared and reused.

## 7. Conventions

- **Format and lint:** Biome 2 (`biome.json`): 2 spaces, single quotes, line width 100, trailing
  commas, organised imports, the `recommended` preset, and `noFloatingPromises` as an error (use
  `void` deliberately). Markdown, `public/` and fixture pages are excluded from Biome.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` (use `import type`). No Node types in extension code.
- **Imports:**
  - Use the `@/` alias for `src/`.
  - WXT auto-imports are **off**. Import explicitly from `wxt/browser`,
    `wxt/utils/define-background`, `wxt/utils/define-unlisted-script` and so on.
  - Use `browser`, not `chrome`, in code.
- **Naming:** files are `camelCase.ts`, React components are `PascalCase.tsx`. Types and interfaces
  are PascalCase, constants are `UPPER_SNAKE`.
- **Test file prefixes:** `capture.*` (A), `engine.*` (B), `ui.*` (C) and `shared.*` (Phase 0), e.g.
  `tests/unit/capture.plan.test.ts` or `tests/e2e/engine.copy.spec.ts`.
- **Permissions:** don't add any (PLAN §2.2). In particular no `tabs`, `<all_urls>` (outside e2e),
  `clipboardWrite`, `debugger`, `downloads` or `offscreen`.
- **Nothing visible is ever injected into a captured page.**
- Don't commit. The orchestrator commits.

## 8. Changing a contract

Changing anything in `src/shared/**`, the store contract in `store.ts`, the harness, or an existing
fixture works like this:

1. Add an entry below: date, who, what, why, and who is affected.
2. Make the change backward compatible where you can, e.g. add optional fields.
3. Bump `DB_VERSION` (with a new `upgrade` step) or `DOC_VERSION` (with a `migrateDoc` step) for
   storage-shape changes.
4. Tell the orchestrator, so the affected agents learn about it.

Log:
- *(empty)*

## 9. Decisions made in Phase 0

1. **The agent is a WXT unlisted script** (`src/entrypoints/agent.ts` → `/agent.js`), not a
   `registration: 'runtime'` content script. It never appears in the manifest and is injected only
   through `executeScript({ files })`, with a long-lived port for messages.
2. **Base pixels for export come from slices plus a placement table** (`session.layout`), not from
   tiles. A single shared `compositeRegion` serves both display and export, so they always match.
   The export worker reads IDB directly and needs nothing from the main thread.
3. **The status mirror lives in `chrome.storage.session`**, with IDB as the source of truth.
   `waitForFinalSession` hides both from the editor.
4. **Session ids are time-sortable** (`<base36 ms>-<8 random>`), and shape ids are 8-char base36.
5. **Tool styles are per tool**, with one shared ink colour and a separate highlighter colour.
   Sticky defaults live in editor state, not in the doc. 03 §7.1 had put `doc.style` in the doc.
6. **`settings.copy.resolution` defaults to `css`** (copies at 1x), per 03 §5. Download is native.
7. **`settings.capture.maxCssHeight` defaults to 80,000**, up from the research's ~60k, so
   `huge.html` (70k) exercises the multi-part path instead of truncation.
8. **WXT auto-imports are off**, so imports are explicit for three agents working in parallel.
9. **`pnpm test` runs both Vitest projects.** Browser mode is fast enough (under 1 s) that there's
   no reason to split them in `check`.
10. **Two tsconfigs**, so extension code doesn't see Node globals.
11. **A Phase-0 baseline `openCaptureSource`** works on the main thread. It isn't a stub, so B and C
    aren't blocked on A.
12. **The options page opens in a tab** (`open_in_tab`).

### Deviations from PLAN.md and the research

- **E2E host permission is `<all_urls>`, not `http://localhost/*`.** `captureVisibleTab` requires
  `<all_urls>` or activeTab; I verified that the localhost permission alone is rejected. This applies
  to e2e builds only. The production manifest has no host permissions.
- **E2E DPR uses `--force-device-scale-factor`, not Playwright `deviceScaleFactor`** (§6).
  Emulation produced 1x captures.
- **Versions:**
  - pnpm 10 instead of 11 (10 is installed);
  - Node 25 locally (`.nvmrc` says 24, `engines >= 22`);
  - Vitest 5.0.5 instead of 4.1 (current stable; the WXT plugin works with it);
  - TypeScript 7.0.2 works with WXT's generated tsconfig (it has no `baseUrl`).
- **No `capture-visible` command yet.** PLAN v0.1 doesn't list a visible-area mode, and it can be
  added without a contract change. Only `_execute_action` (Alt+Shift+P) and a "Capture full page"
  context menu item (page and action contexts) are registered.
- **`web-ext` isn't installed,** so `pnpm dev` doesn't auto-launch a browser. Branded Chrome 137+
  can't side-load through flags anyway. Load `.output/chrome-mv3-dev` unpacked.

## 10. Phase-0 placeholders to replace

| File | Owner | State |
|---|---|---|
| `src/capture/orchestrator.ts` `startCapture` | A | Throws "not implemented" |
| `src/entrypoints/agent.ts` | A | Empty main |
| `src/compositor/index.ts` | A | Working main-thread baseline; replace the internals freely |
| `src/editor/engine/store.ts` | B | Contract and stub: simple setters work; init, undo/redo, copy, download and camera are no-ops |
| `src/editor/engine/EditorCanvas.tsx`, `shortcuts.ts` | B | Stubs |
| `src/editor/App.tsx`, `src/entrypoints/options/main.tsx`, `src/styles/app.css`, `public/icon/*` | C | Placeholders |
