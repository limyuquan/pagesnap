/**
 * The editor viewport (owner: B): one viewport-sized <canvas> with a camera that draws the base
 * tiles and the annotations, handles pointer/wheel input for the active tool, hosts the text
 * editing <textarea> overlay and the hidden composite <img> for native right-click "Copy image".
 *
 * Layout contract with C: it fills its parent (`position: relative`, 100% × 100%). C sizes and
 * places the parent; B owns everything inside.
 *
 * PHASE-0 STUB.
 */
export interface EditorCanvasProps {
  className?: string;
}

export function EditorCanvas({ className }: EditorCanvasProps) {
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        data-testid="editor-canvas"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}
