# Editor stress (task 2) and storage growth (task 3)

Build: `.output/chrome-mv3-e2e-q` (HEAD 6eb6ce6), headless. Page: https://en.wikipedia.org/wiki/World_War_II, captured through `__pagesnap.clickAction` (the toolbar path).
Scripts: `/tmp/pagesnap-review/qa-scratch/stress/{stress,thrash,memprobe,storage,probe}.mjs`. Artifacts: `/tmp/pagesnap-review/qa/stress/<run>/` (screenshots, clipboard PNGs, downloads, `result.json`) and `run-*.log`.

Frame-time method: `__pagesnapEngine.perf.frames` (renderer CPU ms per frame), plus an independent in-page rAF interval recorder. CPU render time is always 0.1 to 0.5 ms because it only records the draw calls. The real cost shows up as **rAF interval** (main-thread or raster stalls). Headless runs at 60 Hz, so 16.7 ms is a perfect frame.

## Capture and editor summary

| | Chromium DPR 2 | CfT 156 DPR 2 | Chromium DPR 1 |
|---|---|---|---|
| Capture (click to editor open) | 40.7 s, 74 slices | 40.7 s, 74 slices | 40.5 s, 74 slices |
| Image | 2560 × 118548 | 2560 × 118548 | 1280 × 59315 |
| Editor ready after open | 136 ms | ~100 ms | 79 ms |
| IDB size of this one capture | (n/a) | 47.3 MB | 19.8 MB |
| Fling, 400 CSS px/frame, top to bottom and back (286 frames) | rAF p50/p95/max 16.7/16.8/16.8 ms, 0 dropped | same | same |
| Real wheel via CDP, 300 × 1200 px bursts | rAF max 16.8 ms; wheel events coalesce to ~30 fps renders | same | same |
| Mid-pan screenshots | tiles always drawn, no blank or checkerboard (`02-fling-mid-*.png`) | same | same |
| Pan at 100%, 50% (ladder) | 16.7 ms | 16.7 ms (one 1.0 s hitch on entering 100%) | 16.7 ms |
| **Pan at 25% / 12.5% / 5%** | **rAF p50 ≈ 0.5 to 1.7 s** | **p50 683 / 650 / 633 ms, p95 1.8 s; 40 frames took 34 s** | 16.7 / 16.7 / **p95 1.65 s** |
| Cmd+minus ×30 to 5% | rAF up to 3.0 s per frame; 12 keypresses took minutes | up to 2.9 s | smooth |
| Pinch (ctrl+wheel 60 in, 120 out) | rAF p95 1.7 s, max 2.9 s | p95 2.1 s, max 3.2 s | 16.7 ms |
| Draw 60 shapes (arrow, rect, underline, highlight, pen, text) across the page | 60/60 committed, 14.1 s | 60/60, 12.9 s | 60/60, 9.9 s |
| Undo ×100 / redo ×100 (keyboard) | 59 / 79 ms total; 0 → 60 shapes, flags right | 56 / 74 ms | 84 / 103 ms |
| Cmd+C first (smart; marks span the page) | 3.0 s → 1280 × 56833, 26 MB PNG, `tall` toast | 3.1 s | 1.2 s → 1280 × 55399 |
| Cmd+C again (cached) | 0.30 s | 0.30 s | 0.41 s |
| Shift+Cmd+C (full) | 2.7 s → 1280 × 59274, 27 MB | 2.7 s | 0.73 s → 1280 × 59315 |
| Cmd+S download (first) | **7.4 s** → 2560 × 118548, 52.6 MB, correct and sharp | 7.3 s | 0.19 s → 1280 × 59315, 25.4 MB |
| Download button (second) | 0.1 s (cached) | 0.08 s | 0.1 s |
| Reload editor | ready in 113 ms; 60/60 shapes identical | 259 ms, identical | 222 ms, identical |
| Reload immediately after a new shape (no wait) | 61 → 61, autosave flushed on unload | same | same |

The clipboard images were read back from an http page and their dimensions match the plan. The download was checked visually: `chromium-dpr2/preview-download-overview.png` shows the whole page with the marks, and `preview-download-crop.png` is a full-resolution crop where the arrow is crisp.

### Memory (Chromium DPR 2, solo run; process RSS of the headless browser tree)

