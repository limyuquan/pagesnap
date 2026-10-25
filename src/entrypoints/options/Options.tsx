/**
 * Options page (owner: C). One column of settings that change what happens on every capture, in the
 * editor's design language: hairline rows, no cards. Changes save immediately.
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { combo, prettyCommandShortcut } from '@/editor/ui/keys';
import { COLOR_NAMES } from '@/editor/ui/palette';
import { DEFAULT_COLOR, PALETTE } from '@/shared/annotations';
import {
  getSettings,
  mergeSettings,
  type Settings,
  updateSettings,
  watchSettings,
} from '@/shared/settings';

const EDITOR_KEYS: [string, string][] = [
  ['Arrow, Rectangle, Underline', 'A  R  U'],
  ['Highlighter, Pen, Text', 'H  P  T'],
  ['Select', 'V'],
  ['Colour', '1 to 8'],
  ['Thinner, thicker', '[  ]'],
  ['Copy image', combo('mod+c')],
  ['Copy full page', combo('mod+shift+c')],
  ['Download PNG', combo('mod+s')],
  ['Undo, redo', `${combo('mod+z')}  ${combo('mod+shift+z')}`],
];

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shortcut, setShortcut] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    void getSettings().then(setSettings);
    const stop = watchSettings(setSettings);
    void browser.commands
      ?.getAll()
      .then((cmds) => setShortcut(cmds.find((c) => c.name === '_execute_action')?.shortcut ?? ''))
      .catch(() => setShortcut(''));
    return stop;
  }, []);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(0), 1800);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const save = (patch: Parameters<typeof updateSettings>[0]) => {
    // Optimistic, so controlled inputs flip at once; storage confirms a moment later.
    setSettings((prev) => (prev ? mergeSettings(patch, prev) : prev));
    void updateSettings(patch).then((next) => {
      setSettings(next);
      setSavedAt(Date.now());
    });
  };

  const color = settings?.editor.defaultColor ?? DEFAULT_COLOR;

  return (
    <main className="po-page" data-testid="options-root" aria-busy={!settings}>
      <header className="po-head">
        <div className="po-brand">
          <img src="/icon/32.png" width={20} height={20} alt="" />
          <h1>Page Snap</h1>
        </div>
        <span
          className="po-saved"
          role="status"
          aria-live="polite"
          data-on={savedAt ? '' : undefined}
        >
          {savedAt ? 'Saved' : ''}
        </span>
      </header>

      {settings && (
        <>
          <section className="po-section" aria-labelledby="po-copy">
            <h2 id="po-copy">Copying</h2>
            <fieldset className="po-row po-row-top">
              <legend className="po-label">
                Copy size
                <span className="po-desc">
                  Downloads are always full resolution. This only changes what {combo('mod+c')} puts
                  on the clipboard.
                </span>
              </legend>
              <div className="po-choices">
                {(
                  [
                    [
                      'css',
                      'Standard',
                      'One pixel per page pixel. Smaller, and all an AI chat keeps.',
                    ],
                    ['native', 'Full resolution', 'Every captured pixel, 2× on Retina screens.'],
                  ] as const
                ).map(([value, label, desc]) => (
                  <label key={value} className="po-choice">
                    <input
                      type="radio"
                      name="copy-resolution"
                      value={value}
                      checked={settings.copy.resolution === value}
                      onChange={() => save({ copy: { resolution: value } })}
                    />
                    <span>
                      <span className="po-choice-label">{label}</span>
                      <span className="po-desc">{desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </section>

          <section className="po-section" aria-labelledby="po-marks">
            <h2 id="po-marks">Marks</h2>
            <div className="po-row">
              <div className="po-label" id="po-color-label">
                Starting colour
                <span className="po-desc">The highlighter stays yellow.</span>
              </div>
              <div
                className="ps-swatches"
                role="radiogroup"
                aria-labelledby="po-color-label"
                data-testid="default-color"
              >
                {PALETTE.map((c, i) => {
                  const checked = c.toLowerCase() === color.toLowerCase();
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: ARIA radio-group pattern; native inputs can't render swatches
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={COLOR_NAMES[i]}
                      title={COLOR_NAMES[i]}
                      className="ps-swatch"
                      data-light={c.toUpperCase() === '#FFFFFF' || undefined}
                      data-color={c}
                      tabIndex={checked ? 0 : -1}
                      style={{ '--sw': c } as React.CSSProperties}
                      onClick={() => save({ editor: { defaultColor: c } })}
                      onKeyDown={(e) => {
                        const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                        if (!dir) return;
                        e.preventDefault();
                        const n = (i + dir + PALETTE.length) % PALETTE.length;
                        const next = PALETTE[n];
                        if (next) save({ editor: { defaultColor: next } });
                        const sib = e.currentTarget.parentElement?.children[n];
                        if (sib instanceof HTMLElement) sib.focus();
                      }}
                    />
                  );
                })}
              </div>
            </div>
            <label className="po-row">
              <span className="po-label">
                Contrast shadow
                <span className="po-desc">
                  A soft shadow behind new marks keeps them visible on dark or busy areas.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={settings.editor.shadow}
                className="po-switch"
                checked={settings.editor.shadow}
                onChange={(e) => save({ editor: { shadow: e.currentTarget.checked } })}
              />
            </label>
          </section>

          <section className="po-section" aria-labelledby="po-keys">
            <h2 id="po-keys">Keyboard</h2>
            <div className="po-row">
              <div className="po-label">
                Capture the page
                <span className="po-desc">
                  {shortcut === ''
                    ? 'No shortcut set. You can also click Page Snap in the toolbar.'
                    : 'Or click Page Snap in the toolbar.'}
                </span>
              </div>
              <div className="po-keyset">
                {shortcut && (
                  <kbd className="po-kbd" data-testid="capture-shortcut">
                    {prettyCommandShortcut(shortcut)}
                  </kbd>
                )}
                <button
                  type="button"
                  className="ps-link po-change"
                  onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
                >
                  {shortcut ? 'Change' : 'Set shortcut'}
                </button>
              </div>
            </div>
            <dl className="po-keys">
              {EDITOR_KEYS.map(([what, keys]) => (
                <div key={what}>
                  <dt>{what}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <footer className="po-foot">
            Captures stay on this device. Nothing is uploaded, and Page Snap needs no account.
          </footer>
        </>
      )}
    </main>
  );
}
