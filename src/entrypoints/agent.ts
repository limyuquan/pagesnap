import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { type AgentHandle, createAgent } from '@/capture/agent/main';
import { AGENT_GUARD } from '@/shared/protocol';

/**
 * Page agent (owner: A). Injected on demand by the SW via
 * `scripting.executeScript({ files: [AGENT_SCRIPT_PATH] })`, ISOLATED world, main frame.
 * Must stay framework-free and inert: it must never render anything into the page.
 * See `shared/protocol.ts` for the port protocol and `src/capture/agent/` for the internals.
 */
export default defineUnlistedScript(() => {
  // The isolated world survives between injections into the same document: reuse the agent.
  const w = window as unknown as Record<string, AgentHandle | undefined>;
  const agent = w[AGENT_GUARD] ?? createAgent();
  w[AGENT_GUARD] = agent;
  agent.start();
});
