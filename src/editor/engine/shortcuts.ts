/**
 * Global editor keyboard shortcuts (owner: B). C calls `useEditorShortcuts()` once in `App`.
 * Map (03 §8, v0.1 subset): V/Esc select, A/R/U/H/P/T tools, 1–8 colours, [ ] size,
 * ⌘Z / ⇧⌘Z / ⌘Y undo/redo, ⌫/Del delete, ⌘A select all, ⌘C copy (default), ⇧⌘C copy full,
 * ⌘S download, ⌘0 / ⌘1 / ⌘= / ⌘- zoom. Single keys are ignored while typing or composing.
 * Keyboard scrolling (qa-edge E7): with nothing selected ↑↓←→ scroll, PageUp/PageDown page,
 * Home/End jump to the top/bottom; with a selection the arrows nudge it 1 CSS px (⇧ 10).
 * (Space-drag panning and Space/⇧Space paging live in the canvas controller.)
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

/**
 * Controls that own their own keys (Space/Enter activate, arrows move between radios or menu
 * items): the editor's navigation keys leave them alone.
 */
export function isInteractiveTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (isTypingTarget(t)) return true;
  const tag = t.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SUMMARY') return true;
  const role = t.getAttribute('role');
  return (
    !!role &&
    /^(button|link|menuitem|menuitemradio|menuitemcheckbox|radio|option|tab|checkbox|switch|slider|spinbutton|combobox|listbox|menu|menubar|radiogroup|tablist|toolbar)$/.test(
      role,
    )
  );
}

/** Arrow-key scroll step, CSS px of the screen. */
export const ARROW_SCROLL_CSS = 48;

/** Scroll the view by screen CSS px. */
export function scrollByCss(dx: number, dy: number): void {
  const s = useEditorStore.getState();
  const z = s.camera.zoom;
  s.actions.setCamera({ x: s.camera.x + dx / z, y: s.camera.y + dy / z });
}

/** PageDown (+1) / PageUp (-1): 90% of the view. */
export function pageBy(dir: 1 | -1): void {
  const s = useEditorStore.getState();
  scrollByCss(0, dir * Math.max(1, s.viewport.h * 0.9));
}

function navigationKey(e: KeyboardEvent, key: string): boolean {
  const s = useEditorStore.getState();
  if (!s.session || s.load.phase !== 'ready') return false;
  const arrows: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };
  const arrow = arrows[key];
  if (arrow) {
    if (s.selection.length > 0) {
      const step = (e.shiftKey ? 10 : 1) * s.session.dpr;
      s._engine._nudge(arrow[0] * step, arrow[1] * step);
    } else {
      const step = ARROW_SCROLL_CSS * (e.shiftKey ? 5 : 1);
      scrollByCss(arrow[0] * step, arrow[1] * step);
    }
    return true;
  }
  switch (key) {
    case 'PageDown':
      pageBy(1);
      return true;
    case 'PageUp':
      pageBy(-1);
      return true;
    case 'Home':
      s.actions.setCamera({ y: Number.NEGATIVE_INFINITY });
      return true;
    case 'End':
      s.actions.setCamera({ y: Number.POSITIVE_INFINITY });
      return true;
    default:
      return false;
  }
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

  if (!isInteractiveTarget(e.target) && navigationKey(e, key)) return prevent();

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
