/** Keyboard labels for tooltips, buttons and toasts, in the platform's own notation. */

const platform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
  navigator.platform ??
  '';

export const IS_MAC = /mac|iphone|ipad/i.test(platform);

/**
 * `combo('mod+shift+c')` → `⇧⌘C` on macOS, `Ctrl+Shift+C` elsewhere. Tokens: `mod`, `shift`,
 * `alt`, then a key.
 */
export function combo(spec: string): string {
  const parts = spec.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  const keyLabel = KEY_NAMES[key] ?? key.toUpperCase();
  if (IS_MAC) {
    return `${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('mod') ? '⌘' : ''}${keyLabel}`;
  }
  const out: string[] = [];
  if (mods.has('mod')) out.push('Ctrl');
  if (mods.has('alt')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(keyLabel);
  return out.join('+');
}

const KEY_NAMES: Record<string, string> = {
  '=': '=',
  '-': '−',
  '0': '0',
  '1': '1',
  '[': '[',
  ']': ']',
  backspace: IS_MAC ? '⌫' : 'Backspace',
  escape: 'Esc',
};

/** Chrome's own notation for command shortcuts (`Alt+Shift+P`) → platform notation. */
export function prettyCommandShortcut(shortcut: string): string {
  if (!IS_MAC) return shortcut;
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return `${mods.has('ctrl') || mods.has('macctrl') ? '⌃' : ''}${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('command') ? '⌘' : ''}${key}`;
}
