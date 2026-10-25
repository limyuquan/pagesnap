/**
 * Clipboard write (03 §4.2). `writeImageToClipboard` must be called synchronously inside the
 * user's keydown/click handler: Chrome checks focus and activation at call time, and the PNG may
 * arrive later through the Promise (a resolved-later Blob is fine; awaiting first is not).
 */

export function writeImageToClipboard(png: Promise<Blob>): Promise<void> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      return Promise.reject(new Error('Clipboard images are not supported here'));
    }
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (err) {
    return Promise.reject(err);
  }
}

/** `NotAllowedError: Document is not focused` (the user switched away mid-copy). */
export function isNotFocusedError(err: unknown): boolean {
  if (!(err instanceof DOMException) && !(err instanceof Error)) return false;
  return err.name === 'NotAllowedError' || /not focused/i.test(err.message);
}
