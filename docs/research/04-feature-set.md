# 04 — Product & Feature Set

Research date: 2026-10-25. Scope: what GoFullPage does today, competitors, AI-workflow differentiators, roadmap.

**Sources and how much to trust them.** For GoFullPage I trusted three things: (a) the live Chrome Web Store listings, (b) the gofullpage.com site bundle, where the FAQ, premium table and pricing strings live inside `index.*.js`, and (c) the shipped CRX packages for the stable build (v8.10) and the BETA build (v8.10.1). I downloaded both CRX packages and read their `manifest.json`, `_locales/en/messages.json` and editor bundle. I did not run them. I did not use the 2016 GitHub repo. Competitor details come from vendor pages, review roundups and well-known product behaviour. Prices marked "~" are approximate because the sources disagree.

---

## 1. GoFullPage today

### 1.1 Snapshot

| | Stable | BETA |
|---|---|---|
| Store ID | `fdpohaocaechififmbbbbbknoalclacl` | `kehafhfdnkhdgbnpeofmhmbibmpnjaof` |
| Version / updated | 8.10 / 2026-10-23 | 8.10.1 / 2026-10-24 |
| Users / rating | ~11M / 4.9 (84.6K ratings) | ~300K / 5.0 (392) |
| Shortcut | Alt+Shift+P (`_execute_action`) | same |

- **Price:** Premium costs $12/yr ("$1 a month", billed annually) with a 7-day free trial. Enterprise adds multi-user accounts, a "guaranteed capture" SLA, a security audit and 5-seat or 25+-seat plans. Legal, compliance and accounting are their stated focus.
- **Store outage:** Around 2026-08-10 the stable listing was pulled and Chrome disabled installed copies for some users. Peter Coles said on Reddit that it was a copyright dispute, not malware. One secondary source says the listing came back on 2026-09-09, and it is live now. Takeaway: users on the market's default tool were recently stranded once and went looking for alternatives.

### 1.2 Capture (free)
- **One-click capture:** scroll and stitch the whole page. It detects inner scrollable elements (Gmail-style), enters iframes and framesets, and repositions fixed or sticky elements so they don't repeat. That last one is an "Adjust repeating elements" option aimed at back-to-top buttons and sticky footers.
- **Fallback:** if a page can't be scrolled, it offers to capture the visible content only.
- **Too-big pages:** pages over the browser's image-size limit are split into several images. The FAQ says that with 10 or more parts the capture "may not complete".
- **Viewing and storage:** the result opens in its own tab as an `<img>`, so right-click → Copy image works. Screenshots are stored locally (IndexedDB plus the HTML5 FS) with a Files/history page. Nothing is uploaded.
- **Free download and copy:** Save Image As… (Cmd+Shift+S), Save PDF As…, and **"Copy Image" (Cmd+C), with one entry per part when the page was split.**
- **Copy auto-resize:** an option auto-resizes copies above the Google Docs 25,000,000-pixel paste limit.
- **Formats and options:** PNG or JPG, PDF in paper sizes or "full image" (one page), auto-download, a custom download sub-directory, and a "save as" dialog.
- **Beta options:** custom filename templates and active links in PDFs.
- **What it doesn't do:** there is no visible-area, region or element capture mode, no delay timer, and no hover-state capture (hover is lost while it scrolls; the FAQ says so).

### 1.3 Editor — the "Edit" button (free to use, **paid to export**)
From the BETA editor bundle's help modal and tool registry:
- **Shapes:** Rectangle (R), Oval (O), Line (L), Arrow (A), Text (T), Blur (B). Emoji and "Stickers", which turn out to be two cursor icons.
- **Shape properties:** Fill, Outline (colour and width), Rounded corners, Font (size, bold, italic, Helvetica default). The default text style is magenta (`#BD10E0`) 32px.
- **Document edits:** Crop (C), URL/browser frame mock (U, Mac or Windows chrome templates), Padding/Border (P), and a URL + date/time stamp.
- **Layers:** a layers pane, move with the arrow keys, Cmd+D to duplicate, Delete, Undo Cmd+Z, Redo Cmd+Y, Zoom (Z / Opt+Z). Edits auto-save.
- **Export shortcuts:** Export Cmd+E, Save-as Cmd+Shift+E, **Copy to clipboard Cmd+Opt+E**.
- **The paywall:** every export item (`Export`, `Copy Image`, `PDF`) is `disabled: !user.isSubOk`. You can draw everything for free, but **you cannot copy or download the annotated result** without a trial or subscription. The site FAQ confirms this: "if you want to crop, edit, or annotate … you'll need to start a premium trial to download the edited version."
- **Missing tools:** no freehand pen, no highlighter (the "highlight" in their marketing is a filled rectangle), no underline tool, no numbered step callouts, no spotlight, no pixelate (only blur).

