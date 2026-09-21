// THE DELEGATION LOOP.
//
// Everything else in this folder is a part; this is the machine. It owns one
// live conversation: transcript in, tasks claimed, requests dispatched to the
// Chat pane over the socket that already exists, results narrated back as
// appends.
//
// ═══ THE ONE IDEA THAT SHAPES ALL OF IT ═══
//
// AN AGENT TURN TAKES MINUTES. A VOICE MODEL WILL NOT WAIT.
//
// So there is no point in the code where a task is "handled" — no await that
// spans the work, no promise resolved with an answer. A task is ACKNOWLEDGED in
// milliseconds with a silent `thinking` append (which is what lets the model say
// "on it" in its own words), the request goes out on the chat socket, and then
// results arrive over the following minutes as appends against the same task id.
//
// ═══ AND THE ONE THAT USED TO BE MISSING: TALKING IS FREE ═══
//
// SPEAKING IS NOT A KILL SWITCH. This session used to fire `{t:'stop'}` at the
// agent whenever the user made a noise over a running turn, and to invalidate
// everything in flight whenever a second delegation arrived. Together those made
// the product unusable in the way that matters most: you could not ask "how's it
// going?" without destroying the work you were asking about.
//
// The rule now is LiveKit's, in their words: INTERRUPTING IS NOT CANCELLING.
// Barge-in is about the floor — who is talking — and has nothing to do with
// whether work continues. Nova Sonic states the invariant we hold ourselves to:
// no automatic cancellation on new user input, and a result that was asked for
// is delivered even if the user has since changed their mind about wanting it.
//
// ═══ THREE SEPARATE DECISIONS, KEPT SEPARATE ═══
//
//   IDENTITY + STATUS lives in delegation.ts as a durable task record with a
//     stable id and an explicit lifecycle. Nothing here infers liveness from
//     anything but that status.
//   ARRIVAL POLICY — what happens when a request lands on a busy agent — is
//     named, per-arrival, and defaults to ENQUEUE (see cancel.ts). It is not a
//     global constant, and it is emphatically not "always supersede", which is
//     what shipped.
//   DELIVERY POLICY — when an append is allowed to reach the model — is
//     delivery.ts, and defaults to holding until the user stops talking.
//
// The revision counter survives all of this as a FENCING TOKEN over spoken
// output, which is the one job it was ever good at. Cancellation is cooperative:
// a stopped turn can still emit its tail, and the fence is what stops that tail
// being spoken. It decides nothing about what runs.
//
// ═══ ATTRIBUTION, WHICH OVERLAP MAKES HARDER, NOT EASIER ═══
//
// Chat frames carry no task id — `/ws/chat/:paneId` is one flat stream per pane.
// With one task in flight you could get away with "attribute to the open one".
// With two you cannot: answer A would be spoken as the answer to question B,
// confidently, which is worse than the bug this change fixes.
//
// The load-bearing fact is that THE SERVER RUNS ONE TURN AT A TIME. `submitSend`
// starts a turn only when the agent is idle and the queue is empty; everything
// else is persisted and drained strictly FIFO on `turn-done`. So turns are
// serial, their order is submit order, and attribution reduces to "which of my
// requests owns the turn that is running right now". That is answered two ways,
// best first:
//
//   1. BY TEXT. The server stamps its `turn-start` broadcast with the message
//      that started the turn — a correlation identifier in the Hohpe & Woolf
//      sense, chosen because it is the one field both ends already agree on. An
//      exact match against a request of ours binds it; NO MATCH MEANS THE TURN
//      IS SOMEONE ELSE'S — the user typing in the same pane, a cron, a wakeup —
//      and we bind nothing and stay silent. That is what lets the user type into
//      the pane while voice is live without the two fighting over the turn.
//   2. BY ORDER. Against a server that doesn't stamp it, fall back to the FIFO
//      head of our own pipeline, which is right whenever the pane is ours alone.
//
// One request is bound at a time; binding only happens when nothing is bound
// (a mid-turn reconnect re-broadcasts `turn-start`, and that must not re-bind);
// `turn-done` releases it. Frames with no binding are dropped.
//
// ═══ WHAT IS NOT HERE ═══
//
// No DOM, no WebRTC, no fetch, no real timers. The transport, the agent link and
// the clock are all injected, which is what lets a full session — connect,
// speak, delegate, queue a second task, narrate both, cancel — run in a unit
// test against a fake data channel.
//
// Also not here: SPOKEN REFERENCE RESOLUTION. "that thing I asked about
// earlier" is not resolved to a task anywhere in this folder, on purpose — it is
// unsolved and it is its own module. The task records are ordered, live and
// addressable so that such a module stays possible; do not sprinkle heuristics
// for it through this file.

import { type ArrivalPolicy, arrivalPolicyFor } from './cancel';
import { chunkForAppend } from './chunk';
import { DelegationRegistry, type VoiceTask } from './delegation';
import {
  type DeliveryPolicy,
  DeliveryQueue,
  FLOOR_POLL_MS,
  IDLE_QUIET_MS,
  conversationMovedOn,
  reanchorInstruction,
} from './delivery';
import { ECHO_LOOKBACK_MS, MicGate } from './mic-gate';
import type { AppendIntent, InboundEvent, OutboundEvent } from './protocol';
import {
  channelOf,
  describeSessionError,
  isAppendAck,
  isDelegationCreated,
  isSessionError,
  isTranscriptDelta,
} from './protocol';
import { type PendingQuestion, answersFor, describeAnswer } from './question';
import { SpeakBridge, type VoiceChatFrame, parseChatFrame } from './speak-bridge';
import { GAP_MS, TranscriptBuffer, type Utterance, reconstructRequest } from './transcript';
import type { TransportState, VoiceTransport } from './transport';

/** The five live states the UI renders. `ended` is terminal. */
export type VoiceUiState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'ended';

/** How the voice layer reaches the agent: the EXISTING `/ws/chat/:paneId`
 *  socket, and nothing else. There is deliberately no second path — a voice
 *  request is the same `{t:'send'}` frame the composer fires, so it lands in
 *  the same transcript, obeys the same server-side queue, and shows up on
 *  screen verbatim while the model paraphrases it aloud. */
export interface AgentLink {
  /** Fire a `{t:'send'}`. False when the socket isn't open. */
  send(text: string): boolean;
  /** Fire a `{t:'stop'}`. A REQUEST, not a guarantee — cancellation is
   *  cooperative, the turn takes a moment to die and can still emit a final
   *  reply on the way out. It also writes a durable interrupted notice, which
   *  is exactly what an explicit cancel should leave behind and exactly why
   *  nothing but an explicit cancel may call it. */
  stop(): void;
  /**
   * Drop one of OUR still-queued sends before it runs (`{t:'queue-cancel'}`).
   *
   * Optional: a link without it degrades to "the cancelled backlog runs
   * anyway", which is not a crash. Needed because `stop()` only reaches the
   * turn CURRENTLY running — with tasks queueing behind each other, stopping
   * the running one and letting its successors fire is a surprising way to
   * honour "stop".
   */
  cancelQueued?(id: string): void;
  /**
   * Answer an open agent question (`{t:'answer'}`) — an `ask_user`, or the
   * reversibility gate holding an irreversible command.
   *
   * A BLOCKED AGENT CANNOT BE UNBLOCKED BY `send`. A question is raised inside
   * a turn that is still running, so the server queues any `send` that arrives
   * behind it (ws.ts `submitSend`) and the gate goes on waiting for an answer
   * that is now stuck in line behind the thing it would have released. Without
   * this verb a spoken "do it" is a deadlock, not an approval.
   *
   * Optional only so a link that predates it still type-checks; a session
   * without it can speak a question but never answer one.
   */
  answer?(qid: string, answers: Array<{ question: string; answers: string[] }>): void;
  /** Every frame from the chat socket, unparsed. */
  onFrame(cb: (raw: unknown) => void): () => void;
}

/** Injected clock + timers. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(h: number): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
};

/** Quiet, in wall-clock ms, that means the user has stopped talking and the
 *  request can be taken as written. */
export const SETTLE_QUIET_MS = 600;
/** Never hold a task longer than this before dispatching what we have.
 *  A trailing subordinate clause is a smaller loss than a dead-air pause. */
