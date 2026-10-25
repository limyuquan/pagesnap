/**
 * Gentle guided hints for the demo. They suggest one thing at a time and tick off whatever the
 * visitor does, in any order; nothing waits on them.
 */
import { useEffect, useState } from 'react';
import { type EditorState, useEditorStore } from '@/editor/engine';
import type { Shape } from '@/shared/annotations';
import type { TargetName } from './page';

export type StepId = 'arrow' | 'rect' | 'highlight' | 'text' | 'edit' | 'copy';

export interface Step {
  id: StepId;
  /** Short chip label. */
  label: string;
  /** Key shown on the chip (platform notation for ⌘C is filled in by the UI). */
  key: string;
  /** The suggestion, for a keyboard and for touch. */
  text: string;
  touch: string;
  target?: TargetName;
}

export const STEPS: readonly Step[] = [
  {
    id: 'arrow',
    label: 'Arrow',
    key: 'A',
    text: 'The arrow tool is armed. Drag an arrow to the Plus price.',
    touch: 'The arrow tool is armed. Drag an arrow to the Plus price.',
    target: 'plusPrice',
  },
  {
    id: 'rect',
    label: 'Box',
    key: 'R',
    text: 'Press R and drag a box around the button that slipped out of its card.',
    touch: 'Tap the box tool and drag around the button that slipped out of its card.',
    target: 'teamButton',
  },
  {
    id: 'highlight',
    label: 'Highlight',
    key: 'H',
    text: 'Press H and drag across the table’s Plus price. It says $10, the card says $8.',
    touch: 'Tap the highlighter and drag across the table’s Plus price. It says $10.',
    target: 'tablePrice',
  },
  {
    id: 'text',
    label: 'Text',
    key: 'T',
    text: 'Press T, click next to it and type a question.',
    touch: 'Tap the text tool, tap next to it and type a question.',
  },
  {
    id: 'edit',
    label: 'Move, rotate, bend',
    key: '',
    text: 'Click any mark to move it. Drag its handles to resize, rotate or bend it.',
    touch: 'Tap any mark to move it. Drag its handles to resize, rotate or bend it.',
  },
  {
    id: 'copy',
    label: 'Copy',
    key: '⌘C',
    text: 'Press ⌘C, then paste into any chat. Or into the box below.',
    touch: 'Tap Copy, then paste into any chat. Or into the box below.',
  },
];

const hasKind = (shapes: readonly Shape[], ok: (s: Shape) => boolean) => shapes.some(ok);

function sameIds(a: readonly Shape[], b: readonly Shape[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]?.id !== b[i]?.id) return false;
  return true;
}

/** Steps done so far, from the editor's own state. */
export function useDoneSteps(epoch: number): ReadonlySet<StepId> {
  const [done, setDone] = useState<ReadonlySet<StepId>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reset (new epoch) starts over
  useEffect(() => {
    setDone(new Set());
    let prevDoc: EditorState['doc'] = useEditorStore.getState().doc;
    const mark = (id: StepId) => setDone((cur) => (cur.has(id) ? cur : new Set([...cur, id])));
    return useEditorStore.subscribe((s) => {
      const doc = s.doc;
      if (doc && doc !== prevDoc) {
        const shapes = doc.shapes;
        if (hasKind(shapes, (x) => x.kind === 'arrow')) mark('arrow');
        if (hasKind(shapes, (x) => x.kind === 'rect')) mark('rect');
        if (hasKind(shapes, (x) => x.kind === 'highlight' || (x.kind === 'pen' && x.marker)))
          mark('highlight');
        if (hasKind(shapes, (x) => x.kind === 'text' && x.text.trim().length > 0)) mark('text');
        // An existing mark changed in place: moved, resized, rotated, bent or restyled.
        if (prevDoc && prevDoc.sessionId === doc.sessionId && sameIds(prevDoc.shapes, shapes)) {
          if (shapes.some((x, i) => x !== prevDoc?.shapes[i])) mark('edit');
        }
        prevDoc = doc;
      }
      if (s.copy.state === 'copied') mark('copy');
    });
  }, [epoch]);
  return done;
}
