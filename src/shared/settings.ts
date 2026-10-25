/**
 * User settings, stored as one object in `chrome.storage.local` under `SETTINGS_KEY`.
 * Read by the SW (capture options) and the editor; edited on the options page (C).
 *
 * Adding a setting: add it to `Settings` and `DEFAULT_SETTINGS`. Stored objects are deep-merged
 * over the defaults on read, so old stored data keeps working. Renaming/removing needs a note in
 * docs/CONTRACTS.md.
 */
import { browser } from 'wxt/browser';
import { type Color, DEFAULT_COLOR } from './annotations';
import { AI_MAX_LONG_EDGE_CSS } from './limits';
import type { CaptureOptions } from './protocol';

export const SETTINGS_KEY = 'settings';

/** See `Settings['editor'].copyScope`. */
export type CopyScope = 'fill' | 'tight';

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
    /**
     * Starting ink colour (a `PALETTE` hex) for every tool except the highlighter, which keeps
     * its own yellow. Set on the options page; the editor seeds its tool styles from it.
     */
    defaultColor: Color;
    /**
     * What `Cmd+C` copies on a page taller than `copy.fullMaxCssHeight` when there are marks.
     * `fill`: as much of the page as an AI chat can read (the full 2576 CSS px budget), marks
     * included, from the top of the page when the marks fit there. `tight`: just the area around
     * the marks, with some padding. `Shift+Cmd+C` always copies the whole page.
     */
    copyScope: CopyScope;
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
    defaultColor: DEFAULT_COLOR,
    copyScope: 'fill',
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
  const merged: Settings = {
    capture: { ...base.capture, ...s.capture },
    copy: { ...base.copy, ...s.copy },
    editor: { ...base.editor, ...s.editor },
    storage: { ...base.storage, ...s.storage },
  };
  // Stored data is untrusted (older versions, hand edits): keep enums and counts in range, so a
  // bad value can't, say, turn retention into "delete everything".
  const d = DEFAULT_SETTINGS;
  if (merged.copy.resolution !== 'css' && merged.copy.resolution !== 'native')
    merged.copy.resolution = d.copy.resolution;
  if (merged.editor.copyScope !== 'fill' && merged.editor.copyScope !== 'tight')
    merged.editor.copyScope = d.editor.copyScope;
  if (typeof merged.editor.shadow !== 'boolean') merged.editor.shadow = d.editor.shadow;
  const count = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
  merged.storage.keepSessions = count(merged.storage.keepSessions, d.storage.keepSessions);
  merged.storage.maxAgeDays = count(merged.storage.maxAgeDays, d.storage.maxAgeDays);
  return merged;
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