| Point | Editor JS heap (after GC) | Total RSS | GPU proc | Largest renderer |
|---|---|---|---|---|
| Before capture | (n/a) | 1172 MB | (n/a) | 250 MB |
| Editor loaded | 4.2 MB | 1691 MB | 215 MB | 648 MB |
| After fling | 4.3 MB | 1532 MB | 202 MB | 487 MB |
| At 5% zoom | 4.6 MB | 1227 MB | 201 MB | 383 MB |
| 60 shapes | 5.4 MB | 1482 MB | 263 MB | 562 MB |
| After undo/redo ×100 | 5.4 MB | 1819 MB | 208 MB | 921 MB |
| After 3 copies | 5.5 MB | 2164 MB | 245 MB | 576 MB (browser process 215 → 655 MB) |
| After downloads | 5.6 MB | 2290 MB | 230 MB | 680 MB |

- The JS heap stays tiny (bitmaps live outside it), and DOM nodes and listeners are stable, so there is no JS leak.
- The browser process grows by about 440 MB after the copies, which is the clipboard payload plus blobs. It isn't released while the editor stays open.
- Tile-thrash memory probe (`memprobe.mjs`, source tab closed so the editor is the main renderer): idle at 25% for 30 s takes the editor renderer from 418 to 654 MB and the GPU process from 195 to 274 MB. Both plateau, so this is churn rather than a leak.
- Caveat: the CfT and DPR 1 runs ran in parallel, so their process RSS may be mixed. Only the solo Chromium DPR 2 numbers above are reliable.
- `chrome://gpu` isn't readable headless.

## Storage growth (task 3)

27 captures in a row: 22 × `bands.html` (8000 CSS px) at DPR 2, plus HN, a short Wikipedia page, example.com and `lazy-images.html`. The first 10 editors were left open and the rest were closed. Full rows are in `storage/storage.json`.

| After n captures | Sessions | Slices | Slice MB | `storage.estimate` (editor) | `storage.session` | Tabs |
|---|---|---|---|---|---|---|
| 1 | 1 | 10 | 0.3 | 0.4 MB | 1.5 KB / 2 keys | 3 |
| 10 | 10 | 100 | 3.1 | 3.6 MB | 14.8 KB / 20 keys | 12 |
| 20 | 20 | 200 | 6.1 | 7.2 MB | 29.7 KB / 40 keys | 13 |
| 27 | 27 | 253 | 8.9 | 10.3 MB | 39.5 KB / 54 keys | 13 |
| Restart ×2 (incl. 10 sessions back-dated 40 days) | 27 | 253 | 8.9 | 10.4 MB | 0 | 1 |

- Flat-colour fixtures are tiny. Real pages are not: one WW2 capture is **47 MB at DPR 2** and 20 MB at DPR 1. At the default `keepSessions: 20` that is about 1 GB, and nothing caps it.
- Nothing prunes during a browser session. `pruneSessions` runs only from `runtime.onStartup` (`src/entrypoints/background.ts:61-67`).
  - Crossing 20 captures deletes nothing, by design: keep the newest 20, then delete only those older than 30 days.
  - Closing an editor doesn't delete its session (sessions 11 to 27 were closed and all persist).
  - There's no UI to delete captures, and the options page doesn't expose `storage.*`.
  - The manifest asks for `unlimitedStorage`, so the browser will never evict the data either.
- Restart test: `--load-extension` reinstalls the unpacked extension on every launch, so `onStartup` never fires in this harness. I confirmed this with a probe extension (`probe.mjs`): 3 launches gave `onInstalled: install ×3` and `onStartup` 0 times, in both Chromium and CfT. The 10 back-dated sessions therefore survived, which is a harness limit and not a product verdict. Reading the code, the prune logic is correct, but it only ever runs at a real browser start.
- `chrome.storage.session` grows by about 1.5 KB per capture:
  - The `session-status:<id>` and `capture-timings:<id>` keys are never removed; `clearSessionStatus` exists but nothing calls it.
  - It is cleared on browser restart, and the 10 MB quota is thousands of captures away.
- Editor tabs pile up: every capture opens a new tab and nothing reuses an existing one (3 → 13 tabs after 10 captures with editors left open).

## Issues

### S1 (P1): Zooming out below about 33% at DPR 2 freezes the editor; the tile cache loads and evicts in an endless loop
- **Repro:**
  1. DPR 2, capture WW2 Wikipedia (2560 px wide).
  2. In the editor, press Cmd+minus until the zoom reads 25%, or call `_panZoom` with zoom 0.25/dpr. Leave the mouse alone.
- **Expected:** a static view at 60 fps with no work while idle.
- **Actual:**
  - About 800 to 900 `getTileBitmap` calls per second while idle (4,122 in 5 s), and rAF runs at about 0.3 to 2 fps.
  - Each Cmd+minus or pinch step stalls 0.3 to 3 s, and the editor becomes unusable.
  - Threshold measured with `thrash.mjs`: 33% gives 0 loads and 16.7 ms frames; 30% gives 4,459 loads in 5 s and 1.7 s frames. At DPR 1 the same happens at 5%.
  - It reproduces identically in CfT.
