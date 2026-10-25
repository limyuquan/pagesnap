/**
 * SW side of the agent port (CONTRACTS §4.4): inject `/agent.js`, wait for its port, and send
 * one request at a time.
 */
import { browser } from 'wxt/browser';
import {
  AGENT_PORT_NAME,
  AGENT_SCRIPT_PATH,
  type AgentAbort,
  type FromAgent,
  type FromAgentAny,
  type ToAgent,
} from '@/shared/protocol';

type Port = ReturnType<typeof browser.runtime.connect>;
type Request = ToAgent extends infer T ? (T extends ToAgent ? Omit<T, 'id'> : never) : never;

/** `executeScript` failed: the page can't be scripted (chrome://, Web Store, PDF, ...). */
export class InjectError extends Error {}

const waiters = new Map<number, (port: Port) => void>();

/** Register once at SW start (before any capture). */
export function installAgentListener(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    const waiter = tabId == null || port.sender?.frameId !== 0 ? undefined : waiters.get(tabId);
    if (tabId == null || !waiter) {
      port.disconnect(); // stale agent from an earlier capture: it restores itself on disconnect
      return;
    }
    waiters.delete(tabId);
    waiter(port);
  });
}

export class AgentLink {
  private nextId = 1;
  private readonly pending = new Map<number, (reply: FromAgent) => void>();
  private closed = false;
  onAbort: (code: AgentAbort['code']) => void = () => {};
  /** The page went away (navigation, reload, tab closed) without us closing the port. */
  onDisconnect: () => void = () => {};

  private constructor(private readonly port: Port) {
    port.onMessage.addListener((msg: FromAgentAny) => {
      if (msg.t === 'abort') return this.onAbort(msg.code);
      const resolve = this.pending.get(msg.re);
      this.pending.delete(msg.re);
      resolve?.(msg);
    });
    port.onDisconnect.addListener(() => {
      const wasOpen = !this.closed;
      this.closed = true;
      for (const resolve of this.pending.values()) {
        resolve({ re: -1, t: 'error', code: 'INTERNAL', detail: 'disconnected' });
      }
      this.pending.clear();
      if (wasOpen) this.onDisconnect();
    });
  }

  /** Inject the agent into the tab's main frame and wait for its port. */
  static async inject(tabId: number, timeoutMs = 5000): Promise<AgentLink> {
    const portPromise = new Promise<Port>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(tabId);
        reject(new Error('The page agent did not respond'));
      }, timeoutMs);
      waiters.set(tabId, (port) => {
        clearTimeout(timer);
        resolve(port);
      });
    });
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: [AGENT_SCRIPT_PATH] });
    } catch (err) {
      waiters.delete(tabId);
      void portPromise.catch(() => {});
      throw new InjectError(String((err as Error)?.message ?? err));
    }
    return new AgentLink(await portPromise);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Send a request; resolves with the agent's reply (or an `error` reply on timeout/abort). */
  request(msg: Request, timeoutMs: number, signal?: AbortSignal): Promise<FromAgent> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const done = (reply: FromAgent) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(reply);
      };
      const onAbort = () => done({ re: id, t: 'error', code: 'INTERNAL', detail: 'aborted' });
      const timer = setTimeout(
        () => done({ re: id, t: 'error', code: 'INTERNAL', detail: `no reply to ${msg.t}` }),
        timeoutMs,
      );
      if (this.closed)
        return done({ re: id, t: 'error', code: 'INTERNAL', detail: 'disconnected' });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, done);
      try {
        this.port.postMessage({ ...msg, id } as ToAgent);
      } catch {
        done({ re: id, t: 'error', code: 'INTERNAL', detail: 'disconnected' });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.disconnect();
    } catch {
      // already gone
    }
  }
}
