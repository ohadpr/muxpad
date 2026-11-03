// The seam between the runner HARNESS (env/args, logging, ws link, frame
// dispatch, shutdown — all provider-neutral) and a concrete AGENT BACKEND
// (Claude today; Codex/Cursor later). The harness owns the socket and turns
// server→runner control frames into method calls; the backend owns the session
// and emits runner→server frames via the host. Nothing in the harness knows
// which backend is running.
import type { AgentMode, BackendId, NotifyStatus, RunnerFrame } from '../protocol.js';

/** Services the harness provides to a backend. */
export interface RunnerHost {
  /** Send a frame to the main server. No-op if the socket is down (a reconnect
   *  re-delivers durable state via {@link AgentBackend.onConnected}). */
  emit(frame: RunnerFrame): void;
  /** Log a line to the pane's terminal face (stdout) AND the per-pane file log. */
  log(line: string): void;
  /** True while the control socket is open — lets a backend skip work whose
   *  frame would only be dropped (e.g. a mid-turn status refresh). */
  connected(): boolean;
  readonly paneId: string;
  readonly apiUrl: string;
}

/** Parsed launch arguments handed to a backend at construction. */
export interface BackendOptions {
  /** `--resume <ref>`: the session to continue (null = start fresh). */
  requestedSid: string | null;
  /** `--model <id>`: pin the session model (null = backend default). */
  requestedModel: string | null;
  /**
   * `--mode chat|agent`: the pane's agent mode at LAUNCH. This is the only
   * point at which a mode can reach the session as real system-prompt
   * material; a later switch arrives as a `mode` frame and can only be
   * delivered in-conversation (see AgentBackend.setMode / agent-modes.ts).
   * Absent flag = BASELINE_AGENT_MODE ('agent') = exactly the pre-mode
   * behavior.
   */
  mode: AgentMode;
  /**
   * Override the auth self-heal back-off ladder (see auth-heal.ts). Absent in
   * production — the harness never sets it, and the default ladder is the
   * policy. It exists because the give-up path is reached by walking four
   * rungs whose real delays total 85 seconds, and a test that waited them out
   * would be a test nobody runs. The POLICY itself is unit-tested on its own
   * injected clock; this is only for driving the backend through it.
   */
  authHealDelaysMs?: readonly number[];
}

/**
 * ── WHAT EACH BACKEND ACTUALLY SUPPORTS ──────────────────────────────────
 *
 * The interface below says what a backend must OFFER. It cannot say what a
 * backend can DO, because the unsupported answer is a legal implementation: a
 * `slash` that logs "not supported" and a `setMode` that logs "Claude-only"
 * both satisfy the type. So the differences that matter are invisible here,
 * and they have been re-derived by reading three files every time somebody
 * asked. This is that reading, written down once.
 *
 *                        claude            codex             cursor
 *  how it runs           persistent SDK    `codex exec       `cursor-agent`,
 *                        in-process        --json`, one      one spawn per
 *                                          spawn per turn    turn
 *  resumed by            session id, and   thread_id         session_id — and
 *                        only if the                         a vanished cloud
 *                        transcript is                       session silently
 *                        still on disk                       starts fresh
 *  rules arrive          ONCE, at launch   EVERY TURN, via   every turn, same
 *                        (`systemPrompt`,  `turnPreamble`    as codex
 *                        fixed at
 *                        `query()`)
 *  Chat mode             yes               no                no
 *  mode switch live      a one-time note   —                 —
 *                        on the next
 *                        message
 *  sub-agents            yes               no                no
 *  ask_user questions    yes               no                no
 *  notify tool           yes               no                no
 *  names its own chat    yes (`title`)     no                no
 *  /compact, /clear      yes, plus the     no                no
 *                        auto-compactor
 *  stop mid-turn         yes               yes               yes
 *  streams deltas        yes               yes               yes
 *  model switching       yes               yes               yes
 *
 * ── THE ROW THAT CATCHES PEOPLE OUT ──────────────────────────────────────
 *
 * "rules arrive". Claude takes them once, as real system-prompt material, and
 * NOTHING can change them afterwards — so a Claude session keeps following the
 * rules its process was born with. Codex and cursor are handed them again on
 * every turn, so they pick up a change as soon as their runner has the new
 * code.
 *
 * The trap is the last clause. `STANDING_RULES` is compiled into the runner
 * bundle, so editing the rules needs a fresh runner for EVERY backend — the
 * per-turn ones are not exempt, they just need the restart for a different
 * reason. That is the stale-runner notice, and it is correctly
 * backend-blind.
 *
 * Nobody has solved this. No vendor harness lets you rewrite a running
 * session's system prompt; the omnigent meta-harness, which wraps fourteen of
 * them, lands instructions at startup or per-turn composition exactly like
 * this and names the five possible answers rather than fixing any of them.
 *
 * ── TWO THINGS THE TABLE DOES NOT SAY ────────────────────────────────────
 *
 *  · "names its own chat" is the chat's NAME, which only Claude emits (a
 *    `title` frame). The rail's second-line headline is a different thing
 *    entirely — written server-side by chat/HeadlineWriter.ts off the turn-end
 *    bus, so every backend gets one.
 *  · A "no" here is a product decision as often as a limitation. Chat mode is
 *    Claude-only because the mode's whole contract is a system prompt, and a
 *    backend that cannot take one mid-session would wear the label without
 *    the behaviour.
 *
 * KEEP IT HONEST OR DELETE IT. A table that has quietly gone stale is worse
 * than reading the three files, because it is believed. Anything here that a
 * test could assert should become one.
 */
