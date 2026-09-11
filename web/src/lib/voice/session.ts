// THE DELEGATION LOOP.
//
// Everything else in this folder is a part; this is the machine. It owns one
// live conversation: transcript in, delegations claimed, requests dispatched to
// the Chat pane over the socket that already exists, results narrated back as
// appends.
//
// ═══ THE ONE IDEA THAT SHAPES ALL OF IT ═══
//
// AN AGENT TURN TAKES MINUTES. A VOICE MODEL WILL NOT WAIT.
//
// So there is no point in the code where a delegation is "handled" — no
// await that spans the work, no promise resolved with an answer. A delegation
// is ACKNOWLEDGED in milliseconds with a silent `thinking` append (which is
// what lets the model say "on it" in its own words), the request goes out on
// the chat socket, and then results arrive over the following minutes as
// `commentary` appends against the same delegation id. Multiple appends per
// delegation are explicitly supported; that support IS the feature.
//
// ═══ THE FOUR THINGS THAT GO WRONG, AND WHERE EACH IS HANDLED ═══
//
//   DUPLICATE DELEGATION. Delivery is not exactly-once. Claimed in
//     delegation.ts before any work starts; a second delivery of an id we have
//     ever seen returns null and we do nothing at all.
//   NO TASK TEXT. `session.delegation.created` is metadata. The utterance is
//     rebuilt from transcript deltas by transcript.ts, joined on `offset_ms`.
//   THE SENTENCE ISN'T FINISHED YET. The delegation can and does beat the
//     transcript. Hence the SETTLE WINDOW below: hold briefly for quiet, then
//     take what we have. Bounded, because the alternative to a slightly
//     truncated request is no request.
//   THE USER MOVED ON. Revisions. Every deferred path re-checks staleness
//     before it acts, and a superseded delegation's results are dropped rather
//     than spoken over a conversation that has changed topic.
//
// ═══ WHAT IS NOT HERE ═══
//
// No DOM, no WebRTC, no fetch, no real timers. The transport, the agent link
// and the clock are all injected, which is what lets a full session — connect,
// speak, delegate, narrate, interrupt — run in a unit test against a fake data
// channel.

import { chunkForAppend } from './chunk';
import { type DelegationContext, DelegationRegistry } from './delegation';
import { MicGate } from './mic-gate';
import type { AppendIntent, InboundEvent, OutboundEvent } from './protocol';
import { channelOf, isDelegationCreated, isTranscriptDelta } from './protocol';
import { SpeakBridge, parseChatFrame } from './speak-bridge';
import { TranscriptBuffer, type Utterance, reconstructRequest } from './transcript';
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
  /** Fire a `{t:'stop'}`. The existing hook — it writes a durable interrupted
   *  notice, which is exactly what a barge-in should leave behind. */
  stop(): void;
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
/** Never hold a delegation longer than this before dispatching what we have.
 *  A trailing subordinate clause is a smaller loss than a dead-air pause. */
export const SETTLE_MAX_MS = 2500;
/** Cadence of "still working" thinking appends during a long turn. */
export const HEARTBEAT_MS = 25_000;
/** Silence on the output transcript after which we stop calling it speaking. */
export const SPEAKING_DECAY_MS = 900;

export interface VoiceSessionOpts {
  transport: VoiceTransport;
  agent: AgentLink;
  onState: (s: VoiceUiState, detail?: string) => void;
  scheduler?: Scheduler;
  micGate?: MicGate;
  settleQuietMs?: number;
  settleMaxMs?: number;
  heartbeatMs?: number;
  /** Include the model's last line as context in the dispatched request. */
  withContext?: boolean;
  /** Diagnostics, off by default. */
  onTrace?: (line: string) => void;
}

/** Counters worth asserting on in tests and worth showing in a debug panel.
 *  Every one of them is a bug class that is otherwise invisible. */
