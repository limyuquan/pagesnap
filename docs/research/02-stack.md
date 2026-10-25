# 02 - Modern stack and tooling for pagesnap

Status: research, 2026-10-25. All versions were checked on the web on that date (sources at the end).
Scope: build framework, UI framework and canvas library, the MV3 platform rules we will hit, testing,
tooling, repo layout, scaffold commands and manifest permissions.

---

## TL;DR

| Concern | Pick | Runner-up / note |
|---|---|---|
| Extension framework | **WXT 0.21.x** (Vite-based), pinned exactly | CRXJS 2.7 if we ever want "just a Vite plugin" |
| UI | **React 19.3** on every page | Svelte 5 + svelte-konva is the only serious alternative |
| Canvas / annotations | **Konva 10 + react-konva 19.3** | Fabric 7.4 is fine but harder to use from React; tldraw/Excalidraw rejected |
| State | Zustand, with our own undo stack of serialisable annotation JSON | |
| Styling | **Tailwind CSS v4.3** via `@tailwindcss/vite` | Only on extension pages. Nothing gets injected into captured pages |
| Blob storage | **IndexedDB** (via `idb`) + `unlimitedStorage` | OPFS later if we need streaming writes |
| Package manager | **pnpm 11** on Node 24 LTS (WXT 0.21 needs Node >= 22) | Bun works but is not needed |
| Lint/format | **Biome 2.x** + `tsc --noEmit` (TS strict) | ESLint+Prettier not needed for a React/TS codebase |
| Unit tests | **Vitest 4.1** + `WxtVitest()` fake browser; Vitest Browser Mode for canvas code | |
| E2E | **Playwright** `launchPersistentContext` + `channel: 'chromium'` (new headless), e2e build mode | Branded Chrome/Edge cannot side-load since Chrome 137 |
| Permissions | `activeTab, scripting, storage, unlimitedStorage, contextMenus` | **No install warning at all** |

---

## 1. Extension framework

### Comparison (state as of Oct 2026)

| | WXT | Plasmo | CRXJS (`@crxjs/vite-plugin`) | Plain Vite + hand-written manifest |
|---|---|---|---|---|
| Latest | wxt **v0.21.4** (11 Aug 2026); sub-packages released 4 Oct 2026 | core **v0.90.5** (~Sep 2025). No release in over a year | **v2.7.0** (19 Jun 2026) | n/a |
| Maintenance | Active, frequent releases, still 0.x (breaking minors, so pin it) | Slowing down. 300+ open issues, team focused on paid products (Itero/BPP), repo still says "alpha" | Active again since mid-2025 under new maintainers; Vite 3-8 tested in CI | We would maintain it |
| Bundler | Vite (Vite 8 / Rolldown era) | Parcel | Vite plugin (Vite 8 support in 2.6.1) | Vite |
| MV3 | First-class; MV2 also available | Yes | MV3 only | Yes, by hand |
| HMR: extension pages | Vite HMR | React HMR | Vite HMR | Needs a multi-page config; no auto-reload of the extension |
| HMR: content scripts | Reloads just that script (in dev, scripts are registered at runtime through `scripting`) | Content-script UI HMR | Real HMR, including MAIN-world scripts (2.7.0) | Manual reload |
| HMR: service worker | Reloads that part individually, not the whole extension | Full reload | Full extension reload | Manual |
| Multi-browser | `wxt -b firefox|edge|safari|...`; `import.meta.env.BROWSER`; per-browser manifest | Chrome-first; Firefox MV3 experimental | Possible but manual (it is a Chrome plugin) | Manual |
| Zip / publish | `wxt zip` (+ Firefox sources zip), `wxt submit` (Chrome Web Store, Edge Add-ons, AMO) with `--dry-run`, `wxt submit init` writes `.env.submit` | Was the paid "BPP" GitHub Action | None (use `chrome-webstore-upload-cli`, `web-ext sign`) | None |
| Runtime overhead | Close to zero. `browser` shim plus small helpers (`defineBackground`, `ContentScriptContext`) | Messaging/storage libs if you opt in | Only a dev-time loader | Zero |
| Testing helpers | `wxt/testing/vitest-plugin` (fake `browser`), documented Playwright E2E | none | none | none |

(I found no reliable published bundle-size comparison. Measure our own build. For a build tool the
difference is mostly dev-time anyway, since none of them add meaningful runtime bytes except
whatever Plasmo libs you opt into.)

