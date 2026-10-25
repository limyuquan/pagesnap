# 03 — Annotation editor: technical approach

Status: research, Oct 2026. Scope: the result page that opens after a full-page capture, which
should *be* the editor (no separate "Edit" mode), plus the one-keystroke "copy annotated image" path.

Numbers marked **[measured]** come from a local benchmark: Playwright + Chromium 156 (new headless)
on Apple Silicon, 25 Oct 2026. Treat them as a lower bound and expect roughly 1.5-3x slower on mid-range
Windows laptops. Library versions and licences come from `npm view` on the same day.

---

## 0. Decision summary

- **Renderer: our own Canvas2D renderer over our own immutable shape model.** No editor framework.
  Use `perfect-freehand` (MIT, 2 KB gz) for the pen tool. Konva is the fallback if hand-rolled selection
  or transform work slips. tldraw, Excalidraw, Fabric and marker.js are rejected (reasons in §2).
- **One `drawDoc(ctx, doc, view)` function** handles the on-screen viewport and the full-resolution
  export (OffscreenCanvas in a worker). Sharing one function is how we get WYSIWYG.
- **The editor viewport is a single viewport-sized `<canvas>` with a camera.** The base image is held as
  ImageBitmap tiles and redrawn every frame. There is never a 30000-px-tall on-screen canvas.
- **Copy = `Cmd/Ctrl+C`.** The `ClipboardItem` gets a Promise<Blob>, called synchronously in the key
  handler. The PNG is pre-encoded in a worker after every commit, so the keystroke usually resolves instantly.
- **Copy scope defaults to "AI-sized"**: the region around the annotations, capped near
  1400 x 2576 CSS px. A 1400 x 30000 page pasted whole is shrunk by Claude to about 120 px wide (§5).
  `Shift+Cmd+C` copies the full page.
