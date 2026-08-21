/**
 * Late-bound hook from the HTTP route layer into the ws layer's live agent-
 * runner registry. Routes are built before attachWsServer runs, so the route
 * can't close over the registry directly; instead both sides share this tiny
 * mutable object — createApp hands it to the agent-sessions routes, and
 * attachWsServer overwrites `send` with the real relay once the registry
 * exists. Powers `POST /api/agent-sessions/:paneId/send` (the CLI's
 * "open an agent with a first message" flow).
 */
export interface AgentBridge {
  /**
   * Deliver a user message to the pane's connected agent runner. `queued`
   * distinguishes "ran immediately" from "persisted behind an in-flight turn"
   * so CLI callers can note the wait; a rejection carries a reason for the
   * client to surface/retry on. Callers poll on rejection: the runner
   * registers within a few seconds of pane spawn.
   */
  send: (
    paneId: string,
    text: string,
  ) => { ok: true; queued: boolean } | { ok: false; reason: string };
}

export function createAgentBridge(): AgentBridge {
  return {
    send: () => ({ ok: false, reason: 'server starting — try again' }),
  };
}
