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
   * Deliver a user message to the pane's connected agent runner. Fails (with
   * a reason for the client to surface/retry on) rather than queueing —
   * callers poll: the runner registers within a few seconds of pane spawn.
   */
  send: (paneId: string, text: string) => { ok: true } | { ok: false; reason: string };
}

export function createAgentBridge(): AgentBridge {
  return {
    send: () => ({ ok: false, reason: 'server starting — try again' }),
  };
}