### Recommendation: WXT

- It is the only actively maintained option that covers the whole lifecycle: dev runner with
  per-part reload, typed manifest, multi-browser builds, zip and store submission, and test helpers.
  The Aug 2026 independent comparison (merginit) also calls it "the default for most new production
  extensions".
- Our product is mostly a **service worker plus a content script we inject on demand plus one large
  extension page (the editor)**. Plasmo is strongest at content-script UI injection, which we don't
  need. On top of that it is stagnating. Reject it.
- CRXJS is a good, lighter choice, but we would rebuild zip, submit, Firefox and test plumbing ourselves.
  Plain Vite is the same as CRXJS but with more work.
- Caveats: WXT is still 0.x. 0.21 bumped Node to >= 22, made `web-ext` a peer dependency, removed
  `url:` imports, and changed how scripts that return values work (`globalName`). **Pin the exact version**
  (`"wxt": "0.21.4"`) and read the release notes before each bump.
- WXT defaults Firefox and Safari to MV2. Set `manifestVersion: 3` globally so every target is MV3.

---

## 2. UI framework, canvas library, styling

### What the pages need

- **Popup:** none. We use no `default_popup`, so a toolbar click fires `action.onClicked`, which
  grants `activeTab` and starts the capture immediately (GoFullPage UX). Settings go on the options page.
- **Options:** a small form.
- **Editor:** the real app. It shows a very tall bitmap, annotation tools (arrow, rect, underline,
  highlight, freehand, text), select/move/resize, undo/redo, zoom/pan, export at native resolution,
  and copy to clipboard.

Bundle size matters less than on the web. Pages load from the local package, so there is no network
cost, only parse time and zip size. Ergonomics and the quality of the canvas library matter more.

### Canvas library

| Library | Version | Fit for "annotate a screenshot" | Verdict |
|---|---|---|---|
| **Konva** + react-konva / svelte-konva | react-konva 19.3.0 (needs React >= 19.3; uses Konva 10.5 hooks); svelte-konva v1 for Svelte 5 | Scene graph, hit detection, `Transformer` (resize/rotate handles), layers (a static image layer under an interactive annotation layer), `toCanvas({pixelRatio})` for export. Arrow, Rect, Line (freehand with `tension`), Text are all built in | **Pick** |
| Fabric.js | 7.4.0 (7.3 moved to Rolldown; 7.4 fixed CVE-2026-44311 in SVG export) | Very capable (IText editing, controls, cropping). It is imperative and owns its own object model, so you fight React state. Heavier | Good fallback, especially with vanilla/Svelte |
| tldraw | SDK v3+/v4 | A whiteboard, not an image annotator. **Production requires a license key**: trial, paid commercial, or a discretionary "hobby" licence with a mandatory watermark. Very large bundle | **Reject** (licence, watermark, size) |
| Excalidraw | 0.18.1 (May 2026, security backport) | A whiteboard with a hand-drawn look. A multi-MB package. Embedding a 30,000 px tall image as the base layer is awkward. MIT though | **Reject** for the editor (could inspire the look of the tools) |

### UI framework

| | Runtime (gz, approx.) | Konva binding | Ergonomics for a tool-heavy editor | Verdict |
|---|---|---|---|---|
| **React 19.3** | ~60 KB react+react-dom | **react-konva**: the most used and best maintained binding, released in step with React | Best ecosystem (Radix/Base UI primitives, hotkeys, colour pickers), everyone knows it, works best with AI-assisted coding | **Pick** |
| Preact 10 | ~4-5 KB | **react-konva does not work.** It ships its own `react-reconciler`, which `preact/compat` can't host | Fine for popup/options only | Reject (breaks the canvas binding) |
| Svelte 5 (runes) | ~10-15 KB | svelte-konva v1 (Svelte 5 + Konva 8-10, client-only) | Very nice. Smaller ecosystem. Biome's Svelte support is still experimental. TS 7 lacks the programmatic API svelte-check needs | Viable runner-up |
| Solid | ~7 KB | No maintained Konva binding | Great perf, thin ecosystem | Reject |
| Vanilla TS | 0 | Plain Konva | Fine for a canvas, painful for toolbar, state and menus once the editor grows | Use only inside the content script |

**Decision:** React 19.3 + react-konva + Zustand. The content script (`capture.content.ts`) stays
framework-free vanilla TS, because it runs inside arbitrary pages and has to be tiny and inert.

