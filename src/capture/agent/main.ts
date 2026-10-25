/**
 * Agent ↔ SW port (CONTRACTS §4.4). One `AgentSession` per connection. The page is restored on
 * `restore`, on port disconnect (SW gone), on Esc and on pagehide; restore is idempotent.
 */
import { browser } from 'wxt/browser';
import { AGENT_PORT_NAME, type AgentAbort, type FromAgent, type ToAgent } from '@/shared/protocol';
import { AgentError, AgentSession } from './session';

type Port = ReturnType<typeof browser.runtime.connect>;

export interface AgentHandle {
  /** Open a fresh port (and session) unless one is already running. */
  start(): void;
}

export function createAgent(): AgentHandle {
  let port: Port | null = null;
  let session: AgentSession | null = null;
  let cleanup: (() => void) | null = null;

  const end = () => {
    session?.restore();
    session = null;
    cleanup?.();
    cleanup = null;
    const p = port;
    port = null;
    try {
      p?.disconnect();
    } catch {
      // already gone
    }
  };

  const abort = (code: AgentAbort['code']) => {
    if (!port) return;
    try {
      port.postMessage({ t: 'abort', code } satisfies AgentAbort);
    } catch {
      // port already closed
    }
    // Restore right away so the user gets their page back; the SW drops any in-flight slice.
    end();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !session) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    abort('ABORTED_BY_USER');
  };
  const onHide = () => abort('PAGEHIDE');
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') abort('PAGEHIDE');
  };

  async function handle(msg: ToAgent): Promise<FromAgent> {
    try {
      switch (msg.t) {
        case 'prepare': {
          session?.restore();
          session = new AgentSession();
          const p = await session.prepare(msg.opts);
          return { re: msg.id, t: 'prepared', ...p };
        }
        case 'step': {
          if (!session) throw new AgentError('INTERNAL', 'no session');
          const r = await session.step();
          return { re: msg.id, ...r };
        }
        case 'restore': {
          session?.restore();
          return { re: msg.id, t: 'restored' };
        }
      }
    } catch (err) {
      const code = err instanceof AgentError ? err.code : 'INTERNAL';
      return { re: msg.id, t: 'error', code, detail: String((err as Error)?.message ?? err) };
    }
  }

  return {
    start() {
      if (port) return;
      const p = browser.runtime.connect({ name: AGENT_PORT_NAME });
      port = p;
      p.onMessage.addListener((msg: ToAgent) => {
        void handle(msg).then((reply) => {
          if (port !== p) return;
          try {
            p.postMessage(reply);
          } catch {
            end();
          }
        });
      });
      p.onDisconnect.addListener(() => {
        if (port === p) end();
      });
      addEventListener('keydown', onKey, true);
      addEventListener('pagehide', onHide);
      document.addEventListener('visibilitychange', onVisibility);
      cleanup = () => {
        removeEventListener('keydown', onKey, true);
        removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}