export interface VoiceSessionStats {
  delegationsClaimed: number;
  duplicatesRefused: number;
  staleDrops: number;
  appendsSent: number;
  requestsDispatched: number;
  bargeIns: number;
}

export class VoiceSession {
  private readonly t: VoiceTransport;
  private readonly agent: AgentLink;
  private readonly sched: Scheduler;
  private readonly gate: MicGate;
  private readonly buf = new TranscriptBuffer();
  private readonly registry = new DelegationRegistry();
  private readonly bridge = new SpeakBridge();
  private readonly onStateCb: (s: VoiceUiState, detail?: string) => void;
  private readonly settleQuietMs: number;
  private readonly settleMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly withContext: boolean;
  private readonly trace: (line: string) => void;

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
  private speakingTimer: number | null = null;
  private settleTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastInputDeltaAt = 0;
  /**
   * Which delegation owns the agent turn currently on the wire.
   *
   * Chat frames carry NO delegation id — they are a flat per-pane stream — so
   * "the newest open delegation" is not enough to attribute a `speak` to. The
   * counter-example that forced this: delegation A dispatches and its turn
   * starts; the user changes their mind; B supersedes A and we `{t:'stop'}`
   * A's turn. A's turn takes a moment to die and emits its final reply — which
   * "attribute to whatever is active" would speak as if it were B's answer,
   * i.e. confidently answer the question the user just withdrew, with the
   * answer to a different one.
   *
   * So a delegation adopts exactly ONE turn: the first `turn-start` after its
   * own dispatch. Until that arrives it is `awaiting` and admits nothing; after
   * its turn ends the binding is dropped. Frames belonging to any other turn —
   * the superseded one, or one the user started by typing — have no owner and
   * are dropped.
   */
  private turnBinding: { ctxId: string; state: 'awaiting' | 'bound' } | null = null;
  /** Utterances already counted as a barge-in, so one interruption sends one
   *  `{t:'stop'}` rather than one per delta. */
  private barged = new WeakSet<Utterance>();

  readonly stats: VoiceSessionStats = {
    delegationsClaimed: 0,
    duplicatesRefused: 0,
    staleDrops: 0,
    appendsSent: 0,
    requestsDispatched: 0,
    bargeIns: 0,
  };

