/**
 * User settings, stored as one object in `chrome.storage.local` under `SETTINGS_KEY`.
 * Read by the SW (capture options) and the editor; edited on the options page (C).
 *
 * Adding a setting: add it to `Settings` and `DEFAULT_SETTINGS`. Stored objects are deep-merged
 * over the defaults on read, so old stored data keeps working. Renaming/removing needs a note in
 * docs/CONTRACTS.md.
 */
import { browser } from 'wxt/browser';
import { AI_MAX_LONG_EDGE_CSS } from './limits';
import type { CaptureOptions } from './protocol';

export const SETTINGS_KEY = 'settings';

export interface Settings {
  capture: {
    /** Stop capturing after this many CSS px (infinite-scroll guard). */
    maxCssHeight: number;
    preScroll: CaptureOptions['preScroll'];
    floating: CaptureOptions['floating'];
    target: CaptureOptions['target'];
    settleMs: number;
  };
  copy: {
    /**
     * Default `Cmd+C` copies the whole image when it is at most this many CSS px tall, otherwise
     * the smart region around the annotations. `Shift+Cmd+C` always copies the whole image.
     */
    fullMaxCssHeight: number;
    /**
     * Pixel density of copied images. `css` = 1 image px per CSS px (smaller, what AI models end up
     * seeing anyway); `native` = capture resolution. Download is always native.
     */
    resolution: 'css' | 'native';
  };
  editor: {
    /** Contrast shadow on new shapes. */
    shadow: boolean;
  };
  storage: {
    /** Keep at least this many captures. */
    keepSessions: number;
    /** Delete captures older than this (beyond `keepSessions`), days. */
    maxAgeDays: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  capture: {
    maxCssHeight: 80_000,
    preScroll: 'auto',
    floating: 'smart',
    target: 'auto',
    settleMs: 150,
  },
  copy: {
    fullMaxCssHeight: AI_MAX_LONG_EDGE_CSS,
    resolution: 'css',
  },
  editor: {
    shadow: true,
  },
  storage: {
    keepSessions: 20,
    maxAgeDays: 30,
  },
};

export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

/** Merge a stored (possibly partial or outdated) object over the defaults. */
export function mergeSettings(stored: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = (typeof stored === 'object' && stored !== null ? stored : {}) as SettingsPatch;
  return {
    capture: { ...base.capture, ...s.capture },
    copy: { ...base.copy, ...s.copy },
    editor: { ...base.editor, ...s.editor },
    storage: { ...base.storage, ...s.storage },
  };
}

export async function getSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(SETTINGS_KEY);
  return mergeSettings(got[SETTINGS_KEY]);
}

/** Shallow-merge `patch` per section and persist. Returns the new settings. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const next = mergeSettings(patch, await getSettings());
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Call `cb` whenever settings change. Returns an unsubscribe function. */
export function watchSettings(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && SETTINGS_KEY in changes) {
      cb(mergeSettings(changes[SETTINGS_KEY]?.newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Capture options for the agent, from settings. */
export function captureOptionsFrom(settings: Settings): CaptureOptions {
  return { mode: 'full', ...settings.capture };
}
