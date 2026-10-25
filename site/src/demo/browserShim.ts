/**
 * Stand-in for `wxt/browser` on the website (aliased in site/vite.config.ts). The editor reads
 * settings from `storage.local` and session status from `storage.session`; a web page has neither,
 * so this keeps both in memory with the same change events. Nothing leaves the page.
 */
type Area = 'local' | 'session';
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type Listener = (changes: Changes, area: string) => void;

const listeners = new Set<Listener>();

function area(name: Area) {
  const data = new Map<string, unknown>();
  const emit = (changes: Changes) => {
    if (Object.keys(changes).length === 0) return;
    for (const l of [...listeners]) l(changes, name);
  };
  return {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const list = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: structuredClone(v) };
        data.set(k, structuredClone(v));
      }
      emit(changes);
    },
    async remove(keys: string | string[]): Promise<void> {
      const changes: Changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      emit(changes);
    },
    async clear(): Promise<void> {
      await this.remove([...data.keys()]);
    },
  };
}

export const browser = {
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: {
      addListener: (l: Listener) => void listeners.add(l),
      removeListener: (l: Listener) => void listeners.delete(l),
      hasListener: (l: Listener) => listeners.has(l),
    },
  },
  runtime: {
    id: undefined,
    getURL: (path: string) => path,
    sendMessage: async () => undefined,
  },
  commands: {
    getAll: async () => [{ name: '_execute_action', shortcut: 'Alt+Shift+P' }],
  },
};
