// The seam between the runner HARNESS (env/args, logging, ws link, frame
// dispatch, shutdown — all provider-neutral) and a concrete AGENT BACKEND
// (Claude today; Codex/Cursor later). The harness owns the socket and turns
// server→runner control frames into method calls; the backend owns the session
// and emits runner→server frames via the host. Nothing in the harness knows
// which backend is running.
import type { BackendId, RunnerFrame } from '../protocol.js';

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
}

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
  slash(cmd: 'compact' | 'clear'): void;
  /** Stop: interrupt the running turn and cancel any queued sends. */
  stop(): void;
  /** Switch the session model. */
  setModel(model: string): void;
  /** Answer an outstanding ask_user question (answers validated by the backend). */
  answer(qid: string, answers: unknown): void;
  /** ws (re)connected: re-deliver anything the server lost (pending questions,
   *  last status) so chat clients recover after a blip. */
  onConnected(): void;
  /** The hello frame reflecting this backend's current session id + turn state. */
  hello(): RunnerFrame;
  /** Tear down the session (resolve blocked tool calls, close the session). */
  shutdown(): void;
}
