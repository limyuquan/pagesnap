/**
 * A plain message box under the demo, so a visitor can paste the copied image and see what an AI
 * chat would receive. It reads the paste locally and sends nothing anywhere.
 */
import { useEffect, useState } from 'react';
import { combo } from '@/editor/ui/keys';

interface Pasted {
  url: string;
  w: number;
  h: number;
  kb: number;
}

export function PasteCheck() {
  const [pasted, setPasted] = useState<Pasted | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => () => void (pasted && URL.revokeObjectURL(pasted.url)), [pasted]);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...e.clipboardData.items]
      .find((i) => i.kind === 'file' && i.type.startsWith('image/'))
      ?.getAsFile();
    if (!file) {
      setNote('That paste had no image. Copy from the editor first.');
      return;
    }
    e.preventDefault();
    setNote(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      setPasted({ url, w: img.naturalWidth, h: img.naturalHeight, kb: file.size / 1024 });
    img.src = url;
  };

  return (
    <div className="dm-paste" data-has={pasted ? '' : undefined}>
      <label className="dm-paste-label" htmlFor="dm-paste-input">
        Paste it here to see what a chat receives
      </label>
      <div className="dm-paste-box">
        {pasted && (
          <figure className="dm-paste-att" data-testid="paste-result">
            <img src={pasted.url} alt="What you pasted" />
            <figcaption className="tnum">
              {pasted.w.toLocaleString('en-US')} × {pasted.h.toLocaleString('en-US')} PNG
              <span>
                {pasted.kb >= 1024
                  ? `${(pasted.kb / 1024).toFixed(1)} MB`
                  : `${Math.round(pasted.kb)} KB`}
              </span>
            </figcaption>
            <button
              type="button"
              className="dm-paste-x"
              aria-label="Remove the pasted image"
              onClick={() => setPasted(null)}
            >
              ×
            </button>
          </figure>
        )}
        <textarea
          id="dm-paste-input"
          className="dm-paste-input"
          rows={1}
          placeholder={`Message… (${combo('mod+v')} to paste)`}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
          }}
          data-testid="paste-input"
        />
      </div>
      <p className="dm-paste-note" aria-live="polite">
        {note ?? 'Stays on this page. Nothing is uploaded or sent.'}
      </p>
    </div>
  );
}