- **Cause (tiles.ts):**
  - The renderer asks for a prefetch rect of 3× the visible height (`renderer.ts` `frame()`).
  - At 30% the prefetch tiles (12 × 2560×2048×4 = 252 MB) exceed `TILE_BUDGET_BYTES` (160 MB).
  - `evict()` immediately drops the freshly loaded prefetch tiles, `pump()` reloads them, and the loop never ends.
  - Also, tiles are only ever full resolution, so a zoomed-out view decodes and draws hundreds of MB per frame. There is no low-res level.
  - Wider pages (1440 to 1920 CSS px) will hit it at higher zooms.
- **Artifacts:**
  - `stress/thrash-results.txt`
  - `stress/run-cft-dpr2.log`, `stress/run-chromium-dpr2.log` (`zoomOutKeysToMin`, `panAtMinZoom`, `ctrlWheelPinch`)
  - `stress/chromium-dpr1/ladder-5.png`
  - script `qa-scratch/stress/thrash.mjs`

### S2 (P2): Captures are never cleaned up during a browser session; real captures are large; `unlimitedStorage`
- **Repro:**
  1. Capture 27 pages, closing the editors.
  2. Check `navigator.storage.estimate()` and the IDB counts.
- **Expected:** a bounded store, with old sessions pruned (settings say keep 20, 30 days) or deleted when their editor closes, or at least a way for the user to clear them.
- **Actual:** 27 of 27 sessions are kept. Prune runs only on `runtime.onStartup`, and even then it keeps everything newer than 30 days. One long DPR 2 page is 47 MB, so a month of normal use can reach several GB, and `unlimitedStorage` means Chrome won't evict it. There is no delete UI.
- **Artifacts:** `stress/storage/storage.json`, `stress/run-storage.log`, `stress/cft-dpr2/result.json` (`sliceMB: 47.3`).

### S3 (P2): First full-resolution download of a long DPR 2 page takes 7.4 s; first Cmd+C takes 3 s
- **Repro:** WW2 at DPR 2, draw marks, press Cmd+S.
- **Actual:**
  - The download event arrives after 7.3 to 7.4 s, for a 2560 × 118548, 52.6 MB PNG. The result is correct.
  - The first Cmd+C (smart, 1280 × 56833) takes 3.0 s and Shift+Cmd+C 2.7 s, even though `cacheHit: true`, which means the pre-encode was still in flight.
  - Repeats take about 0.3 s.
  - DPR 1 is 4 to 6× faster.
- **Expected:** a progress indication. The `saving` state exists; check that the toolbar shows it.
- **Note:** acceptable for v0.1, but a 26 MB smart copy is of little use to an AI chat (see S4).
- **Artifacts:** `stress/*/result.json` `timings.download-key`, `07-*-toast.png`.

### S4 (P3): Smart Cmd+C with marks spread down the page copies a 1280 × 56833 image
- This follows contract §4.9 (bbox taller than the cap → copy the bbox, `tall: true`).
- The toast does say "Your marks span a tall area, so AI chats will scale it down. ⇧⌘C copies all of it."
- But Cmd+C then puts a 26 MB, 56k-px-tall PNG on the clipboard. That is almost the same as the full copy, and AI chats will crush it.
- A product question rather than a bug: consider offering the viewport or the most recent marks instead.
- **Artifact:** `stress/chromium-dpr2/clip-copyDefault.png`, `07-copyDefault-toast.png`.

### S5 (P3): The status mirror and timing keys in `chrome.storage.session` are never removed
- **Detail:** about 1.5 KB per capture, 2 keys each. `clearSessionStatus` (`src/shared/handoff.ts:57`) has no callers.
- **Impact:** harmless until the 10 MB quota, after which `publishSessionStatus` would start failing within one long browser session.
- **Artifact:** `storage.json` columns `storageSessionKB` and `storageSessionKeys`.

### S6 (P3): The browser process keeps about 440 MB after copying a long page
- **Detail:** the browser process went from 215 to 655 MB after three clipboard writes of 26 to 27 MB PNGs, and stayed there through GC and downloads.
- **Likely cause:** clipboard and blob retention.
- **Artifact:** `stress/chromium-dpr2/result.json` `mem.afterCopies`.

### Passed
- Fling and pan at fit width (≥33% zoom at DPR 2) hold a steady 60 fps with no blank tiles.
- 60 shapes across every tool all commit.
- Undo ×100 and redo ×100 are exact, with `canUndo`/`canRedo` correct.
- Reload restores the shapes exactly, including a shape drawn just before the reload.
- Clipboard and download dimensions match the plan, and the download pixels are sharp and annotated.
- No JS heap or DOM leak.
