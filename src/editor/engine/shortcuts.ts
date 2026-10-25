/**
 * Global editor keyboard shortcuts (owner: B). C calls `useEditorShortcuts()` once in `App`.
 * Map (03 §8, v0.1 subset): V/Esc select, A/R/U/H/P/T tools, 1–8 colours, [ ] size,
 * ⌘Z / ⇧⌘Z / ⌘Y undo/redo, ⌫/Del delete, ⌘A select all, ⌘C copy (default), ⇧⌘C copy full,
 * ⌘S download, ⌘0 / ⌘1 / ⌘= / ⌘- zoom. Single keys are ignored while typing or composing.
 *
 * PHASE-0 STUB.
 */
export function useEditorShortcuts(): void {
  // B: attach keydown on window; call actions synchronously (copy must not await first).
}