### 1.4 Permissions (from the manifest)
- **Required:** `activeTab`, `scripting`, `storage`, `unlimitedStorage`. With these the install shows no warning.
- **Optional, requested on demand:** `downloads`, `tabs`, `webNavigation`. Optional hosts: `<all_urls>` and `file://*/*`, used for iframe scrolling. There is a separate host grant for gofullpage.com sign-in and an opt-in analytics permission.
- **Copy for later:** "no extra permissions" is a core part of their trust pitch. We should match it.

### 1.5 Known complaints and failure modes
Store reviews are overwhelmingly positive (4.9) and the recent ones are praise, so the complaints below come from the FAQ, the beta-feedback form and comparison write-ups.
- **The editor paywall.** It is the most-cited complaint across "GoFullPage alternative" articles: "annotating means saving the file and opening something else." The trial-gated "Edit" button feels bait-and-switch because the lock only shows up at export.
- **No area or region capture.** For everyday work you often only want part of the page.
- **Very tall pages** split into several images, and 10 or more parts may fail outright.
- **Pages it can't scroll:** PDFs in the viewer, sites that run custom JS scrolling (Adobe Spark is their example), and DevTools device-emulation that sits partly offscreen.
- **Image quirks:** blank end-of-page bugs (historic Chrome 76/77 issues). The image shows zoomed out, so users think it's low-res.
- **Generic problems** (these apply to every scroll-and-stitch tool): lazy-loaded images, sticky headers repeating or covering content, and slowness. Chrome throttles `captureVisibleTab` to about 2 calls per second, so a 12,000px page at a 900px viewport takes 7 seconds or more.

### 1.6 Gaps for "annotate → paste into AI"
1. **Copying annotations needs a paid plan.** Free users have to download, open another editor, then copy. This is the whole opportunity.
2. **Even premium copy is awkward:** Cmd+Opt+E inside the editor, not Cmd+C, and right-click → Copy image on the edited view isn't how they export it.
3. **The image is too tall for AI.** A raw full-page capture is often over 8000px tall, which Claude rejects outright and ChatGPT and Gemini shrink until the text is illegible (see §3.2). GoFullPage only fits copies to *Google Docs* limits, not AI limits.
4. **No markup that's easy to refer to.** There are no numbered callouts, so you can't say "explain #2". There is no highlighter or underline either.
5. **No page context.** Nothing copies the URL, title or text with the image. Their URL stamp is premium and decorative.
6. **No redaction aimed at personal data.** Blur exists, behind the paywall, and it is manual.

---

## 2. Competitors

### 2.1 Comparison table