Editor architecture notes that drive the stack:
- **Canvas size limits.** Chromium caps a canvas at 32,767 px per side and about 268 M px of area
  (Blink `MaxSkiaDim`, 32768*8192). Past that, drawing silently fails. A 1440 px wide page at DPR 2
  that is 20,000 CSS px tall is 2880x40000, which is **already over the limit**. So the base image is
  stored and rendered as **a list of tile bitmaps** (several `Konva.Image` nodes, each under the
  limit), never as one giant canvas.
- Annotations live in document coordinates, as plain serialisable JSON (`{id, type, points, style}`).
  Undo/redo is a snapshot or patch stack in Zustand. It also persists to IndexedDB, so a reload of
  the editor does not lose work.
- Export composes tiles and annotations into one or more `OffscreenCanvas` chunks in a Web Worker,
  then calls `convertToBlob({type:'image/png'})`. "Copy" for AI chats should default to a downscaled
  image that fits the limit. A single clipboard PNG cannot exceed the canvas limit anyway.

### Styling

- **Tailwind CSS v4.3** with `@tailwindcss/vite`. The CSS-first config is just `@import "tailwindcss";`.
  v4.2.2+ officially supports Vite 8. It is only used on extension pages (editor, options).
- Define design tokens with `@theme` in one `src/styles/app.css`. No component kit. A few headless
  primitives (e.g. Radix/Base UI popover, slider) are enough for the toolbar.
- **Never inject UI or CSS into the captured page.** Any overlay would end up in the screenshot.
  Show progress with `chrome.action.setBadgeText`, which needs no permission, and after capture
  open the editor tab.

---

## 3. MV3 platform specifics we will hit

Current Chrome stable is in the ~155-157 range. Chrome moved to a 2-week release cadence in
Sept 2026. Set `minimum_chrome_version: "120"`, which covers every lifetime rule below and is
nowhere near a constraint.

### 3.1 Service worker lifetime during long captures
- Chrome terminates the SW after **30 s idle**. It also terminates it if **a single event or API
  call takes > 5 min**, or if a `fetch()` response takes > 30 s. **Every extension API call resets
  the idle timer (Chrome 110+)**, and so do events, messages from an offscreen doc (109+), and active
  long-lived ports (114+).
- A capture loop is `scroll -> wait -> captureVisibleTab -> store`. It is throttled by
  `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2` (so at least ~500 ms between shots). Each iteration
  makes API calls, so the SW stays alive naturally. A 60-viewport page takes about 30-40 s, which
  is fine. No keepalive hacks.
- Design for termination anyway:
  - Keep the capture job state in `chrome.storage.session` (10 MB, in-memory, survives SW restarts),
    not in globals.
  - Connect a **`runtime.connect` port from content script to SW** for the whole capture. It keeps the
    SW alive (114+), and **if the SW dies, `port.onDisconnect` fires in the content script, which then
    restores the page** (scroll position, hidden fixed/sticky elements, scrollbar CSS).
  - Write each tile to IndexedDB as soon as it is captured (`fetch(dataUrl).then(r => r.blob())`),
    so we never hold 60 data URLs in SW memory.

### 3.2 Offscreen documents: probably not needed in v1
- Reasons enum: `TESTING, AUDIO_PLAYBACK, IFRAME_SCRIPTING, DOM_SCRAPING, BLOBS, DOM_PARSER,
  USER_MEDIA, DISPLAY_MEDIA, WEB_RTC, CLIPBOARD, LOCAL_STORAGE, WORKERS, BATTERY_STATUS, MATCH_MEDIA,
  GEOLOCATION`. Only one offscreen doc can be open per profile. Only `runtime` APIs are available in
  it. It can't be focused. Only `AUDIO_PLAYBACK` has a lifetime limit.
- We don't need one, because:
  - Stitching and compositing run in the **editor tab**, a full extension page with DOM, canvas and
    workers. The SW also has `createImageBitmap` and `OffscreenCanvas`, if we ever want SW-side work.
  - Copying to the clipboard happens from the focused editor tab on a click.
- When we would add one (`"offscreen"` permission, no install warning): a future "copy without opening
  the editor" shortcut (`CLIPBOARD`), or `BLOBS`/`WORKERS` for heavy encoding while no editor is
  open. **Risk:** offscreen docs can't be focused, and `navigator.clipboard.write` requires a focused
  document. Google's own sample uses the offscreen doc for *text* via `execCommand('copy')`.
  Copying an image from an offscreen doc is unverified. Spike it before promising that feature.