export const SETTLE_MAX_MS = 2500;
/**
 * Quiet before the cancel probe will rule on an utterance.
 *
 * LONGER THAN THE SETTLE WINDOW, on purpose. The settle window decides what to
 * SEND, and being early there costs a truncated request. This window decides
 * whether to THROW WORK AWAY, and being early there cancels on the word "stop"
 * in "stop the dev server".
 *
 * ═══ AND IT USED TO BE 900ms, WHICH WAS THE WRONG SIDE OF THE ONLY LINE ═══
 *
 * The constant's reasoning was that sitting BELOW transcript.ts's 1200ms gap
 * meant "we are still inside one utterance, so it must be finished". That is
 * exactly backwards. {@link GAP_MS} is the window in which the utterance can
 * still GROW — a delta arriving inside it is glued onto the same segment, and
 * the segment object is live, so the probe re-read a sentence that was still
 * being said. Judging at 900 against a 1200 gluing window left a 300ms band,
 * by construction, in which "stop" was ruled a cancel and "the dev server"
 * arrived immediately afterwards to no effect: `judged` had already marked the
 * segment, the turn was already dead, and the interrupted notice was already
 * written.
 *
 * THE TWO CLOCKS MAKE IT WIDER THAN 300ms. This timer runs on `sched.now()` —
 * ARRIVAL time. The segmenter compares `start_ms`/`end_ms` — the API's own
 * SPEECH clock. Realtime ASR batches on its VAD cadence and the network adds
 * jitter, so a 400ms speech gap routinely shows up as a ~950ms arrival gap.
 * There is no mapping between the two available here, so the only safe move is
 * to wait out the whole gluing window and then some.
 *
 * Hence: derived from GAP_MS rather than chosen independently, so the two
 * cannot drift back into the wrong order, plus a margin for the jitter. The
 * cost is that a bare spoken "stop" takes ~1.5s to reach the BACKSTOP — and it
 * is only ever the backstop. The main path is the model hearing the cancel and
 * delegating it, which is immediate. The file's own asymmetry settles the
 * trade: a late cancel costs one repetition, an early one costs minutes of
 * work.
 */
export const CANCEL_PROBE_QUIET_MS = GAP_MS + 300;
/** Cadence of the "still working" update during a long turn. SPOKEN — see
 *  {@link VoiceSession.armHeartbeat}. */
export const HEARTBEAT_MS = 25_000;
/**
 * How long we give the model to say something of its own after a dispatch
 * before we hand it a filler to speak.
 *
 * GPT-Live has NO built-in fillers; whatever the user hears while an agent
 * works, we put there. In practice the model does volunteer one line off the
 * back of `session.delegation.created` ("okay, I'm gonna pass that to the
 * agent, hang on") — so speaking unconditionally would talk over it. Hence a
 * short grace: fill only the silence that is actually silent.
 */
export const DISPATCH_FILLER_MS = 1500;
/** Silence on the output transcript after which we stop calling it speaking. */
export const SPEAKING_DECAY_MS = 900;
/**
 * ═══ A SESSION THAT CANNOT SPEAK MUST NOT QUIETLY BILL ═══
 *
 * `speak`/`speak-delta` are the only frames that become an answer, and they
 * exist only inside the `reply` tool. Two panes will never send one:
 *
 *   · one switched Agent→Chat mid-session — `mcpServers` are fixed when
 *     `query()` is constructed and the tool can never be added afterwards,
 *     while the mic appears the instant the pane row flips; and
 *   · one whose runner PROCESS predates `reply` shipping. Runners live for
 *     weeks, so this is not a migration edge, it is the normal state of any
 *     long-running pane.
 *
 * Both delegate correctly, work correctly, finish correctly — and say nothing.
 * The user hears the model's "on it", then silence, while the meter runs to its
 * ten-minute ceiling. The written answer lands in the chat, so nothing anywhere
 * looks broken. This is the most expensive shape of failure this feature has:
 * total, silent, and indistinguishable from a slow agent.
 *
 * A turn OF OURS that succeeded and produced no reply, on a session that has
 * never seen one, is the proof. When it lands we say so out loud and hang up.
 *
 * HOW LONG TO WAIT BEFORE HANGING UP. Long enough for the model to actually
 * deliver the sentence — tearing the peer connection down the same tick would
 * make the explanation itself silent, which is the bug wearing a hat. Two
 * sentences of speech, generously.
 */
export const MUTE_RUNNER_GRACE_MS = 10_000;

/** What the user hears. It names the defect, points at where the answer IS,
 *  and says why the call is ending — a hang-up with no reason reads as a
 *  crash. */
export const MUTE_RUNNER_LINE =
  'Say this to the user, then stop: the agent finished, but this pane cannot send its answers to voice — its agent session is too old to have the reply tool. The answer is written in the chat. Ending the voice session so it does not keep costing money; restart the agent pane and voice will work.';

/** The detail the UI shows once it has. */
export const MUTE_RUNNER_DETAIL =
  'Voice ended — this pane’s agent can’t send answers to voice (it started before the reply tool existed). Restart the agent pane, then try again.';
/**
 * After an explicit cancel, ignore further cancels for this long.
 *
 * A cancel reaches us twice by design — once when the model delegates it, and
 * again from the transcript backstop a beat later. Without this the user hears
 * "Stopped." twice and we fire a second, pointless `{t:'stop'}` at whatever
 * turn has started since.
 */
export const CANCEL_DEBOUNCE_MS = 4000;
/**
 * Grace between one of our sends leaving the server's queue and calling it
 * cancelled.
 *
 * A row leaves the queue for TWO reasons and the broadcast does not say which:
 * it was dropped (`queue-cancel` from the chat UI, or `editQueued`, which is a
 * cancel plus a re-send), or it was drained into a turn that is starting right
 * now. The drain removes the row and broadcasts BEFORE the runner's
 * `turn-start` echoes back, so a disappearance has to be given long enough for
 * that echo to arrive before it can be read as a cancellation. A round trip is
 * milliseconds; this is three orders of magnitude of slack, and the cost of
 * being wrong in the safe direction is only that a cancelled task is retired a
 * few seconds late.
 */
export const QUEUE_DROP_GRACE_MS = 4000;

export interface VoiceSessionOpts {
  transport: VoiceTransport;
  agent: AgentLink;
  onState: (s: VoiceUiState, detail?: string) => void;
  scheduler?: Scheduler;
  micGate?: MicGate;
  settleQuietMs?: number;
  settleMaxMs?: number;
  cancelProbeQuietMs?: number;
  heartbeatMs?: number;
  dispatchFillerMs?: number;
  /** Quiet on the input transcript before a held append is released. */
  idleQuietMs?: number;
  /** Include the model's last line as context in the dispatched request. */
  withContext?: boolean;
  /** Diagnostics, off by default. */
  onTrace?: (line: string) => void;
  /** An `error` event from the model's wire, already summarised to one line.
   *  Wire this to something a human will actually see: a rejected append is
   *  invisible from every other angle. */
  onProtocolError?: (line: string) => void;
}

/** Counters worth asserting on in tests and worth showing in a debug panel.
 *  Every one of them is a bug class that is otherwise invisible. */
export interface VoiceSessionStats {
  delegationsClaimed: number;
  duplicatesRefused: number;
  staleDrops: number;
  appendsSent: number;
  requestsDispatched: number;
  /** Explicit cancels honoured. This is the ONLY counter that can be non-zero
   *  while the user still has work running, and every increment threw some
   *  away — so it is the first number to look at when someone says "it keeps
   *  stopping". */
  cancels: number;
  /** Requests that landed behind work already in flight — i.e. the whole point
   *  of the change: tasks that QUEUED instead of cancelling. */
  tasksQueued: number;
  /** Tasks whose reconstructed request was identical to something already in
   *  flight, and were therefore not dispatched a second time. */
  duplicateRequests: number;
  /** Utterances routed to an open agent question instead of being dispatched as
   *  new work. A blocked agent is released by these and by nothing else. */
  questionsAnswered: number;
  /** Appends held because the user was mid-sentence. Non-zero means the
   *  delivery policy earned its keep. */
  deliveriesHeld: number;
  /** Results that needed re-anchoring because the conversation had moved on. */
  reanchored: number;
  /** Appends the model acknowledged. `appendsSent` without `appendsAcked` is
   *  the exact signature of the `text`-instead-of-`content` bug. */
  appendsAcked: number;
  /** `error` events received. Anything but zero is a bug on our side. */
  protocolErrors: number;
}

