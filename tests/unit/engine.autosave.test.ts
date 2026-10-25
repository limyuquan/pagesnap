/**
 * Autosave compare-and-set and cross-tab sync (correctness #9), plus the store's "still loading"
 * statuses for ⌘C / ⌘S before the editor is ready (qa-edge E5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DocSync, isNewerDoc, putDocIfNewer } from '@/editor/engine/autosave';
import { useEditorStore } from '@/editor/engine/store';
import { type AnnotationDoc, emptyDoc } from '@/shared/annotations';
import { getDoc, openDb } from '@/shared/db';

const doc = (rev: number, updatedAt = 1000, sessionId = 's1'): AnnotationDoc => ({
  ...emptyDoc(sessionId, { w: 100, h: 100, dpr: 2 }),
  rev,
  updatedAt,
});

describe('isNewerDoc', () => {
  it('orders by rev, then time, then tab id', () => {
    expect(isNewerDoc(doc(2), doc(1))).toBe(true);
    expect(isNewerDoc(doc(1), doc(2))).toBe(false);
    expect(isNewerDoc(doc(2, 2000), doc(2, 1000))).toBe(true);
    expect(isNewerDoc(doc(2, 1000), doc(2, 1000), 'b', 'a')).toBe(true);
    expect(isNewerDoc(doc(2, 1000), doc(2, 1000), 'a', 'a')).toBe(false);
  });
});

describe('putDocIfNewer', () => {
  it('never replaces a newer stored doc with an older one', async () => {
    const db = await openDb();
    expect(await putDocIfNewer(db, doc(3))).toBe(true);
    expect(await putDocIfNewer(db, doc(2, 9999))).toBe(false);
    expect((await getDoc('s1'))?.rev).toBe(3);
    expect(await putDocIfNewer(db, doc(4))).toBe(true);
    expect((await getDoc('s1'))?.rev).toBe(4);
    // The same doc again is fine (both tabs may save it).
    expect(await putDocIfNewer(db, doc(4))).toBe(true);
  });
});

describe('DocSync', () => {
  const syncs: DocSync[] = [];
  afterEach(() => {
    for (const s of syncs.splice(0)) s.dispose();
  });
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('adopts newer docs from another tab and ignores older ones', async () => {
    let docA: AnnotationDoc = doc(1);
    let docB: AnnotationDoc = doc(1);
    const a = new DocSync(
      's1',
      () => docA,
      (d) => {
        docA = d;
      },
    );
    const b = new DocSync(
      's1',
      () => docB,
      (d) => {
        docB = d;
      },
    );
    syncs.push(a, b);
    docA = doc(2, 2000);
    a.publish(docA);
    await until(() => docB.rev === 2);
    expect(docB.rev).toBe(2);
    // An older doc never wins.
    b.publish(doc(1, 5000));
    await new Promise((r) => setTimeout(r, 30));
    expect(docA.rev).toBe(2);
  });

  it('a tab that opens late gets the current doc from an open one', async () => {
    const docA = doc(7);
    let docB: AnnotationDoc = doc(3);
    syncs.push(
      new DocSync(
        's2',
        () => ({ ...docA, sessionId: 's2' }),
        () => {},
      ),
    );
    syncs.push(
      new DocSync(
        's2',
        () => docB,
        (d) => {
          docB = d;
        },
      ),
    );
    await until(() => docB.rev === 7);
    expect(docB.rev).toBe(7);
  });
});

describe('store: before the editor is ready', () => {
  afterEach(() => useEditorStore.getState()._engine._reset());

  it('⌘C reports "loading", not a misleading failure', () => {
    useEditorStore.getState().actions.copy('default');
    expect(useEditorStore.getState().copy).toMatchObject({
      state: 'failed',
      reason: 'loading',
      message: 'Still loading',
    });
  });

  it('⌘S reports "loading" too', () => {
    useEditorStore.getState().actions.download();
    expect(useEditorStore.getState().download).toMatchObject({
      state: 'failed',
      reason: 'loading',
    });
  });
});