  constructor(opts: VoiceSessionOpts) {
    this.t = opts.transport;
    this.agent = opts.agent;
    this.sched = opts.scheduler ?? realScheduler;
    this.gate = opts.micGate ?? new MicGate();
    this.onStateCb = opts.onState;
    this.settleQuietMs = opts.settleQuietMs ?? SETTLE_QUIET_MS;
    this.settleMaxMs = opts.settleMaxMs ?? SETTLE_MAX_MS;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.withContext = opts.withContext ?? true;
    this.trace = opts.onTrace ?? (() => {});
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
        this.lastInputDeltaAt = this.sched.now();
        this.maybeBargeIn(seg);
      }
      this.recomputeState();
      return;
    }
    if (isDelegationCreated(e)) {
      this.onDelegation(e.delegation.id, e.delegation.target, e.offset_ms);
    }
  }

  /**
   * A delegation arrived. Claim it or drop it — there is no third option, and
   * in particular there is no "handle it anyway, probably fine".
   */
  private onDelegation(id: string, target: string, offsetMs: number): void {
    if (target !== 'client') {
      this.trace(`delegation ${id} not for us (${target})`);
      return;
    }
    // Check BEFORE bumping. Bumping on a duplicate would invalidate the
    // ORIGINAL claim's revision and silently discard the results of work that
    // is already correctly under way — a duplicate delivery must be inert.
    if (this.registry.hasSeen(id)) {
      this.stats.duplicatesRefused += 1;
      this.trace(`delegation ${id} duplicate — refused`);
      return;
    }

    // A genuinely new task supersedes whatever was in flight.
    const prior = this.registry.active();
    this.registry.bumpRevision();
    const ctx = this.registry.claim(id, { now: this.sched.now(), offsetMs });
    if (!ctx) return; // unreachable given hasSeen above; cheap to be sure
    this.stats.delegationsClaimed += 1;

    if (prior) {
      this.registry.finish(prior.id);
      if (this.turnRunning) this.agent.stop();
    }
    this.bridge.reset();
    this.clearSettle();
    this.clearHeartbeat();
    // The new task owns no turn yet — in particular it does NOT inherit the
    // one we just stopped.
    this.turnBinding = null;

    // Acknowledge NOW. Silent, because the model narrates in its own voice;
    // this only tells it that work exists so it stops waiting on us.
    this.emit(ctx, { kind: 'thinking', text: 'Picking this up — passing it to the agent now.' });
    this.scheduleSettle(ctx);
  }

  // ── The settle window ─────────────────────────────────────────────────────

  private scheduleSettle(ctx: DelegationContext): void {
    this.clearSettle();
    this.settleTimer = this.sched.setTimeout(() => {
      this.settleTimer = null;
      this.settle(ctx);
    }, this.settleQuietMs);
  }

  /**
   * Decide what was actually asked, and send it.
   *
   * Re-checks staleness first — the canonical check, and the reason a user who
   * changes their mind inside the settle window never has the abandoned
   * request dispatched at all.
   */
  private settle(ctx: DelegationContext): void {
    if (this.disposed) return;
    if (this.registry.isStale(ctx)) {
      this.stats.staleDrops += 1;
      this.trace(`settle ${ctx.id} dropped — stale`);
      return;
    }
    const elapsed = this.sched.now() - ctx.claimedAt;
    const quietFor = this.sched.now() - this.lastInputDeltaAt;
    const r = reconstructRequest(this.buf, {
      offsetMs: ctx.offsetMs,
      withContext: this.withContext,
    });
    // Still mid-sentence and still within budget → give the transcript another
    // beat. `quietFor` is what stops this looping on a user who never uses
    // punctuation: once they stop talking we take what we have regardless.
    const worthWaiting = !r.complete && quietFor < this.settleQuietMs;
    if (worthWaiting && elapsed < this.settleMaxMs) {
      this.scheduleSettle(ctx);
      return;
    }
    if (!r.text) {
      this.emit(ctx, {
        kind: 'commentary',
        text: 'I didn’t catch that — can you say it again?',
      });
      this.registry.finish(ctx.id);
      return;
    }
    if (!this.agent.send(r.text)) {
      this.emit(ctx, {
        kind: 'commentary',
        text: 'I can’t reach the chat right now — the connection dropped.',
      });
      this.registry.finish(ctx.id);
      return;
    }
    this.stats.requestsDispatched += 1;
    // From here, the next `turn-start` on the chat socket is OURS.
    this.turnBinding = { ctxId: ctx.id, state: 'awaiting' };
    this.trace(`dispatched ${ctx.id}: ${r.text.slice(0, 80)}`);
    this.emit(ctx, { kind: 'thinking', text: `Asked the agent: ${r.text}` });
    this.armHeartbeat(ctx);
  }

  private clearSettle(): void {
    if (this.settleTimer != null) this.sched.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  // ── Long work ─────────────────────────────────────────────────────────────

  /** A turn that runs for minutes must keep saying so, or the model concludes
   *  the client died and moves the conversation on without us. */
  private armHeartbeat(ctx: DelegationContext): void {
    this.clearHeartbeat();
    this.heartbeatTimer = this.sched.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.disposed || this.registry.isStale(ctx)) return;
      const secs = Math.round((this.sched.now() - ctx.claimedAt) / 1000);
      this.emit(ctx, {
        kind: 'thinking',
        text: `Still working — ${secs}s so far, no answer yet.`,
      });
      this.armHeartbeat(ctx);
    }, this.heartbeatMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer != null) this.sched.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ── The agent's wire ──────────────────────────────────────────────────────

  /**
   * Chat frames become appends against the ACTIVE delegation.
   *
   * A turn the user started by TYPING has no delegation to attach to, and its
   * frames are therefore dropped rather than narrated — appends require a
   * delegation_id, and inventing one to speak text nobody asked the voice
   * session about would be both invalid and rude.
   */
  private onChatFrame(raw: unknown): void {
    if (this.disposed) return;
    const frame = parseChatFrame(raw);
    if (!frame) return;
    const intents = this.bridge.onFrame(frame);
    this.turnRunning = this.bridge.isTurnRunning();

    const ctx = this.registry.active();
    const binding = ctx && this.turnBinding?.ctxId === ctx.id ? this.turnBinding : null;
    // The first turn-start after our own dispatch is the turn we asked for.
    if (frame.t === 'turn-start' && binding?.state === 'awaiting') binding.state = 'bound';
    const bound = binding?.state === 'bound';
    // `queued` is the server telling us OUR send is parked behind a busy
    // agent, so it is admissible before any turn-start — it is the only frame
    // that legitimately describes a turn that has not begun.
    const admissible = !!ctx && (bound || frame.t === 'queued');

    if (admissible && ctx) {
      for (const intent of intents) this.emit(ctx, intent);
      if (bound && (frame.t === 'turn-done' || frame.t === 'error')) {
        // Emit first, THEN finish: finishing makes the context stale, which is
        // precisely what would swallow the final answer.
        this.clearHeartbeat();
        this.turnBinding = null;
        this.registry.finish(ctx.id);
      }
    } else if (intents.length) {
      this.stats.staleDrops += intents.length;
      this.trace(`frame ${frame.t} dropped — belongs to no open delegation`);
    }
    this.recomputeState();
  }

  // ── Barge-in ──────────────────────────────────────────────────────────────

  /**
   * There is no barge-in event and nothing to flush: the model handles its own
   * turn-taking, and the audio is already on the peer connection. The only
   * thing WE owe a barge-in is stopping the agent, because a turn the user has
   * talked over is work nobody is waiting for.
   *
   * Gated hard. `{t:'stop'}` throws away minutes of real work and writes a
   * durable interrupted notice, so it must not fire on a cough, and it must
   * not fire on the model's own echo coming back through the microphone.
   */
  private maybeBargeIn(seg: Utterance): void {
    if (!this.turnRunning || this.barged.has(seg)) return;
    const verdict = this.gate.judge({
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text,
    });
    if (verdict !== 'accept') {
      this.trace(`input ignored (${verdict})`);
      return;
    }
    this.barged.add(seg);
    this.stats.bargeIns += 1;
    this.agent.stop();
    const ctx = this.registry.active();
    if (ctx) this.registry.finish(ctx.id);
    // The conversation has moved: anything still in flight is now stale.
    this.registry.bumpRevision();
    this.clearHeartbeat();
    this.turnRunning = false;
    this.trace('barge-in — stopped the agent turn');
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * The one exit to the model. Checks staleness, stamps the delegation id,
   * splits to the 500-token cap, and queues if the session hasn't started.
   */
  private emit(ctx: DelegationContext, intent: AppendIntent): void {
    if (this.registry.isStale(ctx)) {
      this.stats.staleDrops += 1;
      this.trace(`append dropped — stale (${ctx.id})`);
      return;
    }
    const type =
      intent.kind === 'thinking' ? 'session.thinking.append' : 'session.commentary.append';
    for (const text of chunkForAppend(intent.text)) {
      const ev = { type, delegation_id: ctx.id, text } as OutboundEvent;
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

  /** Terminal. Every timer cleared, every subscription dropped, the registry
   *  bumped so anything that somehow survives finds itself stale. */
  dispose(reason?: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSettle();
    this.clearHeartbeat();
    if (this.speakingTimer != null) this.sched.clearTimeout(this.speakingTimer);
    this.speakingTimer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.registry.reset();
    this.bridge.reset();
    this.buf.reset();
    this.uiState = 'ended';
    this.onStateCb('ended', reason);
  }
}