/**
 * Tool names out of a live `events` batch, for the progress update.
 *
 * READS `name` AND NOTHING ELSE. An events batch also carries the agent's plain
 * text, which in Chat mode is a PRIVATE scratchpad the user is promised they
 * will never be shown — so this function must never grow a branch that touches
 * anything but a tool_use's name. Returns the LAST tool in the batch, which is
 * the one currently running.
 */
/**
 * Is this frame carrying the ANSWER, as opposed to progress about it?
 *
 * The `final` leg of Pipecat's three-message envelope. Only a final is
 * re-anchored when the conversation has moved on; doing it for progress
 * updates prefixes every heartbeat with "the conversation has moved on", which
 * is both untrue and expensive. Measured in a live session: without this gate,
 * five of five commentary appends were re-anchored, four of them wrongly.
 */
function isFinalFrame(frame: VoiceChatFrame): boolean {
  return (
    frame.t === 'speak' ||
    frame.t === 'speak-delta' ||
    frame.t === 'turn-done' ||
    frame.t === 'error'
  );
}

export function latestToolName(raw: unknown): string | null {
  const f = raw as { t?: unknown; events?: unknown };
  if (f?.t !== 'events' || !Array.isArray(f.events)) return null;
  let name: string | null = null;
  for (const e of f.events) {
    const ev = e as { kind?: unknown; name?: unknown };
    if (ev?.kind === 'tool_use' && typeof ev.name === 'string' && ev.name) name = ev.name;
  }
  return name;
}

export class VoiceSession {
  private readonly t: VoiceTransport;
  private readonly agent: AgentLink;
  private readonly sched: Scheduler;
  private readonly gate: MicGate;
  private readonly buf = new TranscriptBuffer();
  private readonly registry = new DelegationRegistry();
  private readonly bridge = new SpeakBridge();
  private readonly pending = new DeliveryQueue<VoiceTask>();
  private readonly onStateCb: (s: VoiceUiState, detail?: string) => void;
  private readonly settleQuietMs: number;
  private readonly settleMaxMs: number;
  private readonly cancelProbeQuietMs: number;
  private readonly heartbeatMs: number;
  private readonly dispatchFillerMs: number;
  private readonly idleQuietMs: number;
  private readonly withContext: boolean;
  private readonly trace: (line: string) => void;
  private readonly onProtocolError: (line: string) => void;
  /** Stamped on every outbound append so a rejection can be traced back to the
   *  append that caused it rather than merely counted. */
  private eventSeq = 0;

  private unsubs: Array<() => void> = [];
  /** Nothing may be sent before `session.started`. Appends produced earlier
   *  are queued rather than dropped — the model is entitled to know the agent
   *  was already working when the channel came up. */
  private started = false;
  private outbound: OutboundEvent[] = [];
  private disposed = false;

  private uiState: VoiceUiState = 'connecting';
  private turnRunning = false;
  /** -Infinity, not 0: with any clock that starts at zero, `now - 0 < decay`
   *  is true, and a session would open in the `speaking` state having never
   *  heard a word. */
  private lastOutputAt = Number.NEGATIVE_INFINITY;
  private lastInputDeltaAt = Number.NEGATIVE_INFINITY;
  private speakingTimer: number | null = null;
  /** One settle timer PER task — two can be settling at once now, and a single
   *  shared handle would silently cancel the first one's dispatch. */
  private settleTimers = new Map<string, number>();
  private heartbeatTimer: number | null = null;
  private fillerTimer: number | null = null;
  private cancelProbeTimer: number | null = null;
  private floorTimer: number | null = null;
  /** Set once we have PROVED this pane cannot answer aloud — see
   *  {@link MUTE_RUNNER_GRACE_MS}. Latched, so we say it once and hang up once. */
  private muteRunnerDeclared = false;
  private muteRunnerTimer: number | null = null;
  /** One per task whose queue row has vanished, pending the grace window that
   *  tells "it started" from "it was cancelled". See {@link reconcileQueue}. */
  private orphanTimers = new Map<string, number>();

  /**
   * Our dispatched requests, in the order the server will run them.
   *
   * The mirror of the server's own serial queue, and the mirror is what makes
   * attribution possible at all. Entries are live registry records, and every
   * status change goes through `registry.setStatus` — the registry is the one
   * place a status moves, so "who closed this task?" has exactly one answer.
   */
  private pipeline: VoiceTask[] = [];
  /**
   * Has this server ever stamped a `turn-start` with the message that started
   * it? A LATCH, and it only ever goes up.
   *
   * `bindTurn` falls back to submit order on an unstamped turn-start, on the
   * theory that the only thing that produces one is a server too old to stamp.
   * That is not true: the server re-broadcasts a BARE `turn-start` when a
   * runner reconnects mid-turn (it rebuilt its per-connection state from
   * nothing, so it genuinely cannot name the message any more). Without this
   * latch that broadcast reaches the order fallback and binds whatever is at
   * the head of our pipeline — to a turn that is already running, for someone
   * else's request. One stamped turn proves the server stamps; after that, an
   * unstamped one means "this turn has no name", and a turn with no name is
   * not ours.
   */
  private serverStampsTurns = false;
  /** The task that owns the turn currently on the wire, or null when the
   *  running turn is not ours (typed, cron, wakeup) or nothing is running. */
  private bound: VoiceTask | null = null;
  /** Last tool the bound turn started, for the progress update. Name only. */
  private lastTool: string | null = null;
  private lastCancelAt = Number.NEGATIVE_INFINITY;
  /**
   * The agent question currently waiting on the user, if any.
   *
   * Held for exactly as long as the agent is blocked on it, because while it is
   * set the NEXT thing the user says is an answer rather than a new request —
   * see `settle`. Cleared by `question-done`, and on teardown.
   */
  private pendingQuestion: PendingQuestion | null = null;

  /** Utterances the cancel probe has already ruled on, so one sentence is
   *  judged once rather than once per delta. */
  private judged = new WeakSet<Utterance>();

  readonly stats: VoiceSessionStats = {
    delegationsClaimed: 0,
    duplicatesRefused: 0,
    staleDrops: 0,
    appendsSent: 0,
    requestsDispatched: 0,
    cancels: 0,
    tasksQueued: 0,
    duplicateRequests: 0,
    questionsAnswered: 0,
    deliveriesHeld: 0,
    reanchored: 0,
    appendsAcked: 0,
    protocolErrors: 0,
  };

  constructor(opts: VoiceSessionOpts) {
    this.t = opts.transport;
    this.agent = opts.agent;
    this.sched = opts.scheduler ?? realScheduler;
    this.gate = opts.micGate ?? new MicGate();
    this.onStateCb = opts.onState;
    this.settleQuietMs = opts.settleQuietMs ?? SETTLE_QUIET_MS;
    this.settleMaxMs = opts.settleMaxMs ?? SETTLE_MAX_MS;
    this.cancelProbeQuietMs = opts.cancelProbeQuietMs ?? CANCEL_PROBE_QUIET_MS;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.dispatchFillerMs = opts.dispatchFillerMs ?? DISPATCH_FILLER_MS;
    this.idleQuietMs = opts.idleQuietMs ?? IDLE_QUIET_MS;
    this.withContext = opts.withContext ?? true;
    this.trace = opts.onTrace ?? (() => {});
    this.onProtocolError = opts.onProtocolError ?? (() => {});
  }

  /** Subscribe to both wires. Safe to call once. */
  start(): void {
    this.unsubs.push(this.t.onEvent((e) => this.onModelEvent(e)));
    this.unsubs.push(this.t.onState((s, d) => this.onTransportState(s, d)));
    this.unsubs.push(this.agent.onFrame((raw) => this.onChatFrame(raw)));
    if (this.t.state === 'open') this.setState('connecting');
  }

  get state(): VoiceUiState {
    return this.uiState;
  }

  /**
   * What is running and what is waiting, newest last.
   *
   * The client-side answer to `get_running_tasks()`. On this transport the
   * model cannot call a tool — `delegation: {type:'client'}` gives it exactly
   * one verb — so instead of a tool it can call, the same information is PUSHED
   * to it as silent context whenever it changes (see `describePipeline`). Same
   * outcome, one fewer round trip: "what are you working on?" is answerable
   * from what the model already holds, and never reaches the agent.
   */
  get tasks(): ReadonlyArray<{ id: string; status: VoiceTask['status']; request: string }> {
    return this.pipeline.map((t) => ({ id: t.id, status: t.status, request: t.request }));
  }

