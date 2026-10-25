# Page Snap v0.1: correctness, reliability and security review

HEAD 6eb6ce6. The repo was not edited. All runs used the scratch copy `/tmp/pagesnap-review/repo-copy`: e2e build `PAGESNAP_E2E_ID=r1`, everything headless Chromium.

Repro files:
- `tests/e2e/review.restore2.spec.ts`, `review.prepare.spec.ts`, `review.zoom.spec.ts`, `review.window.spec.ts` (capture);
- `tests/unit/review.engine.test.ts`, `review.tiles2.test.ts` (engine);
- `/tmp/pagesnap-review/scratch/engine/*.mjs` and `/tmp/pagesnap-review/scratch/ui/*` (probes).

Legend: **[ran]** confirmed by running something; **[read]** found by reading the code.

---

## Ranked findings

### 1. HIGH: an abort during a step or prepare leaves the page modified [ran]
Files:
- `src/capture/agent/session.ts:141` checks `restored` only when a step starts;
- `session.ts:172-182` and `91-125` keep mutating after `await`s;
- `src/capture/agent/mutations.ts:45` `setStyle` still works after `restore()`;
- `src/capture/agent/main.ts:21-23, 61` `end()` restores while `handle()` is still in flight.

`restore()` runs at once on Esc, pagehide/visibility-hidden, port disconnect or a `restore` message. Nothing cancels the `prepare`/`step` coroutine that is in flight. When that coroutine resumes after its `await`, it applies floats, unsticks elements, pauses animations and scrolls. These new mutations land after the restore, so nothing ever undoes them.

Scenarios (both confirmed):
- **Esc mid-step, on a page whose DOM ticks** (a clock, chat or ads class change every 40 ms): the fixed header is left as `opacity: 0 !important` and the sticky panel as `position: relative !important; inset: auto !important`. This happened in 2 of 6 runs (`review.restore2.spec.ts`). The existing Esc test passes only because its fixture is static.
- **Esc about 300 ms into a capture** (prepare or pre-scroll): the user's scroll position (1234) is lost and the page is left at `scrollY = 0` (`review.prepare.spec.ts`, delay 300).

The same code paths run after:
- a tab switch (visibilitychange);
- a toolbar cancel;
- prepare taking longer than the 20 s SW timeout (huge DOMs), after which the SW goes on to a visible-only capture while the agent is still mutating the page.

Fix:
- Give `AgentSession` an `AbortSignal` or a `checkAlive()` call after every `await` in `prepare`/`step`/`preScroll`/`settledPosition`/`waitForStableHeight`, throwing `AgentError('ABORTED')`.
- Make `PageMutations.setStyle`, `settleAnimations`, `makeEager` and `pauseVideos` no-ops once `restored`.
- Make `target.set` no-op after restore.
- Disconnect any observer created after restore.
- Add an e2e test with a mutating-DOM fixture, aborting at random offsets.

### 2. HIGH: the editor tile cache reloads and evicts tiles forever while idle; no memory cap when zoomed out [ran]
Files: `src/editor/engine/tiles.ts:129-133, 152, 167-187`, `renderer.ts:174`.

`evict()` drops tiles inside the prefetch rect (3x the view). `pump()` then reloads every wanted tile that has no bitmap, which evicts another, and so on. Every load is a full worker composite.

Scenario: fit-width on a 2560-CSS-px display at DPR 2 hits more than 300 loads with no input (`review.tiles2.test.ts`). It is the same on a laptop after one Cmd-minus.

Zoomed out, the visible tiles are never evicted: about 405 MB stays resident at 5% zoom on a 140k-px image.

Fix:
- Only prefetch within the budget that remains after the visible tiles.
- Never evict a tile in order to load a tile of the same priority.
- Use downscaled tiles at low zoom.

### 3. HIGH: storage grows without bound and retention rarely runs [read]
Files: `src/entrypoints/background.ts:61-67`, `src/shared/db.ts:141-147`.

- `pruneSessions` runs only on `runtime.onStartup`. Mac users who never quit Chrome never prune.
- The policy is "keep the newest 20 **or** anything younger than 30 days". 20 captures a day at about 20-30 MB of DPR-2 PNG slices each is roughly 15 GB after 30 days. With `unlimitedStorage` there is no quota to stop it.
- There is no UI to delete captures.
- Docs whose session was deleted while an editor was open are orphaned.
- The `session-status:*` and `capture-timings:*` mirrors in `storage.session` are never removed. They are small, but they grow until the browser restarts.