### 3.3 Copying `image/png` to the clipboard from the editor page
```ts
// in the click handler; pass a Promise so user activation is captured synchronously
await navigator.clipboard.write([
  new ClipboardItem({ 'image/png': exportPng() /* Promise<Blob> */ }),
]);
```
- Works in Chrome 76+ and Firefox 127+. Only `image/png` is universally supported for images. Don't
  try JPEG or WebP.
- The document must be **focused**. Otherwise you get `NotAllowedError: Document is not focused`.
  Call it directly from a click or keyboard handler in the editor. Don't call it after an `await`
  chain that lets focus move, e.g. a devtools click.
- **Pass the Promise into `ClipboardItem` instead of awaiting the blob first.** Large PNG encoding
  can take longer than transient user activation lasts. (Safari requires this; Chrome tolerates both.)
- **Don't declare `clipboardWrite`.** It adds the install warning "Modify data you copy and paste",
  and we only need it for writes without a gesture or from other contexts.
- Fallback UX: also render the result as a plain `<img src=blob:...>`, so the native right-click
  "Copy image" works (GoFullPage parity).

### 3.4 Storing large blobs
| Store | Limit | Blobs? | Verdict |
|---|---|---|---|
| `chrome.storage.local` | 10 MB (5 MB in Chrome <= 113). The limit is ignored with `unlimitedStorage` | No. JSON only, so you'd use base64 data URLs (+33% size, slow) | Settings only |
| `chrome.storage.session` | 10 MB, in memory | JSON | Capture job state |
| **IndexedDB** | Origin quota. `unlimitedStorage` lifts it and avoids eviction | **Native `Blob` values**, available in SW and pages | **Tiles and annotations** |
| OPFS | Same quota. Async API in SW/pages, sync handles only in dedicated workers | Files | Only if we need streaming writes of >500 MB exports |

Use `idb` (~1 KB) with stores `captures` (meta: url, title, dpr, tile layout, createdAt),
`tiles` (Blob, keyed by `[captureId, index]`) and `docs` (annotation JSON). Add a retention policy:
keep the last N captures or 30 days, cleaned up on `runtime.onStartup`.

### 3.5 Downloads
- Save from the editor with `<a href={URL.createObjectURL(blob)} download="pagesnap-<host>-<date>.png">`.
  This **needs no permission**.
- Add `chrome.downloads` (warning: "Manage your downloads") only if we want SW-initiated saves, a
  forced Save As dialog, or `conflictAction`. Even then, put it in `optional_permissions` and call
  `permissions.request()` from the options page. Note that the SW has no `URL.createObjectURL`, so
  SW downloads would need data URLs. Do downloads from the editor page.

### 3.6 Context menus and keyboard commands
- `contextMenus` (no warning): create items in `runtime.onInstalled`, e.g. "Capture full page" and
  "Capture visible area", with `contexts: ['page', 'action']`. Clicking a menu item **grants
  activeTab**.
- `commands`: `_execute_action` with `suggested_key: { default: 'Alt+Shift+P' }` (same as the
  original). With no popup it triggers `action.onClicked`, and command shortcuts also **grant
  activeTab**. Rules: at most 4 suggested keys, must include Ctrl or Alt, no Ctrl+Alt, `MacCtrl`
  only in the `mac` key. Users rebind keys at `chrome://extensions/shortcuts`. Add a second named
  command, `capture-visible`, handled in `commands.onCommand`.

### 3.7 activeTab vs host permissions (install warnings)
- `activeTab` has **no install warning**. It grants temporary host access to the current tab after an
  action click, context-menu click, command shortcut or omnibox action. The grant lasts until the tab
  navigates to another origin or closes. It is what lets `scripting.executeScript` and
  `tabs.captureVisibleTab` run on that tab. `captureVisibleTab` accepts either `activeTab` or
  `<all_urls>`. Sensitive pages (other extensions, data: URLs) can be captured **only** with activeTab.
  `chrome://` pages and the Web Store can't be scripted, so a full-page capture is impossible there.
  Fall back to a visible-area capture or show a message.
- `<all_urls>` / `host_permissions` gives "Read and change all your data on all websites". That means
  a scary warning, slower review, and lower conversion. **Don't ship it.** Use it only in the e2e build
  (section 4).
- `tabs` gives "Read your browsing history". Not needed: activeTab already exposes `tab.url` and
  `tab.title` for the active tab, and we use those for the filename.
