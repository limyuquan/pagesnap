/**
 * Export rendering (owner: B): base pixels from `compositeRegion` plus the annotations from
 * `drawDoc`, encoded as PNG. Runs in the export worker, and on the main thread as a fallback (and
 * in Vitest browser mode).
 *
 * Worker-safe: no DOM, no `browser`. Needs `OffscreenCanvas`, `createImageBitmap` and
 * `CompressionStream`.
 *
 * Two paths (03 §3.2):
 * - **single canvas**: the whole output on one `OffscreenCanvas`, encoded by Chrome's
 *   `convertToBlob`. Used whenever it fits `CANVAS_MAX_SIDE` and the memory guard
 *   `EXPORT_SINGLE_MAX_AREA`.
 * - **streamed**: horizontal strips of output rows, each composited and annotated on a small
 *   canvas, read back and fed to our own PNG encoder (`encodePngStream`). Memory stays bounded and
 *   the height is unlimited. Only expected for native Download of huge pages.
 */
import type { AnnotationDoc } from '@/shared/annotations';
import { compositeRegion, type SliceLoader } from '@/shared/composite';
import { CANVAS_MAX_SIDE, TILE_MAX_AREA } from '@/shared/limits';
import type { CaptureSession, Rect, SessionId, Size } from '@/shared/types';
import { drawDoc } from './draw';
import { outputSize } from './scope';

export interface ExportJob {
  sessionId: SessionId;
  doc: AnnotationDoc;
  /** Source region, whole image px. */
  region: Rect;
  /** Output px per image px. */
  scale: number;
  /**
   * Edge snapping (design §5.4): the most SOURCE image px each edge of `region` may move inward to
   * land in whitespace instead of cutting through text (0 = keep that edge). Single-canvas path
   * only; the streamed path ignores it.
   */
  snap?: ExportSnap;
}

export interface ExportSnap {
  top: number;
  bottom: number;
}

export interface ExportResult {
  blob: Blob;
  /** Output pixel size (after snapping). */
  size: Size;
  /** Source region actually rendered, whole image px. Equals `job.region` unless an edge snapped. */
  region: Rect;
  /** Wall time of the render + encode. */
  ms: number;
  /** True when the streaming encoder was used. */
  streamed: boolean;
}

export interface ExportDeps {
  session: CaptureSession;
  loadSlice: SliceLoader;
  signal?: AbortSignal;
}

export interface RenderExportOptions {
  /** Largest output (px) rendered on a single canvas. Default `EXPORT_SINGLE_MAX_AREA`. */
  singleMaxArea?: number;
  /** Output rows per strip on the streamed path. Default: as many as fit `STRIP_MAX_AREA`, ≤ 2048. */
  stripRows?: number;
  /** PNG row filter on the streamed path. Default `'up'`. */
  filter?: PngFilter;
  /** Canvas factory for every canvas of both paths (tests). Default `new OffscreenCanvas(w, h)`. */
  createCanvas?: (w: number, h: number) => OffscreenCanvas;
}

/** Memory guard for one export canvas: 128 MP is 512 MB of RGBA. */
export const EXPORT_SINGLE_MAX_AREA = TILE_MAX_AREA * 2;
/** Streamed path: at most this many px per strip canvas (and per temp canvas when scaling). */
export const STRIP_MAX_AREA = 32 * 2 ** 20;
export const STRIP_MAX_ROWS = 2_048;

/** `Error.name` when even a strip canvas can't be allocated. */
export const EXPORT_MEMORY_ERROR = 'ExportMemoryError';

/** Edge snapping keeps at most this many output px of whitespace next to the content. */
const SNAP_KEEP = 8;
/** A row is blank when every sampled channel is within this range (max - min). */
const SNAP_TOLERANCE = 6;

const newCanvas = (w: number, h: number) => new OffscreenCanvas(w, h);

