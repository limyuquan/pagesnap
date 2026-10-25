import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@/shared/settings';

describe('settings (UI-owned fields)', () => {
  it('defaults the copy scope to fill and keeps a valid choice', () => {
    expect(DEFAULT_SETTINGS.editor.copyScope).toBe('fill');
    expect(mergeSettings({ editor: { copyScope: 'tight' } }).editor.copyScope).toBe('tight');
  });

  it('repairs out-of-range stored values', () => {
    const s = mergeSettings({
      copy: { resolution: 'huge' },
      editor: { copyScope: 'everything', shadow: 'yes' },
      storage: { keepSessions: null, maxAgeDays: -3 },
    });
    expect(s.copy.resolution).toBe('css');
    expect(s.editor.copyScope).toBe('fill');
    expect(s.editor.shadow).toBe(true);
    expect(s.storage).toEqual(DEFAULT_SETTINGS.storage);
  });
});