  // ── The model's wire ──────────────────────────────────────────────────────

  private onModelEvent(e: InboundEvent): void {
    if (this.disposed) return;
    if (e.type === 'session.started') {
      this.started = true;
      this.trace('session.started');
      this.flushOutbound();
      this.recomputeState();
      return;
    }
    if (isTranscriptDelta(e)) {
      const channel = channelOf(e);
      const seg = this.buf.push(channel, e);
      if (channel === 'output') {
        // Deriving "speaking" from transcript rather than from an audio event
        // is deliberate — see protocol.ts. It is also what arms the echo gate.
        this.lastOutputAt = this.sched.now();
        this.gate.observedOutput(e.end_ms);
        this.armSpeakingDecay();
      } else {
        this.armCancelProbe(seg);
      }
      this.recomputeState();
      return;
    }
    if (isDelegationCreated(e)) {
      this.onDelegation(e.delegation.id, e.delegation.target, e.offset_ms);
      return;
    }
    if (isAppendAck(e)) {
      this.stats.appendsAcked += 1;
      return;
    }
    // NEVER swallow this. An append refused here is an answer the user will
    // never hear, and it is otherwise completely silent — no throw, no state
    // change, no missing frame anywhere else in the system.
    if (isSessionError(e)) {
      this.stats.protocolErrors += 1;
      const line = describeSessionError(e);
      this.trace(`model error: ${line}`);
      this.onProtocolError(line);
    }
  }

  /**
   * A delegation arrived. Claim it or drop it — there is no third option, and
   * in particular there is no "handle it anyway, probably fine".
   *
   * NOTHING IS STOPPED HERE, and nothing is invalidated. This used to bump the
   * fence and `{t:'stop'}` the running turn on the theory that a new task
   * replaces the old one. It doesn't: the user asking a second thing is the
   * ordinary case, and the server queue exists precisely so it can be served
   * without abandoning the first.
   */
  private onDelegation(id: string, target: string, offsetMs: number): void {
    if (target !== 'client') {
      this.trace(`delegation ${id} not for us (${target})`);
      return;
    }
    // Check BEFORE claiming. A duplicate delivery must be completely inert —
    // it must not touch the original claim's state in any way.
    if (this.registry.hasSeen(id)) {
      this.stats.duplicatesRefused += 1;
      this.trace(`delegation ${id} duplicate — refused`);
      return;
    }

    const task = this.registry.claim(id, { now: this.sched.now(), offsetMs });
    if (!task) return; // unreachable given hasSeen above; cheap to be sure
    this.stats.delegationsClaimed += 1;

    // Acknowledge NOW. Silent, because the model narrates in its own voice;
    // this only tells it that work exists so it stops waiting on us.
    this.emitNow(task, {
      kind: 'thinking',
      text: 'Picking this up — passing it to the agent now.',
    });
    this.scheduleSettle(task);
  }

  // ── The settle window ─────────────────────────────────────────────────────

  private scheduleSettle(task: VoiceTask): void {
    this.clearSettle(task.id);
    this.settleTimers.set(
      task.id,
      this.sched.setTimeout(() => {
        this.settleTimers.delete(task.id);
        this.settle(task);
      }, this.settleQuietMs),
    );
  }

  /**
   * Decide what was actually asked, apply the arrival policy, and send it.
   *
   * Re-checks staleness first. With supersession gone, stale means the task was
   * closed — by an explicit cancel, or by teardown — and a cancelled request
   * must not be dispatched after the fact.
   */
  private settle(task: VoiceTask): void {
    if (this.disposed) return;
    if (this.registry.isStale(task)) {
      this.stats.staleDrops += 1;
      this.trace(`settle ${task.id} dropped — stale`);
      return;
    }
    const elapsed = this.sched.now() - task.claimedAt;
    const quietFor = this.sched.now() - this.lastInputDeltaAt;
    const r = reconstructRequest(this.buf, {
      offsetMs: task.offsetMs,
      withContext: this.withContext,
    });
    // Still mid-sentence and still within budget → give the transcript another
    // beat. `quietFor` is what stops this looping on a user who never uses
    // punctuation: once they stop talking we take what we have regardless.
    const worthWaiting = !r.complete && quietFor < this.settleQuietMs;
    if (worthWaiting && elapsed < this.settleMaxMs) {
      this.scheduleSettle(task);
      return;
    }
    if (!r.text) {
      // Deliver, THEN retire — and the delivery survives the retirement because
      // `flushFloor` re-checks only the fence. Both halves matter: this message
      // is held for the floor by default, so it is routinely released after the
      // `failed` below has already made the task stale.
      this.deliver(task, {
        kind: 'commentary',
        text: 'I didn’t catch that — can you say it again?',
      });
      this.registry.setStatus(task.id, 'failed');
      return;
    }

    // ── THE ARRIVAL POLICY, chosen per arrival ──────────────────────────────
    //
    // `interrupt` here means the utterance WAS the instruction to abandon the
    // running work, so it is not a task at all and never reaches the agent.
    // This is the model-visible cancel path: GPT-Live delegated it, we route it
    // to the cancel machinery instead of to Claude. (On this transport the
    // model has no `cancel_task` tool to call — `delegation: {type:'client'}`
    // gives it one verb — so a delegated cancel IS the tool call, expressed in
    // the only vocabulary the wire has.)
    const policy: ArrivalPolicy = arrivalPolicyFor(r.utterance?.text ?? r.text);
    if (policy === 'interrupt') {
      this.trace(`settle ${task.id} is a cancel, not a task`);
      this.cancel(task, 'delegated');
      return;
    }

    // ── A BLOCKED AGENT WANTS AN ANSWER, NOT A NEW REQUEST ──────────────────
    //
    // Checked AFTER the cancel probe on purpose: "stop" said over an open
    // question means abandon the work, not answer it, and the gate fails closed
    // on an interrupted question anyway.
    if (this.pendingQuestion) {
      this.answerPending(task, r.utterance?.text ?? r.text);
      return;
    }

    // TWO DELEGATIONS, ONE SENTENCE. `segmentAt` joins on a timestamp, and two
    // delegations fired either side of one pause both land on the same
    // utterance. Now that the second no longer supersedes the first, dispatching
    // both means two agent turns doing identical work — and the user hearing the
    // same answer twice.
    const already = this.pipeline.find((d) => d.request.trim() === r.text.trim());
    if (already) {
      this.stats.duplicateRequests += 1;
      this.trace(`settle ${task.id} duplicates in-flight request — not dispatched`);
      this.emitNow(task, {
        kind: 'thinking',
        text: 'That is the same thing already in flight — not asking twice.',
      });
      this.registry.setStatus(task.id, 'completed');
      return;
    }

    if (!this.agent.send(r.text)) {
      this.deliver(task, {
        kind: 'commentary',
        text: 'I can’t reach the chat right now — the connection dropped.',
      });
      this.registry.setStatus(task.id, 'failed');
      return;
    }

    this.stats.requestsDispatched += 1;
    const behind = this.pipeline.length;
    if (behind > 0) this.stats.tasksQueued += 1;
    task.request = r.text;
    task.dispatchedAt = this.sched.now();
    task.wasQueued = behind > 0;
    this.registry.setStatus(task.id, 'queued');
    this.pipeline.push(task);
    this.trace(`dispatched ${task.id}: ${r.text.slice(0, 80)}`);

    // ── THE `started` MESSAGE, and the sentence that earns its place ─────────
    //
    // Pipecat added the "do not call it again" line after shipping the bug it
    // prevents: a model handed a tool that has not returned calls it again, and
    // then invents a plausible result. Our equivalent failure is re-delegating
    // the same request to Claude, which costs minutes and money and produces
    // two contradictory answers. So the acknowledgement says, explicitly, that
    // the answer is coming and must not be guessed.
    this.emitNow(task, {
      kind: 'thinking',
      text: [
        `Sent to the agent: ${r.text}`,
        'It is running now and will take minutes, not seconds.',
        'Do not send this again and do not invent a result —',
        'I will hand you the answer here the moment it exists.',
      ].join(' '),
    });
    this.emitNow(task, { kind: 'thinking', text: this.describePipeline() });
    this.armFiller(task, behind > 0);
    this.armHeartbeat();
  }