| Tool | Type / price | Full-page | Annotation strengths | AI-paste relevance | Steal this |
|---|---|---|---|---|---|
| **Awesome Screenshot** | Extension + cloud; free tier capped (~100 shots); ~$5–6/mo | Yes | Full kit incl. blur, crop, text, shapes; also screen recording | Cloud-first, needs account/broad permissions; heavy UI | One popup: Visible / Selected area / Full page / Delay |
| **Nimbus Capture** | Extension + cloud; free + ~$5/mo Pro | Yes, plus "Select & Scroll" | Arrows, shapes, text, blur, crop | Cloud/account push; video focus | **Select & Scroll**: drag a region, then extend it by scrolling |
| **FireShot** (Lite/Pro) | Extension (+ Windows helper); Pro ~$39.95/yr or ~$60–100 lifetime | Yes, strong; multipage PDF | Pro editor (full mainly on Windows) | Copy to clipboard is free; editor is Pro | Capture→action menu (save / PDF / copy / email) chosen *before* capture |
| **Screenshot by Movavi** | Free extension (upsell to desktop) | Yes, also all open tabs | Basic edit | Clipboard, PDF/PNG/JPG/GIF | "Capture all tabs" |
| **Scribe / Tango** | Step-guide recorders, freemium SaaS | No (per-click shots) | Auto-highlights the clicked element, auto-numbered steps, auto-redact | Output is a doc, not an image | **Auto-numbered steps; DOM-aware highlight of the clicked element** |
| **Markup Hero** | Extension + web; freemium ~$4/mo | Yes | 20+ tools | Share-link-first (public by default) | Re-editable markups kept as vectors |
| **Handy Screenshot / "Capture Full Page – Screenshot Editor"** | Free/freemium extensions | Yes | Arrows, shapes, freehand, **counters**, blur, crop | Local, no account; aimed directly at GoFullPage's paywall | Proof the "free editor" wedge is real; we need better UX to win |
| **Chrome DevTools** | Built-in | Yes (Capture full size screenshot) | None | Zero install | It's the fallback when stitching fails; we can mention it in our error state |
| **CleanShot X** (macOS) | ~$29 one-time + optional cloud | Scrolling capture | Gold standard: arrow styles, **counter**, **highlighter**, blur/pixelate, **spotlight**, text, crop | Floating **Quick Access Overlay**: copy/save/drag/annotate right after capture | Post-capture overlay; drag-out thumbnail; Cmd+C copies |
| **Shottr** (macOS) | Cheap paid license, free trial | Scrolling capture | Keyboard-first tools, **step counter**, blur, OCR, pixel ruler | Very fast; OCR text copy | Single-key tool switching; built-in OCR "copy text" |
| **Snagit** (Mac/Win) | $39/yr subscription (no more perpetual) | Scrolling + panoramic | **Step tool**, Callout, **Simplify**, Smart Move, Grab Text, Magnify, Spotlight | Copies to clipboard; heavy | Step tool auto-increments; "Simplify" turns UI into clean blocks |
| **Skitch** (macOS, Evernote) | Free; little or no active development | No | The iconic fat arrow, pixelate, quick text | Drag-out file | Arrow style: one thick tapered arrow beats ten options |
| **Xnapper** (macOS) | Paid (~yearly or Setapp) | No | Auto-padding/backgrounds, **auto-redact emails/IPs/API keys/cards** | One-click copy | **Auto-redaction of sensitive text** on capture |

### 2.2 UX ideas worth copying
1. **Post-capture "next action" in one place** (CleanShot Quick Access Overlay). The capture tab opens straight into the editor with Copy as the primary button. No interstitial viewer.
2. **Single-letter tool keys** (Shottr, GoFullPage, CleanShot): A arrow, R rect, U underline, H highlight, P pen, T text, N number, X redact, C crop. V or Esc to select.
3. **Auto-increment counters** (Snagit Step, CleanShot Counter, Scribe). Each click drops ①②③. Deleting #2 renumbers the rest.
4. **One strong arrow style** (Skitch). A thick tapered arrow with a white halo stays visible on any background. Don't ship 12 arrowheads.
5. **Highlighter that multiplies, not covers.** Use a multiply blend so text stays crisp under yellow (CleanShot, Snagit).
6. **Spotlight / dim outside** (CleanShot, Snagit). Shows a model *and* a human where to look.
7. **Region-then-scroll** (Nimbus Select & Scroll). A middle ground between visible area and full page.
8. **Auto-redact sensitive text** (Xnapper, Scribe). Our extension can do this better because it has the DOM, not just pixels (§3).
9. **Destructive redaction.** Use a solid fill or heavy pixelation baked into the export. Never a reversible light blur.
10. **Annotations stay editable** (GoFullPage layers, Markup Hero). Store vector objects and flatten only on copy or export.

---

## 3. AI-workflow features

### 3.1 The core job
"I'm on a Canvas assignment page. I want the whole thing (title, due date, points, submission types, rubric) as one image. I want to box the due date, underline the submission requirements, number the three rubric rows I'm unsure about, blur my name and student ID, then paste it into ChatGPT, Claude or Gemini and ask 'what does #2 actually require?'." The friction points: tall-image legibility, copying the *annotated* image, referring to marks, privacy, and context the model can't see (the URL, text cut off by the screenshot).