export async function renderExport(
  job: ExportJob,
  deps: ExportDeps,
  opts: RenderExportOptions = {},
): Promise<ExportResult> {
  const t0 = performance.now();
  deps.signal?.throwIfAborted();
  const size = outputSize(job.region, job.scale);
  const singleMax = opts.singleMaxArea ?? EXPORT_SINGLE_MAX_AREA;
  const create = opts.createCanvas ?? newCanvas;
  if (size.w <= CANVAS_MAX_SIDE && size.h <= CANVAS_MAX_SIDE && size.w * size.h <= singleMax) {
    const single = await renderSingle(job, deps, size, create);
    if (single) return { ...single, ms: performance.now() - t0, streamed: false };
    // Allocation refused (no context, a dead canvas, or an allocation error while encoding):
    // fall through to the bounded-memory path.
  }
  const blob = await renderStreamed(job, deps, size, opts, create);
  return { blob, size, region: { ...job.region }, ms: performance.now() - t0, streamed: true };
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/** Errors Chrome raises for a canvas it couldn't allocate (or encode for lack of memory). */
function isAllocationError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === 'AbortError') return false;
  if (name === 'IndexSizeError' || name === 'RangeError' || name === 'EncodingError') return true;
  return typeof message === 'string' && /alloc|memory/i.test(message);
}

function memoryError(): Error {
  const err = new Error('Not enough memory to export this image');
  err.name = EXPORT_MEMORY_ERROR;
  return err;
}

/**
 * Chrome hands out a working-looking 2D context for a canvas it failed to allocate: drawing is a
 * no-op, `getImageData` reads black and `convertToBlob` throws. Write one known pixel and read it
 * back; the composite paints over it afterwards (it's cleared here anyway).
 */
function probeCanvas(ctx: OffscreenCanvasRenderingContext2D): boolean {
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#010203';
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    ctx.clearRect(0, 0, 1, 1);
    return (
      Math.abs((d[0] ?? -9) - 1) <= 1 &&
      Math.abs((d[1] ?? -9) - 2) <= 1 &&
      Math.abs((d[2] ?? -9) - 3) <= 1
    );
  } catch (err) {
    if (isAllocationError(err)) return false;
    throw err;
  } finally {
    ctx.restore();
  }
}