/**
 * A concrete agent backend. The harness constructs one, then drives it:
 *  - control frames from chat → {@link send}/{@link slash}/{@link stop}/
 *    {@link setModel}/{@link answer}
 *  - ws (re)connect → {@link hello} (harness emits it) + {@link onConnected}
 *  - shutdown/signal → {@link shutdown}
 * The backend emits its turn lifecycle (turn-start/stream/turn-done/question/
 * subagent/status/title/fatal) through {@link RunnerHost.emit}.
 */
export interface AgentBackend {
  /** Which backend this is — stamped into the hello frame + used for logging. */
  readonly id: BackendId;
  /** Begin the session loop. Resolves only when the session ends. */
  start(): Promise<void>;
  /** A user turn from chat. */
  send(text: string): void;
  /** A session-management slash command from chat. */
  /** `args` is `/compact` only: what the summary must keep. muxpad never
   *  compacts unasked, so this always carries a press's instructions. */
  slash(cmd: 'compact' | 'clear', args?: string): void;
  /** Stop: interrupt the running turn and cancel any queued sends. */
  stop(): void;
  /** Switch the session model. */
  setModel(model: string): void;
  /**
   * The pane's mode changed while this session is live. NO harness can
   * rewrite a running session's system prompt, so the honest contract every
   * backend implements is: remember the new mode, and prepend a one-time
   * delimited `<muxpad-mode>` note to the NEXT user message. A frame carrying
   * the mode already in effect is a no-op. See agent-modes.ts.
   */
  setMode(mode: AgentMode): void;
  /** Answer an outstanding ask_user question (answers validated by the backend). */
  answer(qid: string, answers: unknown): void;
  /**
   * What became of a `notify` the backend emitted (sent / held / dropped), so
   * its blocked tool call can tell the MODEL rather than claim a delivery it
   * cannot observe.
   *
   * OPTIONAL, unlike the rest: it answers a frame only a backend that offers
   * the `notify` tool can ever have sent, so a backend without that tool has
   * nothing to implement. The harness calls it with `?.`.
   */
  notifyResult?(nid: string, status: NotifyStatus): void;
  /** ws (re)connected: re-deliver anything the server lost (pending questions,
   *  last status) so chat clients recover after a blip. */
  onConnected(): void;
  /** The hello frame reflecting this backend's current session id + turn state. */
  hello(): RunnerFrame;
  /** Tear down the session (resolve blocked tool calls, close the session). */
  shutdown(): void;
}
