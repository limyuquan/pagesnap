/**
 * The editor viewport (owner: B): one viewport-sized <canvas> with a camera that draws the base
 * tiles and the annotations, handles pointer/wheel input for the active tool, hosts the text
 * editing <textarea> overlay and the hidden composite <img> for native right-click "Copy image".
 *
 * Layout contract with C: it fills its parent (`position: relative`, 100% × 100%). C sizes and
 * places the parent; B owns everything inside. C may theme the backdrop around the page with the
 * CSS custom property `--ps-canvas-bg` on (or above) this element.
 *
 * React renders this once; everything after mount is imperative (see `controller.ts`).
 */
import { useEffect, useRef } from 'react';
import { CanvasController } from './controller';

export interface EditorCanvasProps {
  className?: string;
}

/** The live controller (tests and shortcuts reach it through here). */
let active: CanvasController | null = null;
export function activeController(): CanvasController | null {
  return active;
}

export function EditorCanvas({ className }: EditorCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const text = textRef.current;
    const img = imgRef.current;
    if (!root || !canvas || !text || !img) return;
    const controller = new CanvasController(root, canvas, text, img);
    active = controller;
    return () => {
      controller.dispose();
      if (active === controller) active = null;
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="editor-canvas"
        style={{ display: 'block', width: '100%', height: '100%', outline: 'none' }}
      />
      <img
        ref={imgRef}
        data-testid="editor-composite"
        alt="Annotated screenshot"
        draggable={false}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          opacity: 0,
          pointerEvents: 'none',
        }}
      />
      <textarea
        ref={textRef}
        data-testid="editor-text-input"
        aria-label="Annotation text"
        spellCheck={false}
        autoComplete="off"
        wrap="off"
        rows={1}
        style={{
          display: 'none',
          position: 'absolute',
          margin: 0,
          padding: 0,
          border: 0,
          outline: '1px dashed rgba(10,132,255,0.7)',
          outlineOffset: 4,
          background: 'transparent',
          resize: 'none',
          overflow: 'hidden',
          whiteSpace: 'pre',
          zIndex: 2,
        }}
      />
    </div>
  );
}