Proposed retention policy:
- **When it runs:** after every finished capture, on SW start (throttled to once every 6 h with a timestamp in `storage.local`), and on `onStartup`.
- **Keep:** the newest 10 captures always.
- **Delete:** anything older than 7 days.
- **Byte budget:** `min(1 GB, 10% of navigator.storage.estimate().quota)`. Measure it from the slice blob sizes recorded on the session, and evict oldest first beyond the budget.
- **Protect:** never delete a session whose editor is open (`runtime.getContexts({documentUrls})`) or one still `capturing`.
- **Clean up:** delete the status/timings mirrors and orphan docs along with the session. Clamp `keep >= 1` and validate settings, because `keep: null` currently deletes everything (UI reviewer probe).
- **Options page:** add "Delete all captures" and show the current usage.

### 4. MEDIUM: "The window was minimised" check, and occluded windows [read + ran]
Files: `src/capture/orchestrator.ts:346-355` (the check at `:353`), `src/capture/agent/main.ts:53-55`.

That message has exactly one source: `checkTab()` throws it when `windows.get(windowId).state === 'minimized'`. It runs **after** a successful `captureVisibleTab`, so a good frame is thrown away first.

What I established:
- Headless, a second window covering the first leaves `state: 'normal'` and `visibilityState: 'visible'`. Really minimising mid-capture produces exactly this message (`review.window.spec.ts`).
- In Chromium on macOS, `NativeWidgetMac::IsMinimized()` returns `is_miniaturized_`. That is set only by `OnWindowMiniaturizedChanged` (an NSWindow miniaturize notification). Occlusion goes through a separate `OnWindowOcclusionChanged`, which never touches it.
- So this check should not misfire for a window that is merely occluded. I couldn't reproduce the headed macOS occlusion case without a visible window. The headed run most likely saw a real (or Dock round-trip) miniaturize state.

The real occlusion hazard is the agent's `visibilitychange` handler (`main.ts:53-55`). With Chrome's macOS WebContents occlusion tracking, a fully covered window makes `document.visibilityState` `hidden`. The agent then aborts with "The tab was hidden or left". A user who Cmd-Tabs to an app that covers Chrome during a 5-10 s capture loses the capture.

Aborting isn't entirely wrong: an occluded renderer stops producing frames, so the slices would be stale. But it should not end the capture.

Fix:
- Treat minimised or hidden as **pause**, not abort. The agent stops stepping and reports `paused`. The SW shows a "⏸" badge and resumes on `visibilitychange: visible` or `windows.onBoundsChanged`/a state poll. Give up after about 30 s with the current partial.
- Run the check **before** shooting, not after.
- Put `document.visibilityState` in each `positioned` reply and reject a frame taken while hidden.
- Log `win.state`, `win.focused` and `visibilityState` with the stop reason for field diagnosis.

### 5. MEDIUM: copy or download can stay "copying" / "saving" forever [ran]
Files: `src/editor/engine/store.ts:818-858`, `exporter.ts:179`.

There is no watchdog on the export promise. Headless `clipboard.write` stays pending for more than 15 s when the blob promise never settles. A worker that dies without an `error` event (OOM, termination) or a hung IDB read leaves the spinner up forever.

Fix: race against a timeout of 20-30 s scaled by plan area. On timeout, terminate and recreate the worker and show a readable error.

### 6. MEDIUM: stuck states after SW death or a storage error [ran: UI probes]
- **Endless "Capturing the page · 3 of 9".** `src/shared/handoff.ts:116` `waitForFinalSession` has no staleness timeout. `recoverInterrupted` runs only when the SW starts, and an editor page doesn't wake the SW.
- **Endless "Opening capture".** `handoff.ts:77-85`: the async fallback in `watchSessionStatus` has no `catch`, so a rejected `storage.session.get`/`getSession` never settles. Confirmed in a probe, with an unhandled rejection.
- **Stuck badges.** `orchestrator.ts:483-497`: the listeners that clear the badge live only in SW memory, so a red "!" stays after the SW idles out. `markInterrupted` (`:549-566`) never clears a stale "42%" badge and never opens the editor.
- **Stuck badge and no editor if finalize throws.** `orchestrator.ts:199-202`: if `finalize()` throws (an IDB write fails, e.g. disk full), `run()` rejects. The badge stays at its last %, `active-capture` stays set and no editor opens. If the first `save()` at `:188` throws, the click silently does nothing.

