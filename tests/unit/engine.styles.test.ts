import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLES, seedStyles } from '@/editor/engine/store';

describe('seedStyles', () => {
  it('sets the shared ink colour and leaves the highlighter yellow', () => {
    const s = seedStyles(DEFAULT_STYLES, '#0A84FF');
    for (const tool of ['arrow', 'rect', 'underline', 'pen', 'text'] as const) {
      expect(s[tool]).toEqual({ ...DEFAULT_STYLES[tool], color: '#0A84FF' });
    }
    expect(s.highlight).toBe(DEFAULT_STYLES.highlight);
  });

  it('ignores missing or malformed colours', () => {
    expect(seedStyles(DEFAULT_STYLES, undefined)).toBe(DEFAULT_STYLES);
    expect(seedStyles(DEFAULT_STYLES, 'blue')).toBe(DEFAULT_STYLES);
  });
});
