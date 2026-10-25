/**
 * Global editor keyboard shortcuts (owner: B). C calls `useEditorShortcuts()` once in `App`.
 * Map (03 §8, v0.1 subset): V/Esc select, A/R/U/H/P/T tools, 1–8 colours, [ ] size,
 * ⌘Z / ⇧⌘Z / ⌘Y undo/redo, ⌫/Del delete, ⌘A select all, ⌘C copy (default), ⇧⌘C copy full,
 * ⌘S download, ⌘0 / ⌘1 / ⌘= / ⌘- zoom. Single keys are ignored while typing or composing.
 * (Space-drag panning lives in the canvas controller.)
 */
import { useEffect } from 'react';
import { TOOL_SHORTCUTS, type Tool, useEditorStore } from './store';

const KEY_TO_TOOL: Readonly<Record<string, Tool>> = {
  ...Object.fromEntries(Object.entries(TOOL_SHORTCUTS).map(([tool, key]) => [key, tool as Tool])),
  // 03 §8 alias.
  m: 'highlight',
};

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset'].includes(type);
  }
  return false;
}

/** Handle one keydown. Returns true when it was an editor shortcut (and was prevented). */
export function handleEditorKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
  const s = useEditorStore.getState();
  // Typing (our text overlay or any field C renders): let the field have every key, so ⌘C/⌘Z/⌘A
  // behave natively there.
  if (isTypingTarget(e.target) || s.editingTextId) return false;

  const a = s.actions;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const prevent = () => {
    e.preventDefault();
    return true;
  };

  if (mod && !e.altKey) {
    switch (key) {
      case 'c':
        if (e.repeat) return prevent();
        a.copy(e.shiftKey ? 'full' : 'default'); // synchronous: the clipboard call happens now
        return prevent();
      case 'z':
        if (e.shiftKey) a.redo();
        else a.undo();
        return prevent();
      case 'y':
        a.redo();
        return prevent();
      case 'a':
        a.selectAll();
        return prevent();
      case 's':
        a.download();
        return prevent();
      case '0':
        a.fitWidth();
        return prevent();
      case '1':
        a.zoomActual();
        return prevent();
      case '=':
      case '+':
        a.zoomBy(1.25);
        return prevent();
      case '-':
      case '_':
        a.zoomBy(0.8);
        return prevent();
      default:
        return false;
    }
  }
  if (mod || e.altKey) return false;

  switch (key) {
    case 'Escape':
      if (s.selection.length > 0) a.clearSelection();
      else if (s.tool !== 'select') a.setTool('select');
      else return false;
      return prevent();
    case 'Backspace':
    case 'Delete':
      if (s.selection.length === 0) return false;
      a.deleteSelection();
      return prevent();
    case '[':
      a.stepSize(-1);
      return prevent();
    case ']':
      a.stepSize(1);
      return prevent();
    default:
      break;
  }
  if (e.shiftKey) return false;
  if (key.length === 1 && key >= '1' && key <= '8') {
    a.setColorIndex(Number(key) - 1);
    return prevent();
  }
  const tool = KEY_TO_TOOL[key];
  if (tool) {
    a.setTool(tool);
    return prevent();
  }
  return false;
}

export function useEditorShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleEditorKey(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