### 3.2 What AI vision inputs do with a tall image (verified 2026-10)

| Target | Published limits | A 1400×12000 PNG becomes… |
|---|---|---|
| **Claude** (API and claude.ai) | Max **8000×8000 px** per image; claude.ai allows 20 images per message and 10 MB per image. Claude 4.7+ uses the high-res tier (long edge 2,576 px, 4,784 visual tokens); other models get 1,568 px / 1,568 tokens. Tokens = ⌈w/28⌉×⌈h/28⌉. | **Rejected** (height > 8000). If it were under 8000 it would still be shrunk to ~300×2576 (×0.21), so 14px text becomes ~3px. Unreadable. |
| **OpenAI / ChatGPT** | 32px patches. gpt-5.5: `high` = 2,500 patches / 2048px max, `original`/`auto` = 10,000 patches / 6000px max. gpt-5.6-* `auto` keeps the original size up to 65,535px, with a 30,000-patch hard reject. ChatGPT caps images at 20 MB each. Which detail level the ChatGPT *app* uses isn't published. | Depends on the model: 239×2048 at `high` (×0.17, illegible), 700×6000 at gpt-5.5 auto (×0.5, borderline), or full size (16,500 patches) on gpt-5.6 auto. **You can't predict it.** |
| **Gemini** (3 / 4) | A **fixed token budget per image** set by `media_resolution`: 280 / 560 / **1120 (default)** / 2240. How tall images are resized isn't documented. | The same ~1120 tokens as a thumbnail, so it is heavily downsampled. Splitting into N images buys N× the budget. |

**Implication:** a single raw full-page image is the worst possible input for AI.

The safe format for all three is **slices about 1280px wide and at most 1900px tall, as PNG**:
- **Claude high-res:** 46×68 = 3,128 tokens, no resize.
- **Claude standard:** shrunk to about ×0.7, still legible.
- **OpenAI `high`:** 40×60 = 2,400 patches, at or under the 2,500 budget, no resize.
- **Gemini:** each slice gets its own 1120-token budget.

A 1400×12000 page becomes 6 slices with a 64px overlap, well under claude.ai's 20 per message.

Clipboard constraint: Chrome's async clipboard takes **one image per write** (multiple `ClipboardItem`s aren't supported). So multi-slice copying has to be *sequential*: Cmd+C copies 1/6, a toast appears, paste, Cmd+C again copies 2/6. The alternative is "Download slices" and dragging them from Finder.

### 3.3 Brainstorm, ranked
Value and Effort are scored 1–5 (5 = high value, 5 = high effort). The list is sorted by value ÷ effort with judgment applied.