  /**
   * Send what the user just said back as the answer to the open question.
   *
   * NOT A TASK. Nothing is dispatched, nothing joins the pipeline and no
   * heartbeat is armed: answering a question does not start an agent turn, it
   * UNBLOCKS the one already running. The task record the delegation created is
   * retired immediately so it never shows up in the running-work snapshot as a
   * phantom request the model would then narrate.
   *
   * The mapping from speech to option is question.ts's, and it fails closed:
   * anything that is not plainly one of the labels is forwarded verbatim, which
   * every consumer of an answer already treats as "not the affirmative".
   */
  private answerPending(task: VoiceTask, spoken: string): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    if (!this.agent.answer) {
      // A link with no answer verb cannot unblock the agent, and sending this
      // as a request would queue it behind the very question it answers. Say so
      // rather than silently deadlocking.
      this.deliver(task, {
        kind: 'commentary',
        text: 'I can’t answer that from here — tap one of the options on screen.',
      });
      this.registry.setStatus(task.id, 'failed');
      return;
    }
    const answers = answersFor(spoken, pending);
    this.agent.answer(pending.qid, answers);
    this.stats.questionsAnswered += 1;
    this.trace(`answered ${pending.qid}: ${JSON.stringify(answers[0]?.answers ?? [])}`);
    // Clear optimistically. `question-done` confirms it, but the agent may take
    // a beat to send one and a second utterance in that window must not be read
    // as a second answer to a question that is already resolved.
    this.pendingQuestion = null;
    this.deliver(task, { kind: 'commentary', text: describeAnswer(spoken, pending) });
    this.registry.setStatus(task.id, 'completed');
  }

  private clearSettle(id?: string): void {
    if (id === undefined) {
      for (const h of this.settleTimers.values()) this.sched.clearTimeout(h);
      this.settleTimers.clear();
      return;
    }
    const h = this.settleTimers.get(id);
    if (h != null) this.sched.clearTimeout(h);
    this.settleTimers.delete(id);
  }

  /**
   * The running-task snapshot, pushed to the model as silent context.
   *
   * This is the substitute for a `get_running_tasks()` tool the model cannot
   * call on this transport, and it is what makes "how's it going?" answerable
   * WITHOUT touching the agent — which is the entire point of the change.
   */
  private describePipeline(): string {
    if (this.pipeline.length === 0) return 'Nothing is running for the agent right now.';
    const lines = this.pipeline.map((t, i) => {
      const what = t.request.length > 100 ? `${t.request.slice(0, 97)}…` : t.request;
      return `${i + 1}. [${t.status}] ${what}`;
    });
    return [
      'Agent work in flight, in the order it will run.',
      'Use this to answer questions about progress yourself — never delegate those:',
      ...lines,
    ].join('\n');
  }

  // ── Long work ─────────────────────────────────────────────────────────────

  /**
   * Say SOMETHING once the request is on its way — but only into real silence.
   *
   * There are no built-in fillers in this API: every sound the user hears while
   * an agent works is one we asked for. The model does usually volunteer a line
   * of its own off `session.delegation.created`, so this waits a beat and fires
   * only if it didn't — the alternative is two voices saying "hang on" over
   * each other, which is worse than the dead air it was meant to fix.
   */
  private armFiller(task: VoiceTask, queued: boolean): void {
    this.clearFiller();
    const dispatchedAt = this.sched.now();
    this.fillerTimer = this.sched.setTimeout(() => {
      this.fillerTimer = null;
      if (this.disposed || this.registry.isStale(task)) return;
      // The model has spoken since we dispatched; it has already covered this.
      if (this.lastOutputAt >= dispatchedAt) return;
      this.deliver(task, {
        kind: 'commentary',
        text: queued
          ? 'Queued that behind what the agent is already doing.'
          : 'On it — this will take a moment.',
      });
    }, this.dispatchFillerMs);
  }

  private clearFiller(): void {
    if (this.fillerTimer != null) this.sched.clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
  }

  /**
   * A turn that runs for minutes must keep saying so — ALOUD.
   *
   * This was a `thinking` append, which is silent by definition, so a
   * three-minute agent turn was three minutes of dead air with a progress note
   * the user could not hear. Commentary is the channel that reaches the
   * speaker; the wording is deliberately an aside rather than an answer, so the
   * model paraphrases it as one.
   *
   * ONE TIMER FOR THE WHOLE SESSION, not one per task. With tasks overlapping,
   * per-task heartbeats would stack and narrate the same single running turn
   * several times over. It reports the BOUND task — the one actually on the
   * wire — names the tool it is running if we know it, and says how much is
   * waiting behind it. That backlog line is the only way a hands-free user can
   * tell "queued" from "ignored".
   */
  private armHeartbeat(): void {
    if (this.heartbeatTimer != null) return; // already ticking
    this.heartbeatTimer = this.sched.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.disposed) return;
      this.beat();
      // RE-ARM ONLY WHILE THERE IS A TURN TO NARRATE. This used to re-arm on a
      // non-empty pipeline, which is a different condition and a weaker one: a
      // task that is queued but not bound cannot produce a beat (`beat` needs a
      // bound, working task), so a pipeline holding nothing but queued work
      // rescheduled a no-op forever. `bindTurn` re-arms when a turn of ours
      // actually starts, which is the moment the heartbeat means something.
      if (this.bound) this.armHeartbeat();
    }, this.heartbeatMs);
  }

  private beat(): void {
    const task = this.bound;
    // `input_required` is NOT working: the agent is blocked on a question the
    // user has already been asked, aloud. Repeating "still working" over an
    // unanswered question reads as a session that isn't listening.
    if (!task || task.status !== 'working') return;
    if (this.registry.isStale(task)) return;
    const secs = Math.round((this.sched.now() - task.claimedAt) / 1000);
    const tool = this.lastTool ? `, currently running ${this.lastTool}` : '';
    const waiting = this.pipeline.length - 1;
    const behind =
      waiting > 0
        ? ` ${waiting} more ${waiting === 1 ? 'request is' : 'requests are'} queued behind it.`
        : '';
    task.intermediatesSent += 1;
    this.deliver(task, {
      kind: 'commentary',
      text: `Still working on it — ${secs} seconds in${tool}, no answer yet.${behind}`,
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer != null) this.sched.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ── The agent's wire ──────────────────────────────────────────────────────

  /**
   * Chat frames become appends against the task whose turn they belong to —
   * see the header for how that is decided.
   *
   * A turn the user started by TYPING owns none of our tasks, and its frames
   * are therefore dropped rather than narrated. That is what lets the two input
   * methods share a pane: the typed conversation renders on screen exactly as
   * it always did, and the voice session simply has nothing to say about it.
   */
  private onChatFrame(raw: unknown): void {
    if (this.disposed) return;

    // Tool names for the progress update. Read off the RAW frame and never
    // handed to the speak bridge: an events batch also carries the private
    // scratchpad, and the bridge's job is deciding what gets SPOKEN.
    const tool = latestToolName(raw);
    if (tool && this.bound) this.lastTool = tool;

    const frame = parseChatFrame(raw);
    if (!frame) return;

    // Bind BEFORE the bridge runs, so `turn-start`'s own intent lands against
    // the task that turn belongs to rather than the previous one.
    if (frame.t === 'turn-start') this.bindTurn(frame.text);
    if (frame.t === 'queued') this.noteQueued(frame.id, frame.text);
    if (frame.t === 'queue') this.reconcileQueue(frame.items ?? []);
    // The question is remembered whether or not it belongs to a task of OURS: a
    // turn the user TYPED can block the pane just as hard, and once it has, the
    // only thing that moves is an answer. Speaking one should work either way.
    if (frame.t === 'question') {
      this.pendingQuestion = { qid: frame.qid, questions: frame.questions };
      if (this.bound) this.registry.setStatus(this.bound.id, 'input_required');
    }
    if (frame.t === 'question-done') {
      if (this.pendingQuestion?.qid === frame.qid) this.pendingQuestion = null;
      if (this.bound?.status === 'input_required')
        this.registry.setStatus(this.bound.id, 'working');
    }

    const intents = this.bridge.onFrame(frame);
    this.turnRunning = this.bridge.isTurnRunning();

    const task = this.targetFor(frame);
    if (task) {
      // Pipecat's envelope: `started` (the dispatch ack), `intermediate`
      // (progress) and `final` (the result). Only a FINAL needs re-anchoring —
      // a progress update is itself part of the current beat of conversation,
      // and prefixing every heartbeat with "the conversation has moved on"
      // both wastes context and teaches the model that it always has.
      const final = isFinalFrame(frame);
      for (const intent of intents)
        this.deliver(task, intent, this.policyFor(frame, intent), final);
      // Deliver first, THEN retire — the ordering is load-bearing, and so is
      // the fact that a HELD delivery outlives the retirement (see
      // `registry.isFenced`): retiring is what makes a task stale, and a stale
      // task's appends are dropped.
      //
      // ONLY `turn-done` RETIRES THE RUNNING TURN. An `error` does not, even
      // though it is a final frame: see `targetFor`.
      if (frame.t === 'turn-done') {
        // BEFORE the retire, so the explanation is delivered against a task
        // that is still live — a stale task's appends are dropped, and this is
        // the one append that must never be.
        if (frame.ok) this.checkRunnerCanSpeak(task);
        this.retire(task, frame.ok ? 'completed' : 'failed');
      }
      if (frame.t === 'error' && task.status === 'queued') this.retire(task, 'failed');
    } else if (intents.length) {
      this.stats.staleDrops += intents.length;
      this.trace(`frame ${frame.t} dropped — belongs to no open task`);
    }
    this.recomputeState();
  }

  /**
   * Delivery policy per frame. Default is to wait for the floor.
   *
   * The two escalations are the things that are worthless late: the agent
   * BLOCKED on a question only the human can answer (it is not working, it is
   * waiting, and every second of delay is a second of nothing happening), and a
   * hard failure. Everything else — answers included — can wait the half second
   * it takes the user to finish their sentence.
   */
  private policyFor(frame: VoiceChatFrame, intent: AppendIntent): DeliveryPolicy {
    if (intent.kind === 'thinking') return 'silent';
    if (frame.t === 'question') return 'interrupt';
    if (frame.t === 'error') return 'interrupt';
    if (frame.t === 'turn-done' && !frame.ok) return 'interrupt';
    return 'when_idle';
  }

  /**
   * Which task does this frame speak for?
   *
   * `queued` is the odd one out and the only frame that legitimately describes
   * a turn that has not begun: it is the server telling us OUR send was parked,
   * and it names the send, so it resolves to that request rather than to
   * whatever is running. Everything else belongs to the bound turn.
   *
   * ═══ AN `error` IS ABOUT A REJECTED SEND, NOT ABOUT THE RUNNING TURN ═══
   *
   * The server emits `{t:'error'}` on the SENDING socket for every send it
   * refuses — the queue cap, a runner whose respawns gave up, a read-only
   * pane — and that rejection can land while a turn of ours is running
   * perfectly well. Attributing it to the bound turn (which is what "everything
   * else belongs to the bound turn" used to do) failed the live task, threw
   * away the answer it was about to produce, and left the REJECTED request
   * sitting in the pipeline as `queued` forever: exactly backwards on both
   * counts.
   *
   * So an error resolves to our oldest UNDISPATCHED request — the only kind of
   * task a rejection can be about — whether or not something is bound. The one
   * `error` that really is about the running turn is the agent dying, and that
   * path broadcasts its own `turn-done` a beat later, which retires it
   * properly. Falling back to the bound task when we have nothing queued keeps
   * the failure audible without retiring anything (see `onChatFrame`).
   */
  private targetFor(frame: VoiceChatFrame): VoiceTask | undefined {
    if (frame.t === 'queued') return this.matchPending(frame.text);
    if (frame.t === 'error') {
      return this.pipeline.find((x) => x.status === 'queued') ?? this.bound ?? undefined;
    }
    return this.bound ?? undefined;
  }

  /**
   * A turn started. Decide whether it is ours, and if so, whose.
   *
   * Only ever binds when nothing is bound: a mid-turn reconnect re-broadcasts
   * `turn-start` for a turn that is already running, and re-binding there would
   * hand the running turn to the NEXT queued request — which would then be
   * closed by a `turn-done` it never earned.
   */
  private bindTurn(text?: string): void {
    const stamped = typeof text === 'string' && text.trim().length > 0;
    // Latch BEFORE the early returns: a stamped turn-start proves the server
    // stamps even when it belongs to somebody else entirely (the user typing
    // into the same pane), and that proof is what the latch is for.
    if (stamped) this.serverStampsTurns = true;
    if (this.bound) return;
    const waiting = this.pipeline.filter((d) => d.status === 'queued');
    if (waiting.length === 0) return;
    let owner: VoiceTask | undefined;
    if (stamped) {
      // Exact text match, oldest first — the server stamped the turn, so a
      // non-match is PROOF the turn is someone else's, not a reason to guess.
      const t = (text as string).trim();
      owner = waiting.find((d) => d.request.trim() === t);
      if (!owner) {
        this.trace('turn-start belongs to another sender — not binding');
        return;
      }
    } else if (this.serverStampsTurns) {
      // This server stamps, and this turn arrived without one. It is a
      // mid-turn runner reconnect re-announcing a turn that is ALREADY
      // running — for whoever started it, which is a question the server can no
      // longer answer. Guessing here re-binds a live turn to the next queued
      // request, which is then closed by a `turn-done` it never earned.
      this.trace('unstamped turn-start from a stamping server — not binding');
      return;
    } else {
      // Unstamped (older server): fall back to submit order, which is the order
      // the server runs them in.
      owner = waiting[0];
    }
    if (!owner) return;
    this.registry.setStatus(owner.id, 'working');
    owner.queueId = null;
    this.clearOrphanTimer(owner.id);
    this.bound = owner;
    this.lastTool = null;
    this.trace(`bound turn to ${owner.id}`);
    // A task that waited its turn starts in total silence otherwise, and with
    // two answers coming the user has no way to tell which is which.
    if (owner.wasQueued) {
      this.deliver(owner, {
        kind: 'commentary',
        text: `Starting the next one now: ${owner.request.slice(0, 120)}`,
      });
    }
    this.emitNow(owner, { kind: 'thinking', text: this.describePipeline() });
    // A task that sat behind someone else's turn stopped the heartbeat when
    // the last tick found nothing bound; its own turn starting is what makes
    // the heartbeat meaningful again.
    this.armHeartbeat();
  }

  /** The server parked one of our sends. Remember its queue row id so an
   *  explicit cancel can drop it before it ever runs. */
  private noteQueued(id: string, text: string): void {
    const d = this.matchPending(text);
    if (!d) return;
    d.queueId = id;
    // A NEW row for a task we had already written off. `editQueued` in the chat
    // UI is a `queue-cancel` plus a fresh send, so an unchanged edit re-parks
    // the same request under a new row id — and the pending orphan check would
    // then retire work that is very much alive.
    this.clearOrphanTimer(d.id);
  }

  /**
   * The pane's pending queue changed. Notice anything of OURS that vanished
   * from it without ever running.
   *
   * THE HOLE THIS CLOSES. A `queue-cancel` from the chat UI — the × on a
   * pending bubble, and `editQueued`, which is a cancel plus a re-send — drops
   * the row and rebroadcasts the queue. Nothing else is sent: no `turn-start`
   * will ever name that request and no `turn-done` will ever close it. The
   * task therefore sat in our pipeline as `queued` forever — re-arming the
   * heartbeat, inflating the running-work snapshot we push to the model, and
   * available to be mis-bound by a later turn.
   *
   * Only tasks we KNOW were parked (they have a queue row id) are considered;
   * a send that went out on the idle fast path never appears in this list at
   * all, and treating its absence as a cancellation would retire every task we
   * ever dispatched.
   */
  private reconcileQueue(items: ReadonlyArray<{ id: string }>): void {
    const live = new Set(items.map((i) => i.id));
    for (const task of this.pipeline) {
      if (task.status !== 'queued' || !task.queueId) continue;
      if (live.has(task.queueId)) {
        // Still parked. If we had written it off, we were wrong — a row can
        // reappear in the list after a reconnect resync.
        this.clearOrphanTimer(task.id);
        continue;
      }
      if (this.orphanTimers.has(task.id)) continue;
      const id = task.id;
      this.orphanTimers.set(
        id,
        this.sched.setTimeout(() => {
          this.orphanTimers.delete(id);
          this.settleOrphan(task);
        }, QUEUE_DROP_GRACE_MS),
      );
    }
  }

  /** The grace window is up. If the task still hasn't started, its row was
   *  dropped rather than drained — say so and release the slot. */
  private settleOrphan(task: VoiceTask): void {
    if (this.disposed) return;
    if (!this.pipeline.some((d) => d.id === task.id)) return;
    // It started (or finished) after all — the disappearance was a drain.
    if (task.status !== 'queued') return;
    this.trace(`task ${task.id} dropped from the server queue — cancelled elsewhere`);
    this.deliver(task, {
      kind: 'commentary',
      text: `That request was cancelled before it ran: ${task.request.slice(0, 120)}`,
    });
    this.retire(task, 'cancelled');
  }

  private clearOrphanTimer(id: string): void {
    const h = this.orphanTimers.get(id);
    if (h != null) this.sched.clearTimeout(h);
    this.orphanTimers.delete(id);
  }

  private clearOrphanTimers(): void {
    for (const h of this.orphanTimers.values()) this.sched.clearTimeout(h);
    this.orphanTimers.clear();
  }

  private matchPending(text: string): VoiceTask | undefined {
    const t = (text ?? '').trim();
    return this.pipeline.find((d) => d.status === 'queued' && d.request.trim() === t);
  }

  /** This task's work is over. Status first so diagnostics can tell "answered"
   *  from "cancelled", then release its slot in the pipeline. */
  private retire(task: VoiceTask, status: 'completed' | 'failed' | 'cancelled'): void {
    this.registry.setStatus(task.id, status);
    this.pipeline = this.pipeline.filter((d) => d.id !== task.id);
    this.clearOrphanTimer(task.id);
    if (this.bound?.id === task.id) this.bound = null;
    this.lastTool = null;
    if (this.pipeline.length === 0) this.clearHeartbeat();
  }

  /**
   * A turn of OURS just succeeded. Did it produce an answer anyone could hear?
   *
   * If it did not, AND nothing on this session ever has, this pane has no
   * `reply` tool and never will — see {@link MUTE_RUNNER_GRACE_MS} for the two
   * ways that happens. Every future request would end exactly the same way, so
   * there is nothing to wait for and nothing to retry: say what is wrong, say
   * where the answer actually is, and stop the meter.
   *
   * THE THREE GUARDS ARE THE WHOLE PRECISION OF THIS.
   *
   *   `frame.ok` (checked by the caller) — a failed turn is announced by the
   *     bridge already, and its silence is explained.
   *   `task` (the caller only reaches here with one) — a turn the user TYPED is
   *     not one they are waiting to hear, and plenty of those are legitimately
   *     quiet.
   *   `bridge.canSpeak` — a lifetime latch. One reply proves the capability, and
   *     after that a quiet turn is just a quiet turn. Without this, an agent
   *     that answered ten times and then finished a turn without calling
   *     `reply` would hang the user's call up for no reason.
   *
   * A cancelled task is excluded for the same reason as a failed turn: it was
   * silent because the user silenced it.
   */
  private checkRunnerCanSpeak(task: VoiceTask): void {
    if (this.muteRunnerDeclared || this.bridge.canSpeak) return;
    if (task.status === 'cancelled') return;
    this.muteRunnerDeclared = true;
    this.trace('turn succeeded with no reply frame — this pane cannot answer aloud; ending');
    // 'interrupt', because there is nothing worth waiting for the floor for:
    // the session is about to end and this is the last thing it will ever say.
    this.deliver(task, { kind: 'commentary', text: MUTE_RUNNER_LINE }, 'interrupt', true);
    this.muteRunnerTimer = this.sched.setTimeout(() => {
      this.muteRunnerTimer = null;
      this.dispose(MUTE_RUNNER_DETAIL);
    }, MUTE_RUNNER_GRACE_MS);
  }

  // ── Cancelling, which is the ONLY thing that stops the agent ───────────────

  /**
   * The user said something. Decide — after the sentence has finished — whether
   * it was an instruction to abandon the running work.
   *
   * THIS IS A BACKSTOP, NOT THE MAIN PATH. The main path is the model: it hears
   * "stop", delegates it, and `settle` routes it to `cancel` (see the arrival
   * policy there). But the model is also told to handle conversational asides
   * itself, and a bare "stop" reads like one — so if the only cancel route were
   * a delegation, cancelling would sometimes be unreachable, which is worse than
   * this being here.
   *
   * THE DEBOUNCE IS THE POINT. Judging deltas as they arrive cancels on the word
   * "stop" in "stop the dev server", which is a task. So the probe re-arms on
   * every delta of the same utterance and only rules once the user has gone
   * quiet. The mic gate guards it as well — a degenerate blip and the model's
   * own voice coming back through the microphone are both refused — because
   * this is the only path that can throw work away. What the gate does NOT do
   * any more is refuse a cancel for being short or for being spoken over the
   * model, which are the two things it was refusing most; see mic-gate.ts.
   */
  private armCancelProbe(seg: Utterance): void {
    this.lastInputDeltaAt = this.sched.now();
    if (this.cancelProbeTimer != null) this.sched.clearTimeout(this.cancelProbeTimer);
    this.cancelProbeTimer = this.sched.setTimeout(() => {
      this.cancelProbeTimer = null;
      this.judgeForCancel(seg);
    }, this.cancelProbeQuietMs);
    // The user talking is what holds the floor, so their falling silent is what
    // releases it. Poll rather than wait for an event that may never come.
    this.armFloorPoll();
  }

  private judgeForCancel(seg: Utterance): void {
    if (this.disposed || this.judged.has(seg)) return;
    // Nothing of ours to abandon and nothing running: this is just talking, and
    // talking is free.
    if (!this.turnRunning && this.pipeline.length === 0) return;
    if (arrivalPolicyFor(seg.text) !== 'interrupt') {
      this.trace('utterance is not a cancel — agent keeps working');
      return;
    }
    // The gate is told what cancel.ts just concluded, and handed the model's
    // own recent speech. Both change which question it asks: this utterance is
    // the ONE the backstop exists for, and a bare "stop" over the model's voice
    // is short and inside the echo window by construction — so judging it on
    // length and timing alone declined it in exactly the two situations anyone
    // actually cancels in. See mic-gate.ts.
    const verdict = this.gate.judge(
      { startMs: seg.startMs, endMs: seg.endMs, text: seg.text },
      { cancelShaped: true, recentOutput: this.recentModelSpeech(seg.startMs) },
    );
    if (verdict !== 'accept') {
      this.trace(`cancel ignored (${verdict})`);
      return;
    }
    this.judged.add(seg);
    this.cancel(this.bound ?? this.registry.active(), 'spoken');
  }

  /**
   * What the model said in the moments before `atMs`, for the echo test.
   *
   * Deliberately narrow: an echo comes back within a beat or not at all, and a
   * longer memory starts refusing genuine cancels on the grounds that the model
   * used the word "stop" a minute ago.
   */
  private recentModelSpeech(atMs: number): string {
    return this.buf
      .segments('output')
      .filter((s) => s.endMs >= atMs - ECHO_LOOKBACK_MS && s.startMs <= atMs + 1)
      .map((s) => s.text)
      .join(' ');
  }

  /**
   * Abandon everything in flight.
   *
   * Three things have to happen and all three matter: the RUNNING turn is asked
   * to stop, the sends still sitting in the server's queue are dropped (or the
   * backlog runs on regardless, which is not what anyone means by "stop"), and
   * the fence bumps so the tail of the dying turn is never spoken.
   *
   * COOPERATIVE, and the fence is why that is survivable. `{t:'stop'}` is a
   * request; the turn may still emit a final reply on its way out. We cannot
   * un-run it, so we refuse to speak it.
   *
   * `speakUnder` is the task the confirmation goes out on — appends need a task
   * id, and a cancel with no audible acknowledgement is a cancel the user cannot
   * tell landed.
   */
  private cancel(speakUnder: VoiceTask | undefined, source: 'spoken' | 'delegated'): void {
    const now = this.sched.now();
    const repeat = now - this.lastCancelAt < CANCEL_DEBOUNCE_MS;
    this.lastCancelAt = now;
    if (repeat) {
      // The same cancel arriving by the other door. Close the task that carried
      // it and say nothing more.
      if (speakUnder) this.registry.setStatus(speakUnder.id, 'cancelled');
      this.trace(`cancel (${source}) suppressed — already cancelled`);
      return;
    }

    // Interrupt: a cancel confirmation is worthless late, and the user who just
    // said "stop" is by definition not mid-sentence.
    if (speakUnder && !this.registry.isStale(speakUnder)) {
      this.emitNow(speakUnder, {
        kind: 'commentary',
        text: 'Stopped. The agent has been interrupted, and nothing is queued behind it.',
      });
    }

    if (this.turnRunning) this.agent.stop();
    for (const d of this.pipeline) {
      if (d.queueId && this.agent.cancelQueued) this.agent.cancelQueued(d.queueId);
    }
    for (const d of this.pipeline) this.registry.setStatus(d.id, 'cancelled');
    if (speakUnder) this.registry.setStatus(speakUnder.id, 'cancelled');
    this.pipeline = [];
    this.bound = null;
    this.lastTool = null;
    // Anything still held for delivery belonged to work that no longer exists.
    this.pending.clear();
    // Everything claimed before now is abandoned; a late reply from the dying
    // turn finds itself behind the fence and is never spoken.
    this.registry.bumpRevision();
    this.bridge.reset();
    this.clearSettle();
    this.clearHeartbeat();
    this.clearFiller();
    this.clearOrphanTimers();
    this.turnRunning = false;
    this.stats.cancels += 1;
    this.trace(`cancelled (${source})`);
    this.recomputeState();
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Hand an append to the model, honouring the delivery policy.
   *
   * `silent` (thinking) goes immediately — it cannot interrupt anyone, and
   * holding it would leave the model answering from a stale picture of the
   * world, which is worse than any interruption. `interrupt` goes immediately
   * because it is worthless late. `when_idle` — the default, and everything
   * that is an ANSWER — waits for the user to stop talking.
   */
  private deliver(
    task: VoiceTask,
    intent: AppendIntent,
    policy?: DeliveryPolicy,
    final = false,
  ): void {
    const p: DeliveryPolicy = policy ?? (intent.kind === 'thinking' ? 'silent' : 'when_idle');
    if (p !== 'when_idle') {
      this.emitNow(task, intent, final);
      return;
    }
    this.pending.push({ item: task, intent, policy: p, queuedAt: this.sched.now(), final });
    this.flushFloor();
  }

  /**
   * Release everything the floor is now free for, oldest first.
   *
   * `wasHeld` is what stops the floor from turning a delay into a deletion.
   * These appends were accepted while their task was live; by the time the
   * floor frees up the task has routinely been retired — by the very
   * `turn-done` that produced the append, or by the `setStatus(…, 'failed')`
   * that follows a settle failure two lines later. Re-testing full staleness
   * here would drop exactly those, which is how "the agent's turn failed",
   * "I didn't catch that — can you say it again?" and "I can't reach the chat
   * right now" all became dead air. The FENCE still applies, and an explicit
   * cancel clears this queue outright, so an abandoned task still says nothing.
   */
  private flushFloor(): void {
    if (this.disposed) return;
    const ready = this.pending.release(this.sched.now(), this.lastInputDeltaAt, this.idleQuietMs);
    for (const held of ready) this.emitNow(held.item, held.intent, held.final, true);
    if (this.pending.size > 0) {
      this.stats.deliveriesHeld += 1;
      this.armFloorPoll();
    }
  }

  private armFloorPoll(): void {
    if (this.floorTimer != null || this.pending.size === 0) return;
    this.floorTimer = this.sched.setTimeout(() => {
      this.floorTimer = null;
      this.flushFloor();
    }, FLOOR_POLL_MS);
  }

  /**
   * The one exit to the model. Checks the fence, re-anchors a late result,
   * stamps the task id, splits to the 500-token cap, and queues if the session
   * hasn't started.
   */
  private emitNow(task: VoiceTask, intent: AppendIntent, final = false, wasHeld = false): void {
    // A held append was already judged deliverable when it was queued; the only
    // thing that may retract it afterwards is the fence. See `flushFloor`.
    if (wasHeld ? this.registry.isFenced(task) : this.registry.isStale(task)) {
      this.stats.staleDrops += 1;
      this.trace(`append dropped — stale (${task.id})`);
      return;
    }
    // A RESULT arriving into a conversation that has moved on needs a frame, or
    // the model blurts it as a non-sequitur. Protocol bookkeeping does NOT
    // count as movement — see delivery.ts.
    if (
      final &&
      intent.kind === 'commentary' &&
      task.dispatchedAt > 0 &&
      conversationMovedOn({
        dispatchedAt: task.dispatchedAt,
        intermediatesSent: task.intermediatesSent,
        lastInputDeltaAt: this.lastInputDeltaAt,
        lastOutputAt: this.lastOutputAt,
      })
    ) {
      this.stats.reanchored += 1;
      this.write(task, 'thinking', reanchorInstruction(task.request));
    }
    this.write(task, intent.kind, intent.text);
  }

  private write(task: VoiceTask, kind: 'thinking' | 'commentary', text: string): void {
    const type = kind === 'thinking' ? 'session.thinking.append' : 'session.commentary.append';
    for (const content of chunkForAppend(text)) {
      // `content`, NOT `text` — see protocol.ts. `event_id` is ours to choose
      // and comes back on any `error` as `client_event_id`, which is the only
      // way to name the append that was refused.
      const ev = {
        type,
        event_id: `mux_${++this.eventSeq}`,
        delegation_id: task.id,
        content,
      } as OutboundEvent;
      if (!this.started) this.outbound.push(ev);
      else {
        this.t.send(ev);
        this.stats.appendsSent += 1;
      }
    }
  }

  private flushOutbound(): void {
    const queued = this.outbound;
    this.outbound = [];
    for (const ev of queued) {
      this.t.send(ev);
      this.stats.appendsSent += 1;
    }
  }

  // ── UI state ──────────────────────────────────────────────────────────────

  private armSpeakingDecay(): void {
    if (this.speakingTimer != null) this.sched.clearTimeout(this.speakingTimer);
    this.speakingTimer = this.sched.setTimeout(() => {
      this.speakingTimer = null;
      this.recomputeState();
    }, SPEAKING_DECAY_MS);
  }

  private recomputeState(): void {
    if (this.disposed || this.uiState === 'error' || this.uiState === 'ended') return;
    if (!this.started) {
      this.setState('connecting');
      return;
    }
    const speaking = this.sched.now() - this.lastOutputAt < SPEAKING_DECAY_MS;
    if (speaking) {
      this.setState('speaking');
      return;
    }
    this.setState(this.turnRunning ? 'thinking' : 'listening');
  }

  private setState(s: VoiceUiState, detail?: string): void {
    if (this.uiState === s) return;
    this.uiState = s;
    this.onStateCb(s, detail);
  }

  private onTransportState(s: TransportState, detail?: string): void {
    if (this.disposed) return;
    if (s === 'failed') {
      this.uiState = 'error';
      this.onStateCb('error', detail ?? 'The voice connection failed.');
      return;
    }
    if (s === 'closed') {
      this.uiState = 'ended';
      this.onStateCb('ended', detail);
      return;
    }
    this.recomputeState();
  }

  /**
   * Terminal. Every timer cleared, every subscription dropped, the fence bumped
   * so anything that somehow survives finds itself stale.
   *
   * NOTHING IS STOPPED. Hanging up the phone must not kill the agent: a turn the
   * user asked for keeps running and lands in the chat pane, where they can read
   * it. Ending a voice call is not cancelling the work.
   */
  dispose(reason?: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSettle();
    this.clearHeartbeat();
    this.clearFiller();
    this.clearOrphanTimers();
    if (this.cancelProbeTimer != null) this.sched.clearTimeout(this.cancelProbeTimer);
    this.cancelProbeTimer = null;
    if (this.floorTimer != null) this.sched.clearTimeout(this.floorTimer);
    this.floorTimer = null;
    if (this.speakingTimer != null) this.sched.clearTimeout(this.speakingTimer);
    this.speakingTimer = null;
    if (this.muteRunnerTimer != null) this.sched.clearTimeout(this.muteRunnerTimer);
    this.muteRunnerTimer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.pipeline = [];
    this.bound = null;
    this.pendingQuestion = null;
    this.pending.clear();
    this.registry.reset();
    this.bridge.reset();
    this.buf.reset();
    this.uiState = 'ended';
    this.onStateCb('ended', reason);
  }
}
