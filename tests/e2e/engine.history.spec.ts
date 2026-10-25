import { dragImage, snapshot, waitReady } from './engine.helpers';
import { expect, test } from './fixtures';

test('undo/redo: one step per gesture, Cmd+Z / Shift+Cmd+Z / Cmd+Y', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await dragImage(ed, { x: 200, y: 200 }, { x: 800, y: 500 }, { steps: 20 });
  await dragImage(ed, { x: 200, y: 700 }, { x: 800, y: 900 }, { steps: 20 });
  let s = await snapshot(ed);
  expect(s.shapes).toHaveLength(2);
  expect(s.canUndo).toBe(true);

  await ed.keyboard.press('ControlOrMeta+z');
  expect((await snapshot(ed)).shapes).toHaveLength(1);
  await ed.keyboard.press('ControlOrMeta+z');
  s = await snapshot(ed);
  expect(s.shapes).toHaveLength(0);
  expect(s.canUndo).toBe(false);
  expect(s.canRedo).toBe(true);
  await ed.keyboard.press('ControlOrMeta+Shift+z');
  expect((await snapshot(ed)).shapes).toHaveLength(1);
  await ed.keyboard.press('ControlOrMeta+y');
  s = await snapshot(ed);
  expect(s.shapes).toHaveLength(2);
  expect(s.canRedo).toBe(false);

  // A new commit after an undo clears the redo stack.
  await ed.keyboard.press('ControlOrMeta+z');
  await dragImage(ed, { x: 1200, y: 200 }, { x: 1800, y: 500 });
  s = await snapshot(ed);
  expect(s.shapes).toHaveLength(2);
  expect(s.canRedo).toBe(false);
});

test('autosave restores the annotations after a reload', async ({ pagesnap }) => {
  const id = await pagesnap.seedSession({ cssW: 1280, cssH: 3000 });
  const ed = await pagesnap.openEditor(id);
  await waitReady(ed);
  await dragImage(ed, { x: 200, y: 200 }, { x: 800, y: 500 });
  await ed.keyboard.press('r');
  await dragImage(ed, { x: 1000, y: 200 }, { x: 1400, y: 600 });
  const before = await snapshot(ed);
  // Debounced save (500 ms) lands without any explicit flush.
  await ed.waitForTimeout(900);
  await ed.reload();
  await waitReady(ed);
  const after = await snapshot(ed);
  expect(after.shapes).toEqual(before.shapes);
  expect(after.rev).toBe(before.rev);
  // History isn't persisted, but further edits keep counting revs up.
  expect(after.canUndo).toBe(false);

  // Reloading right after an edit (inside the debounce) still keeps it: flushed on pagehide.
  await ed.keyboard.press('a');
  await dragImage(ed, { x: 200, y: 1000 }, { x: 800, y: 1200 });
  await ed.reload();
  await waitReady(ed);
  expect((await snapshot(ed)).shapes).toHaveLength(3);
});
