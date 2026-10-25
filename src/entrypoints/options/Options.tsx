/**
 * Options page (owner: C). One column of settings that change what happens on every capture, in the
 * editor's design language: hairline rows, no cards. Changes save immediately.
 */
import { useCallback, useEffect, useState } from 'react';
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
import { deleteAll, formatBytes, readUsage, type Usage } from './storage';

/** The editor's keys, grouped: tools and marks, then moving around, then output. */
const EDITOR_KEYS: [string, string][] = [
  ['Arrow, Rectangle, Underline', 'A  R  U'],
  ['Highlighter, Pen, Text', 'H  P  T'],
  ['Select', 'V'],
  ['Colour', '1 to 8'],
  ['Thinner, thicker', '[  ]'],
  ['Delete a selected mark', combo('backspace')],
  ['Nudge a selected mark', '←  ↑  →  ↓'],
  ['Nudge by 10 px', '⇧ + arrows'],
  ['Scroll', '↑  ↓'],
  ['Top, bottom', 'Home  End'],
  ['Next screen, previous', 'Space  ⇧Space'],
  ['Page down, page up', 'PgDn  PgUp'],
  ['Fit width, actual size', `${combo('mod+0')}  ${combo('mod+1')}`],
  ['Undo, redo', `${combo('mod+z')}  ${combo('mod+shift+z')}`],
  ['Copy image', combo('mod+c')],
  ['Copy full page', combo('mod+shift+c')],
  ['Download PNG', combo('mod+s')],
  ['Deselect, then Select tool', 'Esc'],
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
  const fullKey = combo('mod+shift+c');

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
            <fieldset className="po-row po-row-top">
              <legend className="po-label">
                {combo('mod+c')} on tall pages
                <span className="po-desc">
                  AI chats read about 2,576 px of a page. {fullKey} always copies all of it.
                </span>
              </legend>
              <div className="po-choices">
                {(
                  [
                    [
                      'fill',
                      'As much as an AI can read',
                      'Your marks with the page around them, from the top when they fit.',
                    ],
                    [
                      'tight',
                      'Just around your marks',
                      'A smaller image: the marks and a little space above and below.',
                    ],
                  ] as const
                ).map(([value, label, desc]) => (
                  <label key={value} className="po-choice">
                    <input
                      type="radio"
                      name="copy-scope"
                      value={value}
                      checked={settings.editor.copyScope === value}
                      onChange={() => save({ editor: { copyScope: value } })}
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
                      data-tone={
                        c.toUpperCase() === '#FFFFFF'
                          ? 'white'
                          : c.toUpperCase() === '#111111'
                            ? 'black'
                            : undefined
                      }
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

          <StorageSection />

          <footer className="po-foot">
            Captures stay on this device. Nothing is uploaded, and Page Snap needs no account.
          </footer>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- storage

/**
 * "Delete all captures", with the size they take (the only number that matters for the
 * decision). The confirm step happens in place: the row asks, with Cancel next to the
 * destructive button, instead of a browser dialog.
 */
function StorageSection() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [step, setStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(() => {
    readUsage().then(setUsage, () => setUsage({ sessions: 0, bytes: null }));
  }, []);
  useEffect(refresh, [refresh]);

  const run = async () => {
    setStep('deleting');
    try {
      const n = await deleteAll();
      setDone(n === 1 ? 'Deleted 1 capture.' : `Deleted ${n} captures.`);
    } catch {
      setDone('Couldn’t delete them. Try again in a moment.');
    }
    setStep('idle');
    refresh();
  };

  const n = usage?.sessions ?? 0;
  const size = usage?.bytes != null && n > 0 ? formatBytes(usage.bytes) : null;
  const what = n === 1 ? '1 capture' : `${n} captures`;
  const desc =
    done ??
    (usage == null
      ? '\u00a0'
      : n === 0
        ? 'No captures are stored.'
        : `${what}${size ? `, ${size}` : ''} on this device. Older ones are cleared automatically.`);

  return (
    <section className="po-section" aria-labelledby="po-storage">
      <h2 id="po-storage">Storage</h2>
      <div className="po-row" data-testid="storage-row" data-step={step}>
        {step === 'confirm' || step === 'deleting' ? (
          <>
            <div className="po-label" id="po-delete-label">
              Delete {what}?
              <span className="po-desc">
                Every capture and its marks go, including ones open in a tab. This can’t be undone.
              </span>
            </div>
            <div className="po-actions">
              <button
                type="button"
                className="po-btn"
                disabled={step === 'deleting'}
                onClick={() => setStep('idle')}
              >
                Cancel
              </button>
              <button
                type="button"
                className="po-btn po-btn-danger"
                aria-describedby="po-delete-label"
                disabled={step === 'deleting'}
                // biome-ignore lint/a11y/noAutofocus: the confirm step replaces the button the user just pressed
                autoFocus
                onClick={() => void run()}
              >
                {step === 'deleting' ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="po-label">
              Captures
              <span className="po-desc" data-testid="storage-usage" aria-live="polite">
                {desc}
              </span>
            </div>
            <button
              type="button"
              className="po-btn"
              disabled={n === 0}
              onClick={() => {
                setDone(null);
                setStep('confirm');
              }}
            >
              Delete all captures…
            </button>
          </>
        )}
      </div>
    </section>
  );
}