- `debugger` (CDP `Page.captureScreenshot` with `captureBeyondViewport`) would avoid scrolling
  entirely, but it gives two severe warnings plus the "is debugging this browser" infobar. Reject it.
- Result: `activeTab, scripting, storage, unlimitedStorage, contextMenus` **produce no install
  warning at all.**

### 3.8 `scripting.executeScript` injection
- The content script is a WXT `defineContentScript({ registration: 'runtime', main() {...} })`
  (`src/entrypoints/capture.content.ts`). It is never in `content_scripts`, so it costs nothing on
  pages we never capture. Inject it from the SW:
  `browser.scripting.executeScript({ target: { tabId }, files: ['content-scripts/capture.js'] })`.
  Read the return value from `res[0].result`, and check WXT 0.21's `globalName` note.
- Use `func` injection (`executeScript({ func, args })`) for tiny one-off probes, e.g. measuring
  `scrollHeight`/`devicePixelRatio`, or checking that the page is scriptable.
- Inject into the main frame only (default). Use the `ISOLATED` world (default). There's no need
  for MAIN world.
- Guard against double injection with a `window.__pagesnapActive` flag. The content script owns:
  measure, disable smooth scrolling, hide scrollbars, neutralise `position: fixed/sticky` after the
  first tile, scroll to `(x, y)`, wait for 2x rAF plus a settle delay, report back, and restore.

---

## 4. Testing

### 4.1 Unit tests: Vitest 4.1
- `vitest.config.ts` with `plugins: [WxtVitest()]` (from `wxt/testing/vitest-plugin`). It provides
  an in-memory `browser` from `wxt/testing/fake-browser` (`@webext-core/fake-browser`), resolves
  WXT auto-imports, and sets `import.meta.env.BROWSER`.
- Keep the capture logic **pure and heavily unit-tested**. That's where GoFullPage-style bugs live:
  - `planTiles({scrollW, scrollH, viewW, viewH, dpr, maxCanvas})`: scroll positions, the crop of the
    final partial row or column, and splitting into output chunks under 32,767 px / 268 M px.
  - Fixed/sticky element handling decisions, rounding of DPR (1, 1.25, 1.5, 2, 3).
  - Annotation model reducers, undo/redo, coordinate transforms (zoom/pan to document coordinates).
  - SW message handlers and the job state machine against `fakeBrowser`.
- Canvas code (tile compositing, export chunking, Konva rendering) runs in **Vitest Browser Mode**
  (stable since Vitest 4.0) with the `@vitest/browser-playwright` provider. It runs in real
  Chromium, so `OffscreenCanvas`/`convertToBlob` are real. Use a separate `vitest.workspace` project
  named `browser`.

### 4.2 E2E: Playwright with the unpacked extension
- Since **Chrome 137, branded Chrome and Edge ignore `--load-extension`**. Use Playwright's bundled
  Chromium / Chrome for Testing.
- **Headless works** in the new headless mode via `channel: 'chromium'`. That is the real Chrome
  browser, not the old headless shell. In CI install the full browser:
  `pnpm exec playwright install --with-deps chromium`, and **don't** use `--only-shell`.
- Fixture (adapted from playwright.dev and the WXT E2E guide; WXT outputs to `.output/chrome-mv3`):
```ts
// tests/e2e/fixtures.ts
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
const EXT = path.resolve('.output/chrome-mv3-e2e'); // built with --mode e2e (see below)
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2, // also run a dpr=1 project
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },
});
export const expect = test.expect;
```

### 4.3 Automating the `captureVisibleTab` flow
Playwright can't click the toolbar button or fire a `commands` shortcut, so the **activeTab grant
can't be simulated**. The approach:
1. **An e2e build mode.** `wxt build --mode e2e` (separate outDir). In `wxt.config.ts`, when
   `mode === 'e2e'`, add `host_permissions: ['http://localhost/*', 'http://127.0.0.1/*']`. That
   makes `captureVisibleTab` and `executeScript` work without a gesture. The SW also exposes
   `globalThis.__pagesnap = { startCapture }`, behind `import.meta.env.MODE === 'e2e'` so it
   tree-shakes out of prod.
2. **Deterministic fixture pages** in `tests/fixtures/pages/`, served by Playwright's `webServer`
   (`pnpm dlx serve tests/fixtures/pages -l 4321`): `bands.html` (alternating 500 px coloured bands
   with labels, 12,000 px tall), `sticky-header.html`, `fixed-footer.html`, `inner-scroller.html`,
   `lazy-images.html`, `wide.html` (horizontal scroll), `huge.html` (> 32,767 device px, exercises
   chunking).
