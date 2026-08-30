/**
 * Late-bound hook from the HTTP route layer into the ws layer's live agent-
 * runner registry. Routes are built before attachWsServer runs, so the route
 * can't close over the registry directly; instead both sides share this tiny
 * mutable object — createApp hands it to the agent-sessions routes, and
 * attachWsServer overwrites `send` with the real relay once the registry
 * exists. Powers `POST /api/agent-sessions/:paneId/send` (the CLI's
 * "open an agent with a first message" flow).
 */
import type { AgentMode } from '@muxpad/shared';

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
   * `turnActive` — NOT the pane's `status`/`busy`, which is deliberately
   * broader: it stays `working` while a background subagent outlives the turn
   * that launched it (and, on a pane with no runner, tracks raw pty output).
   * `muxpad agent wait` keys on this via GET /api/agent-sessions/by-pane.
   */
  turnActive: (paneId: string) => boolean | null;
  /**
   * Tell the pane's connected runner its agent mode changed (⚡ do / 🧠 deep).
   * Returns false when no runner is connected — NOT an error: the pane row is
   * already authoritative and its startup_cmd carries the mode, so the next
   * respawn boots correctly. Powers `PATCH /api/panes/:id {mode}`.
   */
  setMode: (paneId: string, mode: AgentMode) => boolean;
  /**
   * `submitSend` UNWRAPPED — the raw `{status, reason}` the queue returns.
   * The cron scheduler records that answer VERBATIM into `cron_runs.outcome`,
   * which the boolean-shaped `send` above cannot express ('sent' and 'queued'
   * are both ok:true, and the distinction is exactly what a run history is
   * for). Same single injection path; only the reporting differs.
   */
  submitSend: (
    paneId: string,
    text: string,
  ) => { status: 'sent' | 'queued' | 'rejected'; reason?: string | undefined };
  /**
   * Context-window fill (0-100) for the pane's connected runner, or null when
   * unknown — no runner yet, or a backend that streams no window (codex,
   * cursor). Drives the cron `on_context` policy, which treats unknown as
   * "just fire".
   */
  contextPct: (paneId: string) => number | null;
  /**
   * Epoch ms of the last message RELAYED into this pane (the registry's
   * `lastSendAt`), or null with no runner. The cron `quiet_mins` policy uses
   * it as "the user is right here, back off" — the same signal
   * INTERACTIVE_PUSH_SUPPRESS_MS already keys on.
   */
  lastSendAt: (paneId: string) => number | null;
  /** Relay a slash command to the pane's runner (cron `on_context=compact-first`). */
  slash: (paneId: string, cmd: 'compact' | 'clear') => boolean;
  /** Is the pane's agent blocked on an unanswered question right now? */
  blocked: (paneId: string) => boolean;
}

export function createAgentBridge(): AgentBridge {
  return {
    send: () => ({ ok: false, reason: 'server starting — try again' }),
    turnActive: () => null,
    setMode: () => false,
    submitSend: () => ({ status: 'rejected', reason: 'server starting — try again' }),
    contextPct: () => null,
    lastSendAt: () => null,
    slash: () => false,
    blocked: () => false,
  };
}
