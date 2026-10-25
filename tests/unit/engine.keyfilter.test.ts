/**
 * The embedding key filter (`setEditorKeyFilter`): the website demo uses it so the editor only
 * takes keys while it's active. Without a filter (the extension), every key is the editor's.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { editorOwnsKey, handleEditorKey, setEditorKeyFilter } from '@/editor/engine/shortcuts';
import { useEditorStore } from '@/editor/engine/store';

function key(
  k: string,
  extra: Partial<KeyboardEvent> = {},
): KeyboardEvent & { prevented: boolean } {
  const e = {
    key: k,
    keyCode: 0,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  };
  return e as unknown as KeyboardEvent & { prevented: boolean };
}

beforeAll(() => {
  // Node has no DOM; the shortcut code only needs `instanceof HTMLElement` to be valid.
  vi.stubGlobal('HTMLElement', class {});
});

afterEach(() => {
  setEditorKeyFilter(null);
  useEditorStore.setState({ tool: 'arrow' });
});

describe('editor key filter', () => {
  it('owns every key when no filter is set (the extension)', () => {
    expect(editorOwnsKey(key('r'))).toBe(true);
    const e = key('r');
    expect(handleEditorKey(e)).toBe(true);
    expect(e.prevented).toBe(true);
    expect(useEditorStore.getState().tool).toBe('rect');
  });

  it('leaves keys alone while the filter says no', () => {
    setEditorKeyFilter(() => false);
    const e = key('r');
    expect(editorOwnsKey(e)).toBe(false);
    expect(handleEditorKey(e)).toBe(false);
    expect(e.prevented).toBe(false);
    expect(useEditorStore.getState().tool).toBe('arrow');
  });

  it('passes the event to the filter and follows its answer', () => {
    const seen: string[] = [];
    setEditorKeyFilter((e) => {
      seen.push(e.key);
      return e.key !== 'h';
    });
    expect(handleEditorKey(key('h'))).toBe(false);
    expect(useEditorStore.getState().tool).toBe('arrow');
    expect(handleEditorKey(key('u'))).toBe(true);
    expect(useEditorStore.getState().tool).toBe('underline');
    expect(seen).toEqual(['h', 'u']);
  });

  it('clearing the filter restores the default', () => {
    setEditorKeyFilter(() => false);
    setEditorKeyFilter(null);
    expect(handleEditorKey(key('p'))).toBe(true);
    expect(useEditorStore.getState().tool).toBe('pen');
  });
});