| # | Feature | V | E | Verdict |
|---|---|---|---|---|
| 1 | **Cmd+C copies the flattened, annotated PNG** (plus a toast). Right-click → Copy image works on a flattened `<img>` preview. | 5 | 1 | MVP. This is the product. |
| 2 | **Stroke and text size scale with the image size**, so marks survive AI downscaling (a 3px line on a 2800px-wide 2× capture disappears). | 4 | 1 | MVP default. |
| 3 | **Copy section:** drag a box, Cmd+C copies just that region *with* annotations. | 5 | 1 | v0.2 #1. Dodges every size limit. |
| 4 | **Numbered callouts** ①②③ that auto-increment and renumber on delete. | 5 | 1 | v0.2. Makes "explain #2" possible. |
| 5 | **Size guard:** a badge showing "12,000px tall: too tall for Claude, shrunk by ChatGPT/Gemini" with a one-click fix. | 4 | 1 | MVP (tiny). Stops the #1 silent failure. |
| 6 | **Copy for AI:** auto-scale to ≤1280 wide, slice at ≤1900 tall with 64px overlap and a "part 2/6" label, sequential Cmd+C, "Download slices". | 5 | 2 | v0.2. Headline differentiator. |
| 7 | **Redact box** (solid or pixelate, destructive on export). | 5 | 1 | v0.2. Student IDs, names, emails. |
| 8 | **Context strip:** an optional header burned into the image (page title, URL, capture date). The model can read it. | 3 | 1 | v0.2. |
| 9 | **Copy context as Markdown:** `[Title](url)` plus captured-at plus the selected text or main text, on a separate button or Shift+Cmd+C. | 4 | 2 | v0.2. |
| 10 | **Region and visible-area capture modes**, plus element pick (hover-highlight a DOM node and capture its rect). | 4 | 2–3 | v0.2 region and visible; later element pick. |
| 11 | **Spotlight** (dim everything outside the selected boxes). | 3 | 1 | v0.2/v0.3. |
| 12 | **Auto-copy raw capture on finish** (setting), so you can paste immediately if you don't annotate. Annotated Cmd+C overwrites it later. Note: clipboard writes need a focused document, so test it. | 3 | 1 | v0.2, default off. |
| 13 | **DOM-assisted auto-redact:** at capture time, scan text nodes for emails, phone numbers, ID-like patterns (e.g. `\b[A-Z]?\d{7,9}\b`) and the signed-in user's name, record their rects, and pre-place redaction boxes the user can accept or reject. Pixels-only competitors (Xnapper) have to OCR. | 5 | 3 | Later (v0.3). Big moat. |
| 14 | **Annotation-aware context:** during capture we store a text-line map (Range rects to page coordinates), so on copy we emit Markdown like "① box: 'Due Oct 30 11:59pm' / ② underline: 'Submit a PDF…'". The model gets exact text without OCR. | 5 | 3 | Later (v0.3). The "AI-native" feature nobody has. |
| 15 | **Snap-to-text highlight and underline**, using the same text-line map, so a drag snaps to the text line like a real highlighter. | 3 | 3 | Later. |
| 16 | **Image + text in one clipboard write** (`image/png` and `text/plain` in one ClipboardItem). Paste behaviour in ChatGPT, Claude and Gemini is unknown. | 3 | 1 | Spike first. Ship only if all three take both. |
| 17 | **Local-only:** no account, no network calls, no analytics, required permissions limited to `activeTab` and `scripting`. | 4 | 0 | Principle from day 1 (it matches GoFullPage and beats the cloud tools). |
| 18 | "Send to ChatGPT/Claude" buttons that open a tab and inject a paste. | 2 | 4 | **No.** Needs host permissions, breaks often, and paste already works everywhere. |
| 19 | PDF/JPG export, emoji, stickers, browser-frame mockups, video, share links. | 1–2 | 2–3 | No, or much later. Off-mission. |

---

## 4. Roadmap

### v0.1 — MVP ("GoFullPage, but the editor is free and Cmd+C works")
- **Reliable full-page capture:** scroll and stitch at device pixel ratio. Hide fixed and sticky elements after the first frame, pre-scroll to trigger lazy loads, detect the main inner scroller, restore scroll position. *Rationale:* reliability is what users love GoFullPage for, and a broken capture makes the editor worthless.
- **Visible-area fallback** when the page won't scroll, plus a hint pointing to DevTools "Capture full size screenshot". *Rationale:* fail gracefully instead of producing a blank image.
- **Split when over the canvas limits** (~32,767px per side / ~268M px area), shown as parts. *Rationale:* GoFullPage proves this edge case is real.
- **Opens straight into the editor tab.** The flattened preview is a real `<img>`, so right-click → Copy image still works. *Rationale:* keeps the gesture the user already loves.
- **Tools:** Arrow (A), Rectangle (R), Underline (U, a horizontal line snapped with Shift), Highlighter (H, multiply blend), Freehand pen (P), Text (T). 5 colours (red default) and 3 sizes. *Rationale:* exactly the marks you need to point a model at something. Nothing else.
- **Vector objects:** select, move and delete; flatten on export. *Rationale:* makes undo and fixes cheap, and keeps marks re-editable.
- **Undo/redo:** Cmd+Z / Cmd+Shift+Z. *Rationale:* table stakes.
- **Cmd+C copies the annotated PNG**, with a toast and a copy button. *Rationale:* the core job, and GoFullPage paywalls it.
- **Download PNG** via anchor download, so no `downloads` permission. *Rationale:* the escape hatch, with zero permissions.
- **Scaled default stroke and text size**, plus a **too-tall size badge**. *Rationale:* near-zero effort, and it stops marks or text vanishing after the AI downsizes.
- **Permissions:** `activeTab`, `scripting`, `storage` only. No account, no network. *Rationale:* a trust pitch equal to GoFullPage's.