Fix:
- Treat `capturing` with `updatedAt` older than about 20 s, and not equal to `active-capture`, as interrupted in the editor. Or message the SW to trigger recovery.
- Add a `catch` that maps to `LOAD_FAILED`.
- Store the `tabId` on the session and have the editor clear the opener's badge.
- Wrap `finalize`/`openEditor` so the badge always ends in "!" or clear, and so an editor (or at least a red badge with a title) always appears.
- Reset the cached rejected `dbPromise` (`db.ts:50-67`), and add `blocked`/`terminated` handlers.

### 7. MEDIUM: a failed slice write produces a "partial" session that references missing slices [read]
Files: `orchestrator.ts:302-307, 389-391, 397`.

When one `putSlice` rejects (quota or disk), the `persist` chain is rejected and every later slice is silently not stored, yet capture continues to the end. `finalize()` then writes `s.slices = [...this.slices]`, which includes the unstored ones. The layout points at blobs that don't exist, so the editor's tiles and export fail (`getSliceBlob` throws "not found").

Fix:
- Track `persistedCount`.
- Stop the capture on the first failure.
- Build the layout only from the persisted slices.

### 8. MEDIUM: export edge cases [ran]
- **Smart region negative height.** `src/editor/engine/scope.ts:127-149`: when every shape has been dragged off the image, Cmd+C copies a 1440x1 image and the toast says it succeeded. Fix: fall back to the viewport outcome when `h <= 0`.
- **Canvas allocation fallback never runs.** `exportCore.ts:86-87, 124-125`: Chrome returns a non-null context for a canvas it failed to allocate. `convertToBlob` then throws a raw `IndexSizeError` instead of the code switching to the streamed path, and `getImageData` on the streamed path would return black. Fix: try/catch, retry streamed, and probe one pixel after allocating.
- **Stale and costly right-click image.** `controller.ts:879-883`, `store.ts:466-481`: right-click "Copy image" can serve a stale revision, because `armImg` never compares `_compositeRev` with `doc.rev`. Every edit re-renders the whole page for that `<img>`: about 350 MB for a 70k-px page, and since it can't be aborted, Cmd+C waits behind it.

### 9. MEDIUM: autosave can lose or overwrite edits [read]
- **Restored backup never saved.** `store.ts:622-631, 665`: a doc restored from the sessionStorage backup is never written back to IDB. Reload and then close the tab, and the edits are gone.
- **Two tabs overwrite each other.** `autosave.ts:101`: two editor tabs on one session write over each other, with no rev check.

Fix: schedule an autosave after a restore that wins on rev. Use `navigator.locks` to make a second tab read-only, or compare-and-set the rev inside the transaction.

### 10. MEDIUM (privacy): incognito captures persist in the regular profile [read]
Files: `wxt.config.ts:32-52` (no `incognito` key, so the default is `spanning`), `orchestrator.ts:447-466`.

If the user allows the extension in incognito, the screenshots, URL and title of incognito pages go into the extension's single IDB. They stay on disk for up to 30 days after the incognito window closes. The editor tab also can't open in the incognito window and falls back to a regular window.

Fix: skip persistence for `tab.incognito` (keep it in memory, or delete it when the window closes), or use `incognito: 'split'`.

### 11. LOW: scale is measured slightly wrong at browser zoom [ran]
Files: `orchestrator.ts:277`, `session.ts:131` (`viewport.w = innerWidth`, an integer).

`review.zoom.spec.ts` on `bands.html` at DPR 2:

| Zoom | Measured scale | True scale | Image height | Last rule |
|---|---|---|---|---|
| 110% | 2.20120 | 2.2 | 17609 instead of 17600 | 9 px low |
| 150% | 3.00117 | 3.0 | +9 px | |
| 90% | | | +2 px | |
| 125% | exact | | | |

Band colours were correct at every row centre, so there are no visible seams; the 2 px overlap absorbs it. But each seam duplicates about 1 image px, and `css.h` comes out fractional (7999.9).

Fix: use `devicePixelRatio` when it is within 1% of `bitmap.w / innerWidth`, or measure the fractional width with `visualViewport.width`.