- **Native right-click "Copy image" keeps working.** A hidden `<img>` showing the latest composite
  becomes the hit target on right-button pointerdown. I verified that the contextmenu target swaps
  (event-level check only; the native menu itself can't be seen headless).

---

## 1. What GoFullPage ships today (and where it falls short)

Source: the installed GoFullPage **8.10** (Web Store build, updated 2026-10-22, ~11M users, 4.9 stars).
I read it at `~/Library/Application Support/Google/Chrome/Default/Extensions/fdpohaocaechififmbbbbbknoalclacl/8.10_0/`
(the `editor.*.js` bundles), and cross-checked against the Web Store listing and changelog. The public
GitHub repo has no editor; that code is private.

**What it has.** A React + **SVG** editor (`createElementNS`, `feGaussianBlur`, a layers pane). It opens
from the capture page ("Back to capture (changes are auto-saved in the editor)"). Tools:
- Shapes: Rectangle, Oval, Line, Arrow
- Text with Bold/Italic/Font
- Blur
- Emoji/Stickers
- Crop
- Padding/Border, a browser-chrome/URL frame, and a capture timestamp
- Undo/redo, zoom, layers with drag-to-reorder

Its built-in shortcut table:

| Action | Key | Action | Key |
|---|---|---|---|
| Arrow | A | Rectangle | R |
| Oval | O | Line | L |
| Text | T | Blur | B |
| Crop | C | Padding | P |
| URL/browser frame | U | Zoom in / out | Z / Opt+Z |
| Undo / Redo | Cmd+Z / Cmd+Y | Duplicate | Cmd+D |
| Export | Cmd+E | Export as | Cmd+Shift+E |
| **Copy to clipboard** | **Cmd+Opt+E** | Help | Shift+? |

**Gaps relative to our goal (annotate immediately, then paste into an AI chat):**
1. **Annotated export is paywalled.** The bundle shows *"Sign up for Premium in order to export your
   edits."* and *"You need to sign up in order to export your edited image."* (`user.isSubOk` gate).
   Premium costs $1/mo per gofullpage.com/premium; one 2026 comparison site says $12/yr. Free users can
   draw but can't copy or download the result.
2. **Editing is a second step.** The capture page and the editor are separate, so annotating means an
   extra click and a mode switch.
3. **Copy is `Cmd+Opt+E`**, not `Cmd+C`.
4. **The copy can fail on focus loss.** It encodes first and then passes an already-resolved Blob to
   `ClipboardItem`. The UI warns *"wait to see the 'Image copied to clipboard' message before switching
   to another window."* That is the Chrome focus-loss failure mode (§4.2).
5. **Copies are sized for Google Docs, not AI.** `fitToMaxPixels(..., GOOGLE_DOCS_MAX_PIXELS = 25e6)`
   caps at 25 MP, so a 1400 x 17800 strip goes through unchanged and the AI model then crushes it (§5).
6. **Missing tools:** no freehand pen, highlighter, underline, numbered steps or pixelate.
7. **Very tall pages get split.** The Web Store FAQ says they open "into images in separate tabs".
   The old public code caps at 30000 x 8000; Chrome's real limit is much higher today (§3.1).

Our editor improves on each point:
- The result tab opens with the Arrow tool armed.
- `Cmd+C` copies with focus-safe Promise semantics.
- Encoding is pre-warmed, so copy is instant.
- The default copy is AI-sized.
- It adds highlighter, underline, steps, pixelate and pen.
- It has no export paywall.

---

## 2. Rendering approach options

| Option | Version / licence (Oct 2026) | min / gzip [measured, esbuild] | Fit for us |
|---|---|---|---|
| **Own Canvas2D + model** | n/a | ~15-25 KB est. | **Recommended** |
| SVG overlay on `<img>` + rasterize on export | n/a | ~15 KB | Plausible; rejected (two renderers) |
| Konva (+ react-konva) | 10.9.0 MIT (react-konva 19.3.2) | 193 / 59 KB (react-konva+React: 551 / 169 KB) | Best library fallback |
| Fabric.js | 7.4.0 MIT | 276-293 / 86-92 KB | Workable, heavier, OO-mutable |
| Paper.js | 0.16.0 MIT | 294 / 104 KB | Vector-math oriented, wrong tool |
| marker.js 3 | 3.10.0 **Linkware** (paid licence removes badge) | 136 / 23 KB | Closest in purpose; licence and style don't fit |
| tldraw SDK | 5.5.2 **tldraw licence** | 2193 / 661 KB | No: licence key + watermark, size |
| Excalidraw | 0.18.1 MIT | ~8.3 MB / 2.5 MB (all chunks inlined) | No: size, hand-drawn look, image caps |

### Notes per option

**tldraw 5.x.** Production use requires a licence key, and the key is checked against the hostname.
`LicenseManager.getIsDevelopment()` treats only `http:`, loopback, or a non-production `NODE_ENV`
as dev, so a `chrome-extension://<id>` page in a production build is "production". Without a key
it "stops rendering the editor after five seconds". The options are:
- a 100-day trial, one per project
- a hobby licence (non-commercial, watermark kept, granted at tldraw's discretion)
- a commercial licence (annual, price on request)

It is also far more than we need: a multiplayer-grade infinite canvas, around 660 KB gz. **Reject.**

**Excalidraw 0.18.1 (MIT).** Very heavy. Its UI and rough.js style are wrong for crisp screenshot
annotation. Inserted images are capped by `DEFAULT_MAX_IMAGE_WIDTH_OR_HEIGHT = 1440` and
`MAX_ALLOWED_FILE_BYTES = 4 MB`, which you can work around with `addFiles` but which signals the
image is not the "document". **Reject.**

**marker.js 3 (3.10.0).** A headless image-annotation library (MarkerArea / MarkerView / Renderer):
SVG-based markers, `getState()` serialization, and `Renderer.rasterize()`. It is the closest in
purpose. The catch is the Linkware licence: the copyright notice must stay, plus "a link back to the
software's website, shown while the software runs". A paid OEM or single-app licence removes that.
We would also fight it on large-image tiling, viewport-only rendering, the AI-sized export and the
custom tool feel. **Reject.** Worth reading its tool UX for ideas.

**Fabric.js 7.4.0 (MIT).** Mature object model with selection, transform controls, IText inline
editing and `toDataURL({multiplier})`. Version 7 is essentially v6 with `originX/Y` defaulting to
`'center'`. Downsides:
- mutable OO objects, which make snapshot undo awkward (serialise the whole canvas JSON per step)
- ~90 KB gz
- export means sizing the Fabric canvas to the whole image or doing `viewportTransform` gymnastics
- pixelate needs per-object filters and caching on a 42 MP bitmap

**Konva 10.9.0 (MIT, actively released; react-konva 19.3.2).** Gives us:
- Stage/Layer canvases
- hit-testing via a colour-keyed hit canvas
- `Transformer` handles
- `globalCompositeOperation` per node, so multiply works
- `stage.toCanvas({x, y, width, height, pixelRatio})`

Costs: no undo, and it keeps its own scene graph, which we would mirror from our model.
Filters such as Pixelate need `node.cache()`, which is expensive on big regions. It is a sound
fallback if hand-rolled transform handles prove fiddly.

**SVG overlay on `<img>`.** Attractive at first: DOM hit-testing, crisp at every zoom, no scroll
"swim", and text via `<foreignObject>`/`<textarea>`. GoFullPage does this. The problem is export.
We'd rasterize the SVG (fonts must be inlined because SVG-as-image can't load them; `foreignObject`
taints or fails), and pixelate/blur preview (CSS `backdrop-filter`, SVG filters) behaves differently
from the export path. That means two renderers and permanent "it looked different on screen" bugs.

### Recommendation: own Canvas2D renderer

1. **One code path for screen and export.** `drawDoc()` runs on a viewport canvas, scaled by
   camera x DPR, and on a full-resolution OffscreenCanvas in a worker. Pixelate reads base pixels the
   same way in both, and multiply highlighter is the same `globalCompositeOperation`.
2. **The shape set is small and simple:** about 10 kinds, axis-aligned boxes, two-point lines,
   polylines, and no rotation in v1. Geometric hit-testing (point-to-segment distance, point-in-ellipse,
   bbox) is under 150 LOC. Handles are 8 box handles, 2 endpoint handles, and one "bend" handle for
   arrows.
3. **We control tiling, memory and the export region.** These are the hard, product-specific parts
   (§3, §5), and libraries help least with them.
4. **Bundle is ~20 KB vs 60-660 KB.** Both are fine in an extension, but less code means fewer
   surprises.
5. **The immutable model makes undo, serialization and pre-encode caching trivial** (§7).

Estimated effort: 1.5-2.5 weeks for a polished v1, including handles, text editing, the keyboard map
and the worker export. With Konva, maybe 25% less on selection, but the export and tiling work stays.

---

## 3. Large-image handling

### 3.1 Chrome canvas limits (Chromium 156) [measured]

| Canvas | Result |
|---|---|
| 1400 x 32767, 1400 x 65535 | OK |
| 1400 x 65536, 1 x 100000 | fail (per-side cap **65535**) |
| 16384 x 16384 (= 268,435,456 px) | OK |
| 16384 x 16385, 9000 x 32767 | fail (area cap **268,435,456**) |
| 2800 x 60000 (DPR-2 capture of a 30000 CSS-px page) | OK (168 MP) |
| `new OffscreenCanvas(1400, 60000)` | OK |

The old "32767 max side" lore is stale. Current Chrome allows 65535 per side and 2^28 px of area.
GoFullPage's public constants (30000 x 8000) are conservative. Failure is silent: `getContext` returns
null, or the canvas reads back blank. **Always probe** with a 1x1 `fillRect` + `getImageData` at the
far corner, exactly as the benchmark did, and fall back to splitting or downscaling.

### 3.2 Memory is the real ceiling

A decoded bitmap costs `w * h * 4` bytes.

| Image | Decoded size |
|---|---|
| 1400 x 30000 | **168 MB** |
| 2800 x 60000 | **672 MB** |

A naive editor holds the base `<img>`, a full-size annotation canvas, a full-size composite and an
export canvas at the same time. That is 4 x 672 MB, which kills the renderer. Rules:
- **Never create a full-size on-screen canvas.** The display canvas is viewport x DPR, for example
  1600 x 1000 CSS x 2 = 25 MB.
- **Keep the base as tiles.** The capture stage already produces per-viewport screenshots. Store them
  as PNG Blobs in IndexedDB, keyed by capture id, and normalise them into horizontal strips about 2048
  image px tall. On the main thread, keep `ImageBitmap`s only for strips within ±1 screen of the
  viewport (an LRU of ~6), and `close()` evicted ones. Decoding is cheap: a full 1400 x 30000 PNG
  decoded in 142 ms [measured], and a strip in a few ms.
- **Export is the only time a full-size bitmap exists,** and it lives in the worker. The worker decodes
  strip Blobs itself (`createImageBitmap(blob)`), draws them, closes them immediately, encodes, and
  then drops the canvas (`canvas.width = 0`).
- Above ~120 MP (some DPR-2 captures), prefer a 1x-CSS-scale export for clipboard use. AI models
  downscale anyway (§5). Native resolution stays available for Download.
- Optional, post-v1: images beyond the canvas limits can use a **streaming PNG encoder**. Render
  2048-row strips, `getImageData`, apply filter byte 0, and pipe through `CompressionStream('deflate')`
  into IDAT. Memory stays bounded and height is unlimited, which removes "split into tabs" for Download.

### 3.3 Viewport, zoom, pan and DPR

- **Coordinate space.** All shapes are stored in **image pixels** (native capture pixels).
  `doc.image.dpr` records the capture DPR, so we can convert CSS-px defaults with
  `px = cssPx * dpr`. The camera is `{ x, y, zoom }`, where `zoom` = CSS px per image px.
- **Draw transform:** `ctx.setTransform(z*D, 0, 0, z*D, -cam.x*z*D, -cam.y*z*D)` with
  `D = devicePixelRatio`. Re-read D on `matchMedia('(resolution: Xdppx)')` change, for example when the
  window moves between monitors.
- **Frame cost.** Each frame draws 1-3 visible base strips and the shapes whose bbox intersects the
  view. `drawImage` of a 2800 x 4096 strip took ~0 ms [measured]. Only render when something is dirty
  (rAF-coalesced).
- **Default view is fit-width**: `zoom = min(1/dpr, (viewportW - gutter) / image.w)`, so a DPR-2
  capture on a DPR-2 screen displays 1:1 device pixels. Scrolling must feel like a web page:
  - **wheel / trackpad two-finger:** pans vertically. macOS momentum deltas keep arriving, so
    inertia is preserved.
  - **Shift+wheel:** pans horizontally.
  - **Ctrl/Cmd+wheel and pinch** (a `ctrlKey` wheel event): zoom around the cursor.
  - **Space+drag:** pans.
  - **Cmd+0:** fit width. **Cmd+1:** 100%. **Cmd+= / Cmd+-:** zoom in / out.
- **Draw a slim custom scrollbar plus a minimap** on the right: a thumbnail of the whole page with
  annotation markers. On a 30000-px page this is how users find their place. The minimap is a
  ~120-px-wide downscaled render, generated once in the worker.
- Disable image smoothing above 200% zoom so pixels stay inspectable. Keep `imageSmoothingQuality =
  'high'` when zoomed out.
- **Text editing overlay.** While editing text, position a `<textarea>` over the canvas using the camera
  transform, with `font-size = size*zoom`. Hide the shape's canvas rendering until the edit commits.

---

## 4. Export + clipboard

### 4.1 Timings [measured, Chromium 156, M-series]

| Operation | Time | Output |
|---|---|---|
| PNG encode 1400 x 30000, text page, main-thread `toBlob` | 370 ms | 17.7 MB |
| same, worker `OffscreenCanvas.convertToBlob` | 329 ms | 17.7 MB |
| PNG 1400 x 30000 with noisy/photo regions | 359 ms | 46.9 MB |
| PNG 2800 x 60000 text | 681 ms | 28.3 MB |
| PNG 1400 x 2600 (AI-sized region) | **38 ms** | 1.6 MB |
| WebP 1400 x 30000 (lossy, default) | 1144 ms | 1.9 MB |
| JPEG 1400 x 30000 | 209 ms | 7.5 MB |
| `clipboard.write` PNG 1400 x 30000 | 157 ms | |
| `clipboard.write` PNG 2800 x 60000 | 433 ms | read back intact, 2800 x 60000 |
| `ClipboardItem` with a Promise resolving after 3 s | succeeded | |
| `clipboard.write` with `image/webp` | **rejected**: "Type image/webp not supported on write" | |

Takeaways:
- Chrome's PNG encoder is fast. The full page is ~0.3-0.7 s and the AI-sized region is ~40 ms.
- Chrome **re-encodes** clipboard PNGs: 17.66 MB went in and 14.99 MB came back. Any metadata chunks
  we embed (§7.3) **won't survive the clipboard**, only Download.
- `image/png` is the only safe clipboard image type. `ClipboardItem.supports('image/png') === true`.

### 4.2 Copy pipeline (focus-safe, instant)

- Call `navigator.clipboard.write()` **synchronously inside the keydown/click handler** and pass
  `ClipboardItem({'image/png': promise})`. Chrome ties focus and activation checks to the call, and
  the Blob can arrive later; the 3 s delayed Promise succeeded [measured]. The same form is required
  by Safari, so it also serves any future port.
- GoFullPage's approach is the anti-pattern: `await encode(); write(blob)`. If the user Cmd-Tabs to
  ChatGPT during the encode, the document has lost focus and Chrome throws `NotAllowedError: Document
  is not focused`.
- **Pre-warm.** After every commit, idle-debounced by 400 ms, ask the worker to render and encode the
  *default copy scope* for that `doc.rev`. Cache the result as `Map<rev+scope, Promise<Blob>>`, keeping
  the last 2 entries. `Cmd+C` then usually hits a resolved promise. On a miss it waits ~40-700 ms,
  which the Promise semantics make safe.
- **Feedback.** Show a tiny toast: "Copied, 1400 x 2576". Show a scale hint when the copy will be
  downscaled by AIs (§5). On rejection, toast "Click the page, then Cmd+C again".
- **Extension context.** Declare `"clipboardWrite"` in the manifest. MDN says it removes the
  transient-activation requirement in extension contexts. Since Chrome 122 the document still needs
  focus. The service worker has no `navigator.clipboard`, so all copy happens in the editor tab. A
  global `chrome.commands` "capture and copy" would need the tab focused first.
- No practical size limit was hit at 168 MP / 28 MB, but chat apps have their own upload caps:
  - claude.ai: 10 MB per image, 8000 x 8000 max on the API
  - ChatGPT: varies

  This is another reason the default scope is AI-sized.

```ts
// editor/copy.ts
export function copyCurrent(scope: CopyScope = 'smart') {
  const blobP = exportCache.get(doc.rev, scope) ?? exportCache.start(doc, scope); // Promise<Blob>
  return navigator.clipboard
    .write([new ClipboardItem({ 'image/png': blobP })])        // called synchronously in handler
    .then(() => toast(`Copied ${sizeLabel(scope)}`))
    .catch(e => toast(e.name === 'NotAllowedError' ? 'Click the page, then ⌘C again' : 'Copy failed'));
}
```

```ts
// worker/export.ts  (module worker, owns no long-lived bitmaps)
self.onmessage = async ({ data }: MessageEvent<ExportJob>) => {
  const { id, doc, strips, region, scale } = data;     // strips: {y, h, blob}[]
  let W = Math.round(region.w * scale), H = Math.round(region.h * scale);
  ({ W, H, scale } = fitCanvasLimits(W, H, scale));    // ≤65535/side, ≤268_435_456 area, probe-verified
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d', { alpha: false })!;
  g.setTransform(scale, 0, 0, scale, -region.x * scale, -region.y * scale);
  for (const s of strips) if (s.y < region.y + region.h && s.y + s.h > region.y) {
    const bmp = await createImageBitmap(s.blob);
    g.drawImage(bmp, 0, s.y); bmp.close();
  }
  drawShapes(g, doc, region, { base: (r) => readBase(g, r) });  // same code as on-screen
  const blob = await c.convertToBlob({ type: 'image/png' });
  c.width = c.height = 0;                                       // free backing store early
  (self as any).postMessage({ id, blob });
};
```

Redaction needs base pixels *before* annotations. `drawDoc` therefore draws base, then redactions
(which sample the already-drawn base region via `drawImage(canvas, ...)`), then highlights, then
everything else. See §6.

### 4.3 Keeping native right-click "Copy image" working

- Keep a hidden `<img id="composite">` stacked above the canvas with `opacity: 0;
  pointer-events: none; draggable=false`. Point its `src` at an object URL of the latest pre-warmed
  **full-page** composite, generated at idle (§4.2) and revoked when replaced.
- On `pointerdown` with `button === 2`, set `pointer-events: auto` on it. Chrome hit-tests again for
  the context menu, and the `contextmenu` target became the `<img>` [measured: `pd:canvas:2 →
  cm:hot`]. Chrome's native menu then offers *Copy image / Save image as / Open image in new tab* for
  the composite. Reset `pointer-events` on the next `pointermove`/`pointerdown`.
- Caveat: headless can't show the native menu. Confirm by hand on macOS (menu on mousedown) and
  Windows (menu on mouseup).
- If the composite is stale (a commit within the last ~500 ms), it is one edit behind. That's acceptable.
- Memory: the full-page composite `<img>` is decoded lazily by Chrome. Use a 1x-scale composite for
  DPR-2 captures above ~120 MP.

---

## 5. Design for AI vision input

This constraint drives the copy scope and the default stroke sizes.

**Claude** (platform docs, Oct 2026):
- Claude 4.7+ uses a high-resolution tier: **2576 px long edge, 4784 visual tokens** (28 x 28 patches).
  Older models: 1568 px / 1568 tokens.
- API maximum is 8000 x 8000; claude.ai caps images at 10 MB.

**OpenAI GPT-5.5:**
- `high` detail: 2048 px / 2500 patches.
- `original` detail: 6000 px / 10000 patches, with 32-px patches. `auto` maps to `original` on 5.5.

What a full 1400 x 30000 page becomes:

| Model input | Size the model sees | Readable? |
|---|---|---|
| Claude HR | ~120 x 2576 | No |
| GPT-5.5 original | ~280 x 6000 | No |

What a **1400 x 2576 region** becomes:

| Model input | Size the model sees |
|---|---|
| Claude HR | ~1400 x 2576, native |
| Claude standard | ~815 x 1500 |
| GPT-5.5 original | native |

So:
1. **Default copy scope `'smart'`:**
   - Take the union bbox of all shapes, pad it by `max(160 CSS px, 10%)`, and widen it to the full
     image width. Full width keeps layout context such as LMS nav, and is ≤ 1600 CSS px on most pages.
   - Clamp the height to `≤ 2576 * dpr` image px, centred on the bbox.
   - If the bbox is taller than the cap, copy the bbox anyway and show "Tall: AI will see this at ~X%".
   - With no annotations, copy the current viewport, not the whole page.
   - An explicit **crop** overrides smart scope.
   - `Shift+Cmd+C` = full page.
   - Export DPR-2 captures at 1x (CSS px) by default for copy. It's the same information at the AI
     resolution, and we choose the resampling filter.
2. **Size defaults in CSS px, multiplied by `dpr` at creation.** They are chosen to survive ~0.55x
   downscaling (Claude standard tier):

| Tool | Default (CSS px) | Notes |
|---|---|---|
| Arrow | 6 px stroke, head length `max(18, 4*stroke)` | Head is a filled 28° triangle |
| Rect / ellipse outline | 5 px | Radius-4 corners on rects |
| Underline | 5 px | |
| Highlighter | 22 px tall, `#FFD60A` @ 0.45 alpha, multiply | Roughly one line of body text; `[`/`]` adjusts |
| Pen | size 6 | |
| Text | 26 px bold system sans | |
| Step marker | 34 px diameter, 20 px bold numeral | |

3. **Colours.** Default **red `#FF3B30`**. It reads on white LMS pages and survives JPEG-ish
   resampling. Palette, keys 1-8:
   - red `#FF3B30`
   - orange `#FF9500`
   - yellow `#FFD60A`
   - green `#34C759`
   - blue `#0A84FF`
   - purple `#AF52DE`
   - black `#111111`
   - white `#FFFFFF`

   Every stroke and text shape gets a subtle contrast shadow (`shadowBlur 3*dpr, rgba(0,0,0,.35)`),
   on by default and toggleable, so red stays visible on dark headers. Text defaults to a white
   outline (stroke 4 px, then fill) rather than a filled label, so it doesn't hide content.

---

## 6. Tools

Common behaviour for every tool:
- The tool stays active after drawing (CleanShot-style), so you can draw several arrows quickly.
- `Esc` returns to Select.
- Pointer-down on an existing shape's handle edits it, whatever the active tool.
- Shapes are created with pointer capture.
- Snapping uses Shift, and Alt draws from the centre.

| Tool | Gesture | Rendering / details |
|---|---|---|
| **Arrow** | drag a → b | `bend` = signed perpendicular offset of a quadratic control point, edited via a midpoint handle (curved arrows). Shift snaps the angle to 15° steps. Shorten the shaft by `0.8*headLen` so the line doesn't poke through the tip. Round line caps. Optional double-head. Arrows shorter than `headLen*1.5` are dropped on release (accidental clicks). |
| **Rect / Ellipse** | drag | `fill: 'none' \| 'tint' \| 'solid'`. Tint = same colour @ 0.15 alpha. Shift = square/circle. Hit-test: near the border when `none`, inside when filled. `F` toggles the fill of the selection. |
| **Underline** | drag | Locked horizontal (y = start y) unless Shift. Square caps. Endpoints snap to round pixels for crispness. |
| **Highlighter** | drag | Straight horizontal band by default (`a`, `b`, `thickness`), `globalCompositeOperation='multiply'`, butt caps, so text stays readable. Shift-drag = freehand marker (perfect-freehand with `thinning: 0`). Rendered beneath other annotations. Overlaps darken (accepted, matches real markers). |
| **Pen** | drag | Store raw `[x, y, pressure]`. Render via `getStroke(pts, {size, thinning: .5, smoothing: .5, streamline: .5, simulatePressure: pointerType !== 'pen'})` → polygon → `Path2D` fill. Cache the `Path2D` in a `WeakMap<Shape, Path2D>`, which works because shapes are immutable. Hit-test against the simplified polyline. |
| **Text** | click (or drag for wrap width) | Opens a textarea overlay. Enter = newline, `Esc` or click-away commits, empty text deletes. Double-click a text shape to re-edit. Canvas wrap is a simple greedy `measureText` loop when `maxW` is set. Use a system font stack (no webfont load in the worker). |
| **Step marker** | click (drag adds a tail pointing at a target) | Filled circle with a white numeral. Number = 1-based order among step shapes by `seq`, so deleting #2 renumbers 3 → 2 automatically. |
| **Redact** | drag | Modes: `pixelate` (default), `blur`, `solid`. Pixelate: block size `max(8*dpr, round(min(w, h)/6))`, implemented by drawing the base region into a tiny canvas (`w/block x h/block`) and back up with `imageSmoothingEnabled = false`. Blur: `ctx.filter = 'blur(12px)'`, supported on OffscreenCanvas. Samples **base pixels only** and draws before other shapes. Gaussian blur of text can leak, so warn in the tooltip and keep pixelate or solid as default. |
| **Crop** | drag a region, handles adjust | Non-destructive `doc.crop`. The outside is dimmed 50% in the editor. Enter applies and Esc cancels. It is undoable and overrides the copy scope. |
| **Select** | click / marquee | Shift-click toggles. Shows box handles (8), or endpoint and bend handles for lines/arrows. Arrow keys nudge 1 px, Shift+arrow nudges 10 px (image space). Alt-drag duplicates. |

Hit-test tolerance is `8 CSS px / (zoom)` in image units. Test in reverse z-order and pick the topmost
hit. Selection handles are drawn in screen space (fixed 8 CSS px), never scaled with zoom.

---

## 7. Data model, undo/redo, serialization

### 7.1 Shape model

```ts
// model/types.ts — all coordinates in IMAGE pixels; all objects frozen (never mutated)
export type Id = string;                       // nanoid(8)
export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

interface Base { id: Id; seq: number; color: string; shadow: boolean }

export type Shape =
  | (Base & { kind: 'arrow'; a: Pt; b: Pt; bend: number; width: number; heads: 'end' | 'both' })
  | (Base & { kind: 'rect' | 'ellipse'; box: Box; width: number; fill: 'none' | 'tint' | 'solid' })
  | (Base & { kind: 'underline'; a: Pt; b: Pt; width: number })
  | (Base & { kind: 'highlight'; a: Pt; b: Pt; thickness: number; opacity: number })
  | (Base & { kind: 'pen'; pts: [number, number, number][]; size: number; marker: boolean })
  | (Base & { kind: 'text'; at: Pt; text: string; size: number; weight: 400 | 700; maxW?: number;
              style: 'outline' | 'label' })
  | (Base & { kind: 'step'; at: Pt; r: number; tail?: Pt })
  | (Base & { kind: 'redact'; box: Box; mode: 'pixelate' | 'blur' | 'solid' });

export interface Doc {
  v: 1;
  rev: number;                                  // bumps on every commit → export cache key
  image: { captureId: string; w: number; h: number; dpr: number;
           strips: { y: number; h: number; key: string }[];   // IndexedDB blob keys
           source: { url: string; title: string; capturedAt: string } };
  crop: Box | null;
  shapes: readonly Shape[];                     // array order = z-order (highlights/redacts drawn in their own passes)
  style: { color: string; widthCss: number; shadow: boolean };   // "sticky" tool defaults
}
```

### 7.2 Undo/redo: immutable snapshots, not commands

A `Doc` without the image is a few KB. A 200-step history is negligible memory, so snapshots are
simpler and can't drift the way inverse commands can.

```ts
// model/history.ts
export interface History { past: Doc[]; present: Doc; future: Doc[] }

export const commit = (h: History, next: Doc): History =>
  next === h.present ? h
  : { past: [...h.past, h.present].slice(-200), present: { ...next, rev: h.present.rev + 1 }, future: [] };

export const undo = (h: History): History => h.past.length
  ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h;

export const redo = (h: History): History => h.future.length
  ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h;

// structural sharing helpers
export const updateShape = (d: Doc, id: Id, patch: Partial<Shape>): Doc =>
  ({ ...d, shapes: d.shapes.map(s => s.id === id ? Object.freeze({ ...s, ...patch }) as Shape : s) });
```

- **Gesture coalescing.** During a drag, render a *draft* (`present` with the in-progress shape or
  transform applied in a local variable) and `commit` once on pointerup. One drag = one undo step. Text
  edits commit once on blur, not per keystroke. Nudges coalesce when they fall within 500 ms of each other.
- **Selection, camera and active tool** are *not* in `Doc`. They live in ephemeral editor state, so
  undo doesn't scroll you around. After an undo, drop selected ids that no longer exist.
- **Shared key.** `rev` is the export cache key and the autosave trigger.

### 7.3 Persistence and re-editing

- **Autosave.** Debounced by 1 s, write `Doc` JSON to IndexedDB (`docs` store, key `captureId`).
  Strips are already stored under `strips/<captureId>/<n>`. Reopening the capture from the extension's
  "Files" list restores it fully editable, history excluded.
  - Optional: persist the last 20 snapshots too.
- **Download** writes the flattened PNG plus an `iTXt` chunk `pagesnap:doc`. The chunk holds the Doc
  JSON with only a `captureId` reference, never base pixels. Dropping the PNG back onto the editor
  reopens it editable if the strips still exist locally; otherwise it opens as a plain image.
  - Clipboard copies lose the chunk because Chrome re-encodes them (§4.1). That's fine.
- **Privacy.** Redactions are destructive only in exported pixels. The local Doc keeps the original
  strips, so it can be re-edited. That is intended, but say so in the UI and offer "Delete capture".
  Export must never include unredacted pixels: `drawDoc` draws redactions unconditionally, with no
  "preview without redaction" path in export.
- **Schema.** Version with `v`, and write a migration table `v1 → v2` from day one.

---

## 8. Keyboard shortcuts

Conventions surveyed:
- **CleanShot X** (third-party list): A arrow, R rectangle, T text, M highlighter, C counter, P pixelate,
  F filled rect, D draw, L line, ⌘C, ⌘D.
- **GoFullPage 8.10** (§1): A, R, O, L, T, B, C crop, Z zoom, ⌘Z/⌘Y, ⌘D.

Snagit and Skitch lean on toolbar clicks, and I found no authoritative single-key tables for them.
Shottr's hotkeys are user-configurable and its docs don't publish defaults.

Our map. It is single-key when not typing, mirrors A/R/T/C from both tools above, and makes `⌘C`
the hero:

| Key | Action | Key | Action |
|---|---|---|---|
| `V` / `Esc` | Select (Esc also deselects, cancels crop or draft) | `⌘C` | **Copy annotated image (smart scope)** |
| `A` | Arrow | `⇧⌘C` | Copy full page |
| `R` | Rectangle | `⌘S` | Download PNG (`⇧⌘S` PDF) |
| `E` (alias `O`) | Ellipse | `⌘Z` / `⇧⌘Z` (and `⌘Y`) | Undo / redo |
| `U` | Underline | `⌫` / `Del` | Delete selection |
| `H` (alias `M`) | Highlighter | `⌘D` / Alt-drag | Duplicate |
| `P` | Pen (freehand) | `⌘A` | Select all annotations |
| `T` | Text | `1`-`8` | Colour |
| `N` | Numbered step | `[` / `]` | Thinner / thicker (selection or tool default) |
| `B` (alias `X`) | Redact (pixelate/blur/solid via `⇧B` cycle) | `F` | Cycle fill (none/tint/solid) |
| `C` | Crop | `Space`-drag | Pan |
| `⇧` while drawing | Constrain (15° / square / free underline / freehand highlight) | `⌘0` / `⌘1` / `⌘=` / `⌘-` | Fit width / 100% / zoom |
| `⌥` while drawing | From centre | `?` | Shortcut sheet |

Rules:
- Single-letter keys are ignored while a textarea or IME composition is active (`e.isComposing`).
- `⌘C` with shapes selected **still copies the image**. Copying the image is the product, so shape
  copy/paste is `⌘D` duplicate only in v1.
- Use `e.code` for letters only where layout-independence matters. Prefer `e.key` so AZERTY users get
  the letters printed on their keycaps.
- Show the key in each toolbar tooltip, and show `⌘C` as a persistent primary button: "Copy ⌘C".

---

## 9. Risks / open questions

1. **Native menu verification.** Confirm the right-click "Copy image" swap by hand on macOS and Windows
   (§4.3).
2. **Very large DPR-3 captures** (e.g. 4200 x 90000) exceed the canvas limits even in the worker.
   Download needs the streaming PNG encoder (§3.2). Copy should use 1x scale and the smart scope.
3. **Chat paste behaviour.** ChatGPT/claude.ai upload pipelines may differ from the API limits quoted
   above. Spot-check what they actually do with a pasted 1400 x 2576 PNG.
4. **Encode timings on low-end hardware.** Re-run the benchmark on a mid-range Windows laptop. If a
   full-page encode exceeds ~1.5 s, pre-warm only the smart scope and encode the full page on demand.
5. **Konva fallback trigger.** If selection and transform handles aren't solid by the end of week 1,
   swap the interaction layer to Konva and keep our model and `drawDoc` export.

---

## Sources

- GoFullPage 8.10 installed bundle (local, read-only grep) and
  [Chrome Web Store listing / changelog](https://chromewebstore.google.com/detail/gofullpage-full-page-scre/fdpohaocaechififmbbbbbknoalclacl)
- [GoFullPage Premium](https://gofullpage.com/premium) ·
  [capture-full-page.com comparison (competitor, unverified)](https://www.capture-full-page.com/blog/gofullpage-alternative) ·
  [MajorGeeks GoFullPage](https://www.majorgeeks.com/files/details/gofullpage.html)
- [tldraw licence key](https://tldraw.dev/sdk-features/license-key) ·
  [tldraw SDK licence](https://tldraw.dev/legal/tldraw-license) ·
  `@tldraw/editor` `LicenseManager.mjs` (v5.5.2)
- [marker.js 3 README](https://cdn.jsdelivr.net/npm/@markerjs/markerjs3@3.10.0/README.md) ·
  [marker.js 3 LICENSE](https://cdn.jsdelivr.net/npm/@markerjs/markerjs3@3.10.0/LICENSE) ·
  [markerjs.com](https://markerjs.com/)
- [Fabric.js 7 upgrade notes](https://fabricjs.com/docs/upgrading/upgrading-to-fabric-70/) ·
  [Konva README 10.x](https://unpkg.com/konva@10.6.0/README.md)
- [Claude vision docs: limits, resizing](https://platform.claude.com/docs/en/build-with-claude/vision) ·
  [OpenAI images & vision guide](https://developers.openai.com/api/docs/guides/images-vision/index.html)
- [web.dev async clipboard](https://web.dev/async-clipboard) ·
  [MDN: Interact with the clipboard (extensions)](https://developer.mozilla.org/Add-ons/WebExtensions/Interact_with_the_clipboard) ·
  [W3C editing issue #458 (Chrome 122 focus note)](https://lists.w3.org/Archives/Public/public-webapps-github/2024Feb/0124.html)
- [Blink HTMLCanvasElement history (area cap origin)](https://chromium.googlesource.com/chromium/blink/+/HEAD/Source/core/html/HTMLCanvasElement.cpp)
- [CleanShot X shortcuts (third-party)](https://pie-menu.com/shortcuts/cleanshot) ·
  [Shottr start guide](https://shottr.cc/kb/startguide)
- npm registry (`npm view`, 2026-10-25) for versions and licences. Bundle sizes from local esbuild
  `--minify` + `gzip -9`.