### v0.2 — "Built for pasting into AI"
- **Copy section** (box-select then Cmd+C). *Rationale:* the most common real need, and it sidesteps size limits.
- **Copy for AI** (≤1280×1900 slices, overlap, part labels, sequential Cmd+C, download slices). *Rationale:* full-page plus AI is otherwise broken (§3.2).
- **Numbered callouts.** *Rationale:* lets the prompt refer to "#2".
- **Redact box** (destructive solid or pixelate). *Rationale:* student IDs and names on LMS pages.
- **Crop.** *Rationale:* trim before copying, and it reuses the copy-section code.
- **Region and visible-area capture modes**, with Alt+Shift+… shortcuts. *Rationale:* most captures aren't full page.
- **Context strip** (URL, title, date) toggle, plus **Copy context as Markdown**. *Rationale:* gives the model provenance it can't see.
- **Spotlight.** *Rationale:* cheap and very legible to both humans and models.
- **Setting: auto-copy raw capture on finish.** *Rationale:* zero-click when no annotation is needed.
- **Spike:** combined image+text clipboard, and paste/drag behaviour in ChatGPT, Claude and Gemini. *Rationale:* decides whether #16 and drag-out ship.

### Later (v0.3+)
- **DOM-assisted auto-redact suggestions.** *Rationale:* a moat that pixel-only tools can't match cheaply.
- **Annotation-aware Markdown** (text under each mark). *Rationale:* exact text for the model, with no OCR errors.
- **Snap-to-text highlight and underline.** *Rationale:* polish that the captured text map makes nearly free.
- **Element-pick capture.** *Rationale:* capture just the rubric table or just the instructions panel.
- **Capture history** (IndexedDB) with re-edit. *Rationale:* reuse and re-ask, already expected from GoFullPage.
- **JPG/WebP export, Edge/Firefox ports.** *Rationale:* reach, once the core is loved.
- **Explicitly not planned:** cloud or share links, accounts, video, emoji or stickers, "send to AI" injectors. *Rationale:* each adds permissions or scope without serving annotate → paste.

---

## Sources
- GoFullPage listings: https://chromewebstore.google.com/detail/gofullpage-full-page-scre/fdpohaocaechififmbbbbbknoalclacl and https://chromewebstore.google.com/detail/gofullpage-beta-full-page/kehafhfdnkhdgbnpeofmhmbibmpnjaof
- gofullpage.com (premium, FAQ and enterprise copy extracted from the site bundle `index.ad50c7a5.js`). The CRX packages for both IDs came from clients2.google.com (manifest, en messages, editor bundle).
- Store outage: https://www.androidauthority.com/chrome-gofullpage-extension-web-store-3698292/ and https://www.capture-full-page.com/blog/gofullpage-alternative
- Roundups: https://attentioninsight.com/best-full-page-screenshot-extensions-chrome/ and https://tooltivity.com/alternatives/gofullpage
- Claude vision limits: https://platform.claude.com/docs/en/build-with-claude/vision and https://support.claude.com/en/articles/8241126-uploading-files-to-claude
- OpenAI vision: https://developers.openai.com/api/docs/guides/images-vision and https://help.openai.com/en/articles/8400551
- Gemini: https://ai.google.dev/gemini-api/docs/media-resolution and https://ai.google.dev/gemini-api/docs/tokens
- Competitor pricing (approximate): Snagit https://www.capterra.com/p/209649/Snagit/pricing/ · CleanShot https://toolradar.com/tools/cleanshot-x/pricing · FireShot https://www.techjockey.com/detail/fireshot · Xnapper https://setapp.com/apps/Xnapper · Movavi https://chrome.google.com/webstore/detail/movavi-screenshot-chrome/ajndhiajffnfkngbocimjhkkcngeheme