3. The test opens the fixture, calls `page.bringToFront()` (`captureVisibleTab` grabs the *active*
   tab), then runs
   `sw.evaluate(async () => { const [t] = await chrome.tabs.query({active:true,lastFocusedWindow:true}); return globalThis.__pagesnap.startCapture(t.id); })`.
   Then it waits for `context.waitForEvent('page')` (the editor tab).
4. **Assert on pixels, not screenshots.** In the editor page (e2e mode), expose
   `window.__pagesnapTest.exportPng()`, which returns base64. Decode it in Node with `pngjs`. Assert
   the dimensions (`scrollW*dpr x scrollH*dpr`), the colour at known band offsets (catches seams and
   off-by-one overlap), and that the sticky header appears exactly once.
5. Clipboard: in e2e, stub `navigator.clipboard.write` via `page.addInitScript` and assert the
   `ClipboardItem` has an `image/png` blob of the expected size. Real OS clipboard reads in headless
   are flaky and not worth testing.
6. Keep a short **manual smoke checklist** for what can't be automated: real toolbar click,
   `Alt+Shift+P`, a context-menu capture on a real site (activeTab path), right-click "Copy image",
   and pasting into Claude/ChatGPT.

---

## 5. Package manager, lint, format, TypeScript

- **pnpm 11** (`packageManager` field + Corepack). Default `minimumReleaseAge = 1440` (1-day
  supply-chain gate) and `blockExoticSubdeps`. Keep both on. That matters for an extension that
  handles screenshots of users' pages. **Node 24 LTS** (`.nvmrc`). WXT 0.21 requires >= 22.
  Bun works with WXT (`bunx wxt init`), but buys us nothing, and Playwright and Vitest are tested on
  Node first.
- **Biome 2.x** for lint and format in one tool. It has type-aware rules without tsc (e.g.
  `noFloatingPromises`, which is very useful with the async chrome APIs), React hooks rules, and the
  Tailwind class syntax. With React and no Svelte/Vue, there's no reason for ESLint+Prettier.
  Config: `biome.json` with `"vcs": {"enabled": true, "useIgnoreFile": true}`, ignore `.output`
  and `.wxt`.