### 12. LOW: tab and URL integrity [read]
`checkTab` (`orchestrator.ts:346-355`) never compares `tab.url` with `session.url`. PLAN §3 says "verify tab/URL before every frame". An SPA route change (pushState) mid-capture doesn't disconnect the port, so slices from two routes are stitched together silently. Fix: compare the URL (without the hash) on every frame and stop with `navigated`.

### 13. LOW: multiple windows, double-clicks and cancel wording [read]
Files: `src/entrypoints/background.ts:24-26`, `src/editor/ui/messages.ts:220-223`.

- A toolbar click in **another** tab or window while a capture runs cancels the first capture and doesn't start one for the new tab. A click there within the first 800 ms is silently ignored.
- A slow double-click (more than 800 ms, common because nothing visible happens during prepare) cancels the capture. The editor then says "You pressed Esc before the first screenshot was taken."

Fix:
- Only treat a click as cancel when `tab.id === active.tabId`.
- For other tabs, show a "busy" badge or queue the capture.
- Word the cancel message for both Esc and click.

### 14. LOW: the SW keeps every slice blob in memory [read]
`orchestrator.ts:122, 293`. `this.blobs` holds every slice, up to 250 x 2-4 MB, but only `blobs[0]` is used (by `sideRuns`). Fix: keep only the first.

### 15. LOW: the page can cancel a capture [read]
`main.ts:46-52`. `onKey`/`onHide` don't check `isTrusted`, so a page script can cancel any capture with a synthetic Escape or `pagehide` event. Low impact: the page can't inject anything or read data. Fix: `if (!e.isTrusted) return`.

### 16. LOW: engine and UI robustness [read; some ran]
- `clipboard.ts:19-22`: every `NotAllowedError` is treated as "not focused". Raw error strings reach the toast.
- `controller.ts:808-818`: Cmd+C inside an open text box does nothing visible.
- `annotations.ts:140`: `migrateDoc` doesn't validate shapes, so one bad stored shape throws in every frame and leaves the canvas blank. There is no React error boundary (`entrypoints/editor/main.tsx`, `options/main.tsx`).
- `controller.ts:245, 388`: pen drafts cost O(n²) per stroke, and points are never simplified.
- `settings.ts:79-99`: settings are not validated, and concurrent writes lose updates.
- `filename.ts`: filenames have no overall length cap.
- `App.tsx:37-40`: page titles stay in History via `document.title`.

---

## Checked and fine
- **Production build** (`pnpm build` in the copy):
  - Permissions are exactly `activeTab, scripting, storage, unlimitedStorage, contextMenus`.
  - There are no `host_permissions`, `web_accessible_resources` or `externally_connectable` entries and no custom CSP, so the MV3 default applies.
  - `__pagesnapTest`, `__pagesnapEngine`, `__pagesnapUi`, `__pagesnapCapture`, `seedSyntheticSession` and `<all_urls>` are all absent from `.output/chrome-mv3` [ran]. They are present in the e2e build, as expected.
  - Web pages can't iframe, navigate to or fetch `editor.html` or `agent.js` [ran by the UI reviewer].
- **Agent messaging:**
  - The SW only accepts the port named `pagesnap/agent` from `frameId 0` of a tab that has a pending inject waiter.
  - Web pages can't `runtime.connect` without `externally_connectable`, and other extensions arrive on `onConnectExternal`.
  - Page-controlled geometry is bounded by `capRange` (`maxCssHeight`, `MAX_SLICES`).
- **Storage and rendering:** `storage.session` keeps its default trusted-only access level. There is no `innerHTML`, and page URLs only become links behind an `http(s)` check.
- **Rate limit:** a 530 ms minimum gap, plus quota retries that re-wait the gap. Only one capture runs at a time.
- **Capture integrity:**
  - Tab close, navigation and tab switch are detected.
  - DPR changes (moving to another monitor) are detected through `SCALE_CHANGED`.
- **Clipboard:**
  - The `ClipboardItem` with a Promise<Blob> is created synchronously inside the gesture.
  - Late resolution after focus moved still works headless.
  - A rejected export does leave the `copying` state.
- **Editor internals:**
  - IME composition is guarded (`isComposing` / 229).
  - Undo history is capped at 200 snapshots with structural sharing.
  - Revs increase strictly.
  - Evicted and aborted tile bitmaps are closed.
