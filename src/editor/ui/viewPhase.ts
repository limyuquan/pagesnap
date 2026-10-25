/**
 * What the stage should show, from the engine's `load` state plus the session record the UI reads
 * itself (see useSessionMeta). The engine's state wins; the record fills the gaps (title during a
 * capture, capture errors before the engine has said anything, unknown ids).
 */
import type { LoadState } from '@/editor/engine';
import type { CaptureErrorCode } from '@/shared/types';
import type { SessionMeta } from './useSessionMeta';

export type ViewPhase =
  | { kind: 'loading' }
  | { kind: 'waiting'; progress: { done: number; total: number } }
  | { kind: 'ready' }
  | {
      kind: 'error';
      code: 'NO_SESSION' | 'CAPTURE_FAILED' | 'LOAD_FAILED';
      message: string;
      captureCode: CaptureErrorCode | null;
    };

export function viewPhase(
  hasId: boolean,
  load: LoadState,
  meta: SessionMeta | null | undefined,
): ViewPhase {
  const captureCode = meta?.error?.code ?? null;
  if (load.phase === 'error') {
    return { kind: 'error', code: load.code, message: load.message, captureCode };
  }
  if (load.phase === 'ready') return { kind: 'ready' };
  if (!hasId || meta === null) {
    return { kind: 'error', code: 'NO_SESSION', message: '', captureCode: null };
  }
  if (meta?.status === 'error') {
    return {
      kind: 'error',
      code: 'CAPTURE_FAILED',
      message: meta.error?.message ?? '',
      captureCode,
    };
  }
  if (load.phase === 'waiting') return { kind: 'waiting', progress: load.progress };
  if (meta?.status === 'capturing') return { kind: 'waiting', progress: meta.progress };
  return { kind: 'loading' };
}
