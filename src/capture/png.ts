import type { Size } from '@/shared/types';

/** Width and height from a PNG's IHDR chunk (bytes 16–23), without decoding. */
export function pngSize(bytes: Uint8Array): Size {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) throw new Error('Not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

export async function pngBlobSize(blob: Blob): Promise<Size> {
  return pngSize(new Uint8Array(await blob.slice(0, 24).arrayBuffer()));
}

/** `data:image/png;base64,...` → Blob without `fetch` (works in the SW, fast for MBs). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);
  const type = meta.split(';')[0] || 'application/octet-stream';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
