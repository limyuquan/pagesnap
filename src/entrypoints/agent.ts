import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

/**
 * Page agent (owner: A). Injected on demand by the SW via
 * `scripting.executeScript({ files: [AGENT_SCRIPT_PATH] })`, ISOLATED world, main frame.
 * Must stay framework-free and inert: it must never render anything into the page.
 *
 * PHASE-0 STUB. See `shared/protocol.ts` for the port protocol.
 */
export default defineUnlistedScript(() => {
  // A: guard with AGENT_GUARD, connect AGENT_PORT_NAME, handle ToAgent requests.
});
