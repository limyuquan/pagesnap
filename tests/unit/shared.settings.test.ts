import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, getSettings, mergeSettings, updateSettings } from '@/shared/settings';

describe('settings', () => {
  it('fills missing values from the defaults', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ copy: { resolution: 'native' } }).copy).toEqual({
      ...DEFAULT_SETTINGS.copy,
      resolution: 'native',
    });
  });

  it('starts with the red ink colour and keeps a chosen one', async () => {
    expect(DEFAULT_SETTINGS.editor.defaultColor).toBe('#FF3B30');
    await updateSettings({ editor: { defaultColor: '#0A84FF' } });
    const s = await getSettings();
    expect(s.editor).toEqual({ shadow: true, defaultColor: '#0A84FF' });
  });

  it('persists patches', async () => {
    await updateSettings({ capture: { settleMs: 300 } });
    const s = await getSettings();
    expect(s.capture.settleMs).toBe(300);
    expect(s.capture.maxCssHeight).toBe(DEFAULT_SETTINGS.capture.maxCssHeight);
  });
});
