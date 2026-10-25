/**
 * Public surface of the editor engine (owner: B). The UI (C) imports from `@/editor/engine` only.
 */
export { EditorCanvas, type EditorCanvasProps } from './EditorCanvas';
export { useEditorShortcuts } from './shortcuts';
export * from './store';