- **TypeScript strict.** TS 7.0 (native Go compiler) went GA in July 2026, and the npm `latest`
  tag is 7.0.x. Use it for `tsc --noEmit` (8-12x faster). It still lacks a stable programmatic API
  (expected in 7.1). If anything in the toolchain breaks (WXT type generation runs through `wxt
  prepare` and doesn't need it), pin `typescript@6` instead. `tsconfig.json` extends WXT's
  generated `.wxt/tsconfig.json` and adds `"strict": true, "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true, "verbatimModuleSyntax": true`.
- Use `@types/chrome` only if we need APIs missing from `wxt/browser`. Otherwise import `browser` from
  `wxt/browser`. Chrome itself exposes `browser.*` since Chrome 148.

Scripts (`package.json`):
```json
{
  "scripts": {
    "dev": "wxt",
    "dev:firefox": "wxt -b firefox",
    "build": "wxt build",
    "build:e2e": "wxt build --mode e2e",
    "zip": "wxt zip && wxt zip -b firefox && wxt zip -b edge",
    "typecheck": "wxt prepare && tsc --noEmit",
    "lint": "biome check .",
    "format": "biome check --write .",
    "test": "vitest run",
    "test:e2e": "pnpm build:e2e && playwright test",
    "submit:dry": "wxt submit --dry-run --chrome-zip .output/*-chrome.zip",
    "postinstall": "wxt prepare"
  }
}
```

---

## 6. Repo layout, scaffold, manifest

### 6.1 Directory tree
```
pagesnap/
├─ package.json  pnpm-lock.yaml  .nvmrc  .npmrc
├─ wxt.config.ts            # manifest lives here (typed), per-browser + e2e mode
├─ tsconfig.json  biome.json  vitest.config.ts  vitest.workspace.ts  playwright.config.ts
├─ public/
│  └─ icon/ 16.png 32.png 48.png 128.png
├─ src/
│  ├─ entrypoints/                 # one file or one folder per entrypoint, max 1 level deep
│  │  ├─ background.ts             # SW: action/menu/command -> capture orchestrator
│  │  ├─ capture.content.ts        # registration:'runtime'; scroll/measure/hide-fixed/restore
│  │  ├─ editor/                   # unlisted page -> /editor.html?capture=<id>
│  │  │  ├─ index.html  main.tsx
│  │  └─ options/
│  │     ├─ index.html  main.tsx
│  ├─ capture/                     # pure + SW-side logic (no DOM)
│  │  ├─ plan.ts                   # tile planning & chunking (unit-tested hard)
│  │  ├─ orchestrator.ts           # job state machine, throttling (2/s), retries
│  │  └─ messages.ts               # typed SW <-> content-script protocol
│  ├─ editor/                      # React app
│  │  ├─ App.tsx  store.ts  history.ts
│  │  ├─ canvas/ Stage.tsx TileLayer.tsx AnnotationLayer.tsx
│  │  ├─ tools/  arrow.ts rect.ts highlight.ts underline.ts pen.ts text.ts
│  │  ├─ export/ export.worker.ts compose.ts clipboard.ts download.ts
│  │  └─ ui/     Toolbar.tsx ColorPicker.tsx ...
│  ├─ shared/  db.ts (idb schema)  settings.ts  types.ts
│  └─ styles/  app.css             # @import "tailwindcss"; @theme {...}
├─ tests/
│  ├─ unit/        plan.test.ts  history.test.ts  orchestrator.test.ts
│  ├─ browser/     compose.test.ts (Vitest browser mode)
│  ├─ e2e/         fixtures.ts  capture.spec.ts  editor.spec.ts
│  └─ fixtures/pages/ bands.html sticky-header.html fixed-footer.html inner-scroller.html
│                     lazy-images.html wide.html huge.html
└─ docs/research/  01-*.md  02-stack.md ...
```
(WXT warns not to put non-entrypoint helper files directly in `entrypoints/`. That's why the app
code lives in `src/editor`, `src/capture` and so on, and the entry folders only hold `index.html`
and `main.tsx`.)

### 6.2 Scaffold commands
The repo already has `.git` and `docs/`, so scaffold into a temp dir and copy it over (or run
`wxt init` with `.` and choose "merge" if prompted). Check the flags with `pnpm dlx wxt@latest init --help`.
```bash
cd ~/code
corepack enable && corepack prepare pnpm@latest-11 --activate
echo "24" > pagesnap/.nvmrc
pnpm dlx wxt@0.21.4 init pagesnap-tmp --template react --pm pnpm
rsync -a --exclude .git pagesnap-tmp/ pagesnap/ && rm -rf pagesnap-tmp
cd pagesnap
pnpm add -E wxt@0.21.4 -D                          # pin exactly
pnpm add react@^19.3 react-dom@^19.3 konva@^10 react-konva@^19.3 zustand idb
pnpm add -D tailwindcss @tailwindcss/vite @biomejs/biome typescript \
            vitest @vitest/browser-playwright @playwright/test pngjs @types/pngjs
pnpm exec biome init
pnpm exec playwright install --with-deps chromium
# then: move entrypoints under src/ (srcDir), rename popup -> editor, add options/, delete popup
mkdir -p src/{capture,editor,shared,styles} tests/{unit,browser,e2e,fixtures/pages}
pnpm wxt prepare && pnpm dev
```

### 6.3 `wxt.config.ts` (manifest and permissions)
```ts
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,                              // also for firefox/safari (WXT defaults them to MV2)
  vite: () => ({ plugins: [tailwindcss()] }),
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}', // verify: e2e build -> .output/chrome-mv3-e2e
  manifest: ({ browser, mode }) => ({
    name: 'pagesnap',
    description: 'Full-page screenshots with a fast annotation editor. Copy straight into AI chats.',
    minimum_chrome_version: '120',
    permissions: ['activeTab', 'scripting', 'storage', 'unlimitedStorage', 'contextMenus'],
    optional_permissions: ['downloads'],           // only if "save to folder" ships; ask at runtime
    host_permissions: mode === 'e2e' ? ['http://localhost/*', 'http://127.0.0.1/*'] : [],
    action: { default_title: 'Capture full page (Alt+Shift+P)' },  // no default_popup on purpose
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+P' } },
      'capture-visible': { suggested_key: { default: 'Alt+Shift+V' }, description: 'Capture visible area' },
    },
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: { id: 'pagesnap@<domain>', data_collection_permissions: { required: ['none'] } },
      },
    }),
  }),
});
```
Permission rationale (for the Web Store "permission justification" form):

| Permission | Why | Install warning |
|---|---|---|
| `activeTab` | Capture and script the tab the user explicitly invoked us on | none |
| `scripting` | Inject `capture.content.js` to scroll, measure and hide fixed elements | none |
| `storage` | Settings + capture-job state (`storage.session`) | none |
| `unlimitedStorage` | Large tile blobs in IndexedDB without quota or eviction | none |
| `contextMenus` | "Capture full page / visible area" on page and action menus | none |
| *(commands key)* | Keyboard shortcuts. Not a permission | none |
| `downloads` *(optional)* | Only for Save As / folder features | "Manage your downloads" |
| **Not requested** | `tabs`, `<all_urls>`, `clipboardWrite`, `debugger`, `offscreen` (add only if 3.2 spike lands) | |

Multi-browser notes: **Edge** reuses the Chrome MV3 build (`wxt zip -b edge`, submitted with
`wxt submit --edge-zip`). **Firefox** MV3 uses an event-page background (WXT handles it), has no
`offscreen` API, and needs `data_collection_permissions` for AMO (required for new add-ons since
3 Nov 2025). **Safari:** `wxt build -b safari`, then `xcrun safari-web-extension-converter` and an
Xcode/App Store build. Defer it to after v1.

---

## Sources
- WXT releases: https://github.com/wxt-dev/wxt/releases. Installation: https://wxt.dev/guide/installation.html.
  Entrypoints: https://wxt.dev/guide/essentials/entrypoints.html. Scripting: https://wxt.dev/guide/essentials/scripting.html.
  Browsers: https://wxt.dev/guide/essentials/target-different-browsers.html. Publishing: https://wxt.dev/guide/essentials/publishing.
  Unit tests: https://wxt.dev/guide/essentials/unit-testing.html. E2E: https://wxt.dev/guide/essentials/e2e-testing.html.
  Dev mode: https://wxt.dev/guide/introduction. 0.21 notes: https://newreleases.io/project/github/wxt-dev/wxt/release/wxt-v0.21.1
- Framework comparison (Aug 2026): https://merginit.com/blog/23082026-plasmo-vs-wxt-vs-crxjs-extension-js.
  Plasmo status: https://extensionbooster.net/blog/plasmo-alternatives-chrome-extension-framework-migration-guide-2026.md
- CRXJS releases: https://github.com/crxjs/chrome-extension-tools/releases
- react-konva 19.3: https://newreleases.io/project/github/konvajs/react-konva/release/v19.3.0. svelte-konva: https://github.com/konvajs/svelte-konva
- Fabric 7.4 changelog: https://cdn.jsdelivr.net/npm/fabric@7.4.0/CHANGELOG.md. tldraw licence: https://tldraw.dev/sdk-features/license-key, https://tldraw.dev/legal/tldraw-license
- Excalidraw: https://npmjs.com/@excalidraw/excalidraw. Tailwind + Vite 8: https://github.com/tailwindlabs/tailwindcss/discussions/19624
- Chrome SW lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen. Offscreen blog: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- tabs.captureVisibleTab: https://developer.chrome.com/docs/extensions/reference/api/tabs. activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- Permission warnings: https://developer.chrome.com/docs/extensions/reference/permissions-list. Storage quotas: https://developer.chrome.com/docs/extensions/reference/api/storage
- Commands: https://developer.chrome.com/docs/extensions/reference/api/commands. Clipboard images: https://web.dev/articles/clipboard/copy-images.
  MDN extension clipboard: https://developer.mozilla.org/Add-ons/WebExtensions/Interact_with_the_clipboard
- Canvas limits (Blink source): https://chromium.googlesource.com/chromium/blink/+/HEAD/Source/core/html/HTMLCanvasElement.cpp
- Playwright extensions: https://playwright.dev/docs/chrome-extensions. Browsers/headless: https://playwright.dev/docs/browsers.
  `--load-extension` removal: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY
- Chrome 2-week cadence: https://developer.chrome.com/blog/chrome-two-week-release
- Vitest 4: https://voidzero.dev/posts/announcing-vitest-4. pnpm 11: https://pnpm.io/blog/releases/11.0. Biome v2: https://biomejs.dev/blog/biome-v2/.
  TS 7 GA: https://infoq.com/news/2026/08/typescript-7-released/
- Firefox data collection: https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/
