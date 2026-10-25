/**
 * Numeric limits and product constants shared across the capture engine and the editor.
 * Sources: docs/research/01-capture-engine.md §3.9, 03-annotation-editor.md §3.1 and §5.
 */

/** Chromium canvas limits (measured, Chromium 156). Exceeding either fails silently. */
export const CANVAS_MAX_SIDE = 65_535;
export const CANVAS_MAX_AREA = 268_435_456;

/** Conservative limits for any single canvas we allocate (compositor tiles, export chunks). */
export const TILE_MAX_SIDE = 16_384;
export const TILE_MAX_AREA = 64 * 2 ** 20;

/** Display tiles (on-screen base image): horizontal strips about this tall, image px. */
export const DISPLAY_TILE_HEIGHT = 2_048;
/** Display tiles are at most this wide; wider images get columns. Image px. */
export const DISPLAY_TILE_MAX_SIDE = 8_192;

/**
 * Default `Cmd+C`: copy the whole annotated image when it is at most this many CSS px tall,
 * otherwise copy the smart region around the annotations (Claude's high-res tier long edge).
 */
export const AI_MAX_LONG_EDGE_CSS = 2_576;

/** Smart region padding around the annotations: max(this many CSS px, 10% of the bbox). */
export const SMART_REGION_PAD_CSS = 160;

/** captureVisibleTab is throttled by Chrome to 2 calls/s; keep a small margin. */
export const CAPTURE_MIN_GAP_MS = 530;

/** Hard cap on slices per capture. */
export const MAX_SLICES = 250;
