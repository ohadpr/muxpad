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
  /**
   * Real turn state for the pane's connected runner: true mid-turn, false
   * idle, null when no runner is connected right now. This is the registry's
   * `turnActive` — NOT the pane `busy` flag, which also trips on raw pty
   * output activity (a worker tailing a dev server reads busy forever).
   * `muxpad agent wait` keys on this via GET /api/agent-sessions/by-pane.
   */
  turnActive: (paneId: string) => boolean | null;
}

export function createAgentBridge(): AgentBridge {
  return {
    send: () => ({ ok: false, reason: 'server starting — try again' }),
    turnActive: () => null,
  };
}