function release(canvas: OffscreenCanvas | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

type SingleResult = Pick<ExportResult, 'blob' | 'size' | 'region'>;

/** Single-canvas render. `null` when the canvas couldn't be allocated (caller streams instead). */
async function renderSingle(
  job: ExportJob,
  deps: ExportDeps,
  size: Size,
  create: (w: number, h: number) => OffscreenCanvas,
): Promise<SingleResult | null> {
  const { region, scale } = job;
  let canvas: OffscreenCanvas | null = null;
  let cut: OffscreenCanvas | null = null;
  try {
    canvas = create(size.w, size.h);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx || !probeCanvas(ctx)) return null;
    await compositeRegion(ctx, deps.session.layout, region, scale, deps.loadSlice);
    deps.signal?.throwIfAborted();
    const rows = job.snap ? snapRows(ctx, size, job.snap, scale) : null;
    drawDoc(ctx, job.doc, { x: region.x, y: region.y, scale });
    deps.signal?.throwIfAborted();

    if (rows) {
      // Back to whole source px, then copy the kept rows (same transform, so pixels are identical).
      const y0 = region.y + Math.round(rows.top / scale);
      const y1 = Math.max(y0 + 1, region.y + Math.round(rows.bottom / scale));
      const snapped: Rect = { x: region.x, y: y0, w: region.w, h: y1 - y0 };
      const snappedSize = outputSize(snapped, scale);
      const oy = Math.max(0, Math.min(size.h - snappedSize.h, Math.round((y0 - region.y) * scale)));
      if (snappedSize.h < size.h) {
        cut = create(snappedSize.w, snappedSize.h);
        const cctx = cut.getContext('2d', { alpha: false });
        if (cctx && probeCanvas(cctx)) {
          cctx.drawImage(canvas, 0, oy, size.w, snappedSize.h, 0, 0, size.w, snappedSize.h);
          release(canvas);
          canvas = null;
          const blob = await cut.convertToBlob({ type: 'image/png' });
          return { blob, size: snappedSize, region: snapped };
        }
        // No memory for the cut copy: export unsnapped rather than fail.
      }
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { blob, size, region: { ...region } };
  } catch (err) {
    if (isAbort(err, deps.signal)) throw err;
    if (isAllocationError(err)) return null;
    throw err;
  } finally {
    release(canvas);
    release(cut);
  }
}

/**
 * Edge snapping on the composited base (before annotations), in output rows. Returns the rows to
 * keep `[top, bottom)` or `null` when neither edge moves.
 */
function snapRows(
  ctx: OffscreenCanvasRenderingContext2D,
  size: Size,
  snap: ExportSnap,
  scale: number,
): { top: number; bottom: number } | null {
  const W = size.w;
  const H = size.h;
  let maxTop = Math.max(0, Math.floor(snap.top * scale));
  let maxBottom = Math.max(0, Math.floor(snap.bottom * scale));
  // The two windows never overlap, and at least one row is always kept.
  maxTop = Math.min(maxTop, Math.floor((H - 1) / 2));
  maxBottom = Math.min(maxBottom, H - 1 - maxTop);
  if (maxTop <= 0 && maxBottom <= 0) return null;

  const x0 = Math.floor(W * 0.1);
  const x1 = Math.max(x0 + 1, Math.ceil(W * 0.9));
  const blankRows = (y: number, rows: number): boolean[] => {
    const data = ctx.getImageData(0, y, W, rows).data;
    const out: boolean[] = [];
    for (let r = 0; r < rows; r++) out.push(isBlankRow(data, r * W * 4, x0, x1));
    return out;
  };

  let top = 0;
  let bottom = H;
  if (maxBottom > 0) {
    const y = H - maxBottom;
    const blank = blankRows(y, maxBottom);
    if (!blank[maxBottom - 1]) {
      let k = maxBottom - 2;
      while (k >= 0 && !blank[k]) k--;
      if (k >= 0) {
        const r1 = k;
        while (k >= 0 && blank[k]) k--;
        const r0 = k + 1;
        bottom = y + Math.min(r1 + 1, r0 + SNAP_KEEP);
      }
    }
  }
  if (maxTop > 0) {
    const blank = blankRows(0, maxTop);
    if (!blank[0]) {
      let k = 1;
      while (k < maxTop && !blank[k]) k++;
      if (k < maxTop) {
        const r0 = k;
        while (k < maxTop && blank[k]) k++;
        const r1 = k - 1;
        top = Math.max(r0, r1 + 1 - SNAP_KEEP);
      }
    }
  }
  return top > 0 || bottom < H ? { top, bottom } : null;
}

/** All pixels in `[x0, x1)` of the row at byte offset `at` within ±SNAP_TOLERANCE per channel. */
function isBlankRow(data: Uint8ClampedArray, at: number, x0: number, x1: number): boolean {
  let i = at + x0 * 4;
  let rMin = data[i] as number;
  let rMax = rMin;
  let gMin = data[i + 1] as number;
  let gMax = gMin;
  let bMin = data[i + 2] as number;
  let bMax = bMin;
  const end = at + x1 * 4;
  for (i += 4; i < end; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    if (r < rMin) rMin = r;
    else if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    else if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    else if (b > bMax) bMax = b;
    if (
      rMax - rMin > SNAP_TOLERANCE ||
      gMax - gMin > SNAP_TOLERANCE ||
      bMax - bMin > SNAP_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

function defaultStripRows(region: Rect, scale: number, width: number): number {
  let rows = Math.floor(STRIP_MAX_AREA / width);
  // Scaled strips are composited at 1:1 first: keep that temp canvas within budget too.
  if (scale !== 1) rows = Math.min(rows, Math.floor((STRIP_MAX_AREA * scale) / region.w) - 4);
  return Math.max(1, Math.min(STRIP_MAX_ROWS, rows));
}

async function renderStreamed(
  job: ExportJob,
  deps: ExportDeps,
  size: Size,
  opts: RenderExportOptions,
  create: (w: number, h: number) => OffscreenCanvas,
): Promise<Blob> {
  const { region, scale, doc } = job;
  const { session, loadSlice, signal } = deps;
  const W = size.w;
  if (W > CANVAS_MAX_SIDE) throw new RangeError(`Export too wide: ${W} px`);
  const stripRows = Math.max(1, Math.floor(opts.stripRows ?? defaultStripRows(region, scale, W)));

  let canvas: OffscreenCanvas | null = null;
  // Scaled strips: the base is composited 1:1 into `temp` (image px, with a 2 px margin), then
  // drawn into the strip with the same transform the single canvas uses, so strips abut. The
  // single path resamples each slice part directly, so the base can differ by about 1 px there.
  let temp: OffscreenCanvas | null = null;
  try {
    canvas = create(W, Math.min(stripRows, size.h));
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx || !probeCanvas(ctx)) throw memoryError();
    let tctx: OffscreenCanvasRenderingContext2D | null = null;
    if (scale !== 1) {
      const th = Math.min(region.h, Math.ceil(stripRows / scale) + 6);
      temp = create(region.w, th);
      tctx = temp.getContext('2d', { alpha: false });
      if (!tctx || !probeCanvas(tctx)) throw memoryError();
    }

    const getRows = async (y0: number, rows: number): Promise<Uint8ClampedArray> => {
      if (scale === 1 || !tctx || !temp) {
        // 1:1: the strip is exactly the image rows below; compositeRegion is pixel-exact.
        const sub = { x: region.x, y: region.y + y0, w: region.w, h: rows };
        await compositeRegion(ctx, session.layout, sub, 1, loadSlice);
      } else {
        const bottom = region.y + region.h;
        const iy0 = Math.max(region.y, Math.floor(region.y + y0 / scale) - 2);
        const iy1 = Math.min(bottom, Math.ceil(region.y + (y0 + rows) / scale) + 2);
        const ih = Math.min(iy1 - iy0, temp.height);
        await compositeRegion(tctx, session.layout, { ...region, y: iy0, h: ih }, 1, loadSlice);
        signal?.throwIfAborted();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = session.layout.background;
        ctx.fillRect(0, 0, W, rows);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const dy = (iy0 - region.y) * scale - y0;
        ctx.drawImage(temp, 0, 0, region.w, ih, 0, dy, W, ih * scale);
      }
      signal?.throwIfAborted();
      drawDoc(ctx, doc, { x: region.x, y: region.y + y0 / scale, scale });
      return ctx.getImageData(0, 0, W, rows).data;
    };

    return await encodePngStream(W, size.h, getRows, {
      stripRows,
      ...(opts.filter && { filter: opts.filter }),
      ...(signal && { signal }),
    });
  } catch (err) {
    // Our own RangeErrors (bad sizes) pass through; a dead strip canvas reads as out of memory.
    const e = err as { name?: unknown; message?: unknown } | null;
    const dead =
      e?.name === 'IndexSizeError' ||
      (typeof e?.message === 'string' && /alloc|memory/i.test(e.message));
    if (isAbort(err, signal) || !dead) throw err;
    throw memoryError();
  } finally {
    release(canvas);
    release(temp);
  }
}

// ------------------------------------------------------------------------------- PNG encoder

/**
 * PNG row filter. Default `'up'`: screenshots are mostly flat UI, where whole rows repeat
 * vertically (backgrounds, panels, rules) and Up turns them into zero runs that deflate to almost
 * nothing; horizontal repetition is already caught by deflate's LZ77 (distance-3 matches) without
 * any filter. Up also has no serial dependency inside a row, so it is the cheapest filter to
 * compute in JS. (Paeth compresses photos better but costs ~3x the CPU.)
 */
export type PngFilter = 'none' | 'sub' | 'up';

export interface PngStreamOptions {
  /** Rows requested per `getRows` call. Default 1024. */
  stripRows?: number;
  filter?: PngFilter;
  signal?: AbortSignal;
}

/** Bytes of compressed data per IDAT chunk (coalesced). */
const IDAT_TARGET = 1 << 20;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Stream-encode an opaque RGB PNG (8-bit, colour type 2). `getRows(y0, rows)` returns RGBA pixels
 * (`width * rows * 4` bytes; alpha is dropped) and is called top to bottom, one strip at a time,
 * so only one strip is held in memory.
 */
export async function encodePngStream(
  width: number,
  height: number,
  getRows: (y0: number, rows: number) => Promise<Uint8ClampedArray>,
  opts: PngStreamOptions = {},
): Promise<Blob> {
  if (!(width >= 1 && height >= 1 && width <= 0x7fffffff && height <= 0x7fffffff)) {
    throw new RangeError(`Bad PNG size ${width}x${height}`);
  }
  const stripRows = Math.max(1, Math.floor(opts.stripRows ?? 1024));
  const filter = opts.filter ?? 'up';
  const { signal } = opts;
  signal?.throwIfAborted();

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  // compression 0, filter method 0, interlace 0
  const parts: BlobPart[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];

  const cs = new CompressionStream('deflate'); // zlib-wrapped, as IDAT wants
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const drain = (async () => {
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (pendingBytes === 0) return;
      parts.push(pngChunk('IDAT', concatBytes(pending, pendingBytes)));
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      pending.push(value);
      pendingBytes += value.byteLength;
      if (pendingBytes >= IDAT_TARGET) flush();
    }
    flush();
  })();

  const stride = width * 4;
  let prevRow: Uint8ClampedArray | null = null;
  try {
    for (let y0 = 0; y0 < height; y0 += stripRows) {
      signal?.throwIfAborted();
      const rows = Math.min(stripRows, height - y0);
      const rgba = await getRows(y0, rows);
      signal?.throwIfAborted();
      if (rgba.length < stride * rows) {
        throw new RangeError(`getRows(${y0}, ${rows}) returned ${rgba.length} bytes`);
      }
      const out = new Uint8Array(rows * (width * 3 + 1));
      filterRows(rgba, width, rows, prevRow, filter, out);
      prevRow = rgba.slice((rows - 1) * stride, rows * stride);
      await writer.write(out);
    }
    await writer.close();
    await drain;
  } catch (err) {
    await writer.abort(err).catch(() => {});
    await drain.catch(() => {});
    throw err;
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

/** RGBA rows → filtered PNG scanlines (filter byte + RGB). `prev` is the row above row 0. */
function filterRows(
  rgba: Uint8ClampedArray,
  width: number,
  rows: number,
  prev: Uint8ClampedArray | null,
  filter: PngFilter,
  out: Uint8Array,
): void {
  const stride = width * 4;
  const line = width * 3 + 1;
  for (let r = 0; r < rows; r++) {
    let o = r * line;
    let s = r * stride;
    if (filter === 'up') {
      out[o++] = 2;
      const above = r > 0 ? rgba : prev;
      if (!above) {
        for (let x = 0; x < width; x++, s += 4, o += 3) {
          out[o] = rgba[s] as number;
          out[o + 1] = rgba[s + 1] as number;
          out[o + 2] = rgba[s + 2] as number;
        }
      } else {
        // Uint8Array stores modulo 256, which is exactly PNG's filter arithmetic.
        let p = r > 0 ? s - stride : 0;
        for (let x = 0; x < width; x++, s += 4, p += 4, o += 3) {
          out[o] = (rgba[s] as number) - (above[p] as number);
          out[o + 1] = (rgba[s + 1] as number) - (above[p + 1] as number);
          out[o + 2] = (rgba[s + 2] as number) - (above[p + 2] as number);
        }
      }
    } else if (filter === 'sub') {
      out[o++] = 1;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      for (let x = 0; x < width; x++, s += 4, o += 3) {
        const cr = rgba[s] as number;
        const cg = rgba[s + 1] as number;
        const cb = rgba[s + 2] as number;
        out[o] = cr - lr;
        out[o + 1] = cg - lg;
        out[o + 2] = cb - lb;
        lr = cr;
        lg = cg;
        lb = cb;
      }
    } else {
      out[o++] = 0;
      for (let x = 0; x < width; x++, s += 4, o += 3) {
        out[o] = rgba[s] as number;
        out[o + 1] = rgba[s + 1] as number;
        out[o + 2] = rgba[s + 2] as number;
      }
    }
  }
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** One PNG chunk: length, type, data, CRC32(type + data). */
export function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/** CRC-32 (ISO 3309 / PNG). Pass the previous result as `crc` to continue a running checksum. */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = getCrcTable();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = (t[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
