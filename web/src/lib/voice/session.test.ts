// A FULL VOICE SESSION, DRIVEN FROM A FAKE DATA CHANNEL.
//
// This is the payoff for the transport seam. Everything below — connect,
// transcribe, delegate, dispatch, narrate, interrupt, supersede — is the real
// VoiceSession running its real logic, with a fake in place of WebRTC, a fake
// in place of the chat socket, and a hand-cranked clock in place of timers. No
// browser, no model, no API key, no money.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from './chunk';
import { MicGate } from './mic-gate';
import { APPEND_TOKEN_CAP, type InboundEvent, type OutboundEvent } from './protocol';
import {
  type AgentLink,
  CANCEL_DEBOUNCE_MS,
  CANCEL_PROBE_QUIET_MS,
  DISPATCH_FILLER_MS,
  MUTE_RUNNER_DETAIL,
  MUTE_RUNNER_GRACE_MS,
  SETTLE_MAX_MS,
  SETTLE_QUIET_MS,
  type Scheduler,
  VoiceSession,
  type VoiceUiState,
} from './session';
import { GAP_MS } from './transcript';
import type { TransportState, VoiceTransport } from './transport';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeClock implements Scheduler {
  t = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const h = this.nextId++;
    this.timers.set(h, { at: this.t + ms, fn });
    return h;
  }
  clearTimeout(h: number) {
    this.timers.delete(h);
  }
  /** Run every timer due within `ms`, in order, advancing the clock as we go. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let pick: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!pick || entry[1].at < pick[1].at)) pick = entry;
      }
      if (!pick) break;
      this.t = pick[1].at;
      this.timers.delete(pick[0]);
      pick[1].fn();
    }
    this.t = target;
  }
  get pending() {
    return this.timers.size;
  }
}

interface FakeTransport extends VoiceTransport {
  sent: OutboundEvent[];
  emit(e: InboundEvent): void;
  emitState(s: TransportState, detail?: string): void;
}

function fakeTransport(): FakeTransport {
  const sent: OutboundEvent[] = [];
  const events = new Set<(e: InboundEvent) => void>();
  const states = new Set<(s: TransportState, d?: string) => void>();
  let closed = false;
  return {
    sent,
    get state(): TransportState {
      return closed ? 'closed' : 'open';
    },
    send: (e) => {
      sent.push(e);
    },
    onEvent(cb) {
      events.add(cb);
      return () => events.delete(cb);
    },
    onState(cb) {
      states.add(cb);
      return () => states.delete(cb);
    },
    close() {
      closed = true;
    },
    emit(e) {
      for (const cb of [...events]) cb(e);
    },
    emitState(s, d) {
      for (const cb of [...states]) cb(s, d);
    },
  };
}

interface FakeAgent extends AgentLink {
  sends: string[];
  stops: number;
  /** Queue rows dropped via `{t:'queue-cancel'}`. */
  cancelled: string[];
  /** `{t:'answer'}` frames — the only thing that unblocks a gated agent. */
  answers: Array<{ qid: string; answers: Array<{ question: string; answers: string[] }> }>;
  frame(f: unknown): void;
  online: boolean;
}

function fakeAgent(): FakeAgent {
  const cbs = new Set<(raw: unknown) => void>();
  const a: FakeAgent = {
    sends: [],
    stops: 0,
    cancelled: [],
    answers: [],
    online: true,
    send(text) {
      if (!a.online) return false;
      a.sends.push(text);
      return true;
    },
    stop() {
      a.stops += 1;
    },
    cancelQueued(id) {
      a.cancelled.push(id);
    },
    answer(qid, answers) {
      a.answers.push({ qid, answers });
    },
    onFrame(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    frame(f) {
      for (const cb of [...cbs]) cb(f);
    },
  };
  return a;
}

// ── Harness ─────────────────────────────────────────────────────────────────

function harness(
  opts: {
    withContext?: boolean;
    micGate?: MicGate;
    heartbeatMs?: number;
    onProtocolError?: (line: string) => void;
  } = {},
) {
  const clock = new FakeClock();
  const transport = fakeTransport();
  const agent = fakeAgent();
  const states: VoiceUiState[] = [];
  /** The sentence the session hands the UI with a state change, when it has
   *  one. A session that ends for a reason only IT knows has to be able to say
   *  so, and that sentence is the only place the reason survives. */
  const details: Array<string | undefined> = [];
  const session = new VoiceSession({
    transport,
    agent,
    scheduler: clock,
    onState: (s, d) => {
      states.push(s);
      details.push(d);
    },
    withContext: opts.withContext ?? false,
    ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.micGate ? { micGate: opts.micGate } : {}),
    ...(opts.onProtocolError ? { onProtocolError: opts.onProtocolError } : {}),
  });
  session.start();

  const started = () => transport.emit({ type: 'session.started' });
  const hear = (delta: string, start_ms: number, end_ms: number) =>
    transport.emit({ type: 'session.input_transcript.delta', delta, start_ms, end_ms });
  const speaks = (delta: string, start_ms: number, end_ms: number) =>
    transport.emit({ type: 'session.output_transcript.delta', delta, start_ms, end_ms });
  const delegate = (id: string, offset_ms: number, target = 'client') =>
    transport.emit({
      type: 'session.delegation.created',
      event_id: `ev-${id}`,
      offset_ms,
      delegation: { id, target },
    });

  const commentary = () =>
    transport.sent.filter((e) => e.type === 'session.commentary.append').map((e) => e.content);
  const thinking = () =>
    transport.sent.filter((e) => e.type === 'session.thinking.append').map((e) => e.content);

  /** The server's stamped turn-start. `text` is the message that started it —
   *  omit it to simulate an older server (or a cron turn nobody sent). */
  const turnStart = (text?: string) =>
    agent.frame(text === undefined ? { t: 'turn-start' } : { t: 'turn-start', text });

  return {
    clock,
    transport,
    agent,
    session,
    states,
    details,
    started,
    hear,
    speaks,
    delegate,
    turnStart,
    commentary,
    thinking,
    everything: () => transport.sent.map((e) => e.content).join('\n'),
    /** Run past the settle window. */
    settle: () => clock.advance(SETTLE_QUIET_MS + SETTLE_MAX_MS + 10),
    /** Run past the cancel probe, so a finished utterance gets judged. */
    probe: () => clock.advance(CANCEL_PROBE_QUIET_MS + 50),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('the happy path', () => {
  it('reconstructs an utterance from deltas and sends it on the chat socket', () => {
    const h = harness();
    h.started();
    h.hear('can you ', 1000, 1400);
    h.hear('run the tests?', 1400, 2000);
    h.delegate('d1', 2100);
    h.settle();
    expect(h.agent.sends).toEqual(['can you run the tests?']);
    expect(h.session.stats.requestsDispatched).toBe(1);
  });

  it('acknowledges IMMEDIATELY — before the request has even been reconstructed', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    // Not one tick of the clock has passed.
    expect(h.thinking()).toHaveLength(1);
    expect(h.agent.sends).toEqual([]);
    // Silent, so the model narrates in its own words rather than reading ours.
    expect(h.commentary()).toEqual([]);
  });

  it('stamps every append with the delegation id', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });
    expect(h.transport.sent.length).toBeGreaterThan(0);
    for (const e of h.transport.sent) expect(e.delegation_id).toBe('d1');
  });

  it('ignores a delegation aimed at someone else', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100, 'server');
    h.settle();
    expect(h.agent.sends).toEqual([]);
    expect(h.session.stats.delegationsClaimed).toBe(0);
  });
});

describe('duplicate delivery must not start the same work twice', () => {
  it('a redelivered delegation does nothing at all', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.delegate('d1', 2100);
    h.delegate('d1', 2100);
    h.settle();
    expect(h.agent.sends).toHaveLength(1);
    expect(h.session.stats.delegationsClaimed).toBe(1);
    expect(h.session.stats.duplicatesRefused).toBe(2);
  });

  it('a duplicate does NOT invalidate the original claim — the regression that eats the answer', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.delegate('d1', 2100); // redelivery mid-settle
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });
    expect(h.agent.sends).toHaveLength(1);
    expect(h.commentary()).toContain('They pass.');
  });

  it('refuses a duplicate that arrives after the turn already finished', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'turn-done', ok: true });
    h.delegate('d1', 2100);
    h.settle();
    expect(h.agent.sends).toHaveLength(1);
    expect(h.session.stats.duplicatesRefused).toBe(1);
  });
});

// ── THE BUG THIS RELEASE EXISTS TO FIX ──────────────────────────────────────
//
// "Whenever I tell it something and it delegates to the agent the agent starts
// working — if I start talking again, it captures it, but I think it stops the
// agent."
//
// It did. Twice over: any speech over a running turn fired `{t:'stop'}`, and any
// second delegation invalidated the first. Both are gone. These tests are the
// fence around that.

describe('TALKING IS FREE — speech is not a kill switch', () => {
  it('a second utterance does NOT stop a running turn', () => {
    const h = harness();
    h.started();
    h.hear('run the whole test suite.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the whole test suite.');

    // The user asks how it's going. This is the exact gesture that used to
    // destroy the work being asked about.
    h.hear('how is it going so far?', 10_000, 12_000);
    h.probe();

    expect(h.agent.stops).toBe(0);
    expect(h.session.state).toBe('thinking');
    // And the answer, when it lands, is still spoken — the turn was never
    // orphaned.
    h.agent.frame({ t: 'speak', id: 'r1', text: 'All 801 pass.', n: 1 });
    expect(h.commentary().join(' ')).toContain('All 801 pass.');
  });

  it('a long rambling comment over a running turn stops nothing', () => {
    const h = harness();
    h.started();
    h.hear('do the big refactor.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do the big refactor.');
    h.hear('yeah I was thinking about that earlier, ', 10_000, 12_000);
    h.hear('it always felt like the wrong shape to me', 12_000, 14_000);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('conversational chatter dispatches NOTHING — no delegation, no send', () => {
    const h = harness();
    h.started();
    // A whole conversation with the voice model. GPT-Live answers all of it
    // itself and never delegates, so nothing at all reaches the pane.
    h.hear('hey, are you there?', 1000, 2000);
    h.hear('what can you actually do?', 3000, 5000);
    h.hear('nice. okay, cool.', 6000, 7000);
    h.clock.advance(10_000);
    expect(h.agent.sends).toEqual([]);
    expect(h.agent.stops).toBe(0);
    expect(h.transport.sent).toEqual([]);
    expect(h.session.stats.delegationsClaimed).toBe(0);
  });
});

describe('A SECOND TASK QUEUES — it does not cancel', () => {
  it('dispatches both and stops neither', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');

    h.hear('also check the router while you are at it.', 8000, 10_000);
    h.delegate('d2', 10_100);
    h.settle();

    expect(h.agent.stops).toBe(0);
    expect(h.agent.sends).toEqual(['run the tests.', 'also check the router while you are at it.']);
    expect(h.session.stats.requestsDispatched).toBe(2);
    expect(h.session.stats.tasksQueued).toBe(1);
    // Both are live at once — the thing the old data model could not represent.
    expect(h.session.tasks.map((t) => t.status)).toEqual(['working', 'queued']);
  });

  it('the queued task waits its turn and is narrated when it starts', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    h.hear('also check the router.', 8000, 10_000);
    h.delegate('d2', 10_100);
    h.settle();
    // The server parks it and says so.
    h.agent.frame({ t: 'queued', id: 'q7', text: 'also check the router.' });
    expect(h.thinking().join(' ')).toMatch(/queued/i);

    h.agent.frame({ t: 'speak', id: 'r1', text: 'Tests pass.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
    h.turnStart('also check the router.');
    expect(h.commentary().join(' ')).toMatch(/Starting the next one/i);
  });

  it('two delegations that resolve to the SAME sentence are asked once', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    // The model fires twice around one pause — both join the same utterance.
    h.delegate('d1', 2050);
    h.delegate('d2', 2100);
    h.settle();
    expect(h.agent.sends).toEqual(['run the tests.']);
    expect(h.session.stats.duplicateRequests).toBe(1);
  });
});

describe('ATTRIBUTION with two tasks in flight', () => {
  it('speaks each answer under the task that asked for it', () => {
    const h = harness();
    h.started();
    h.hear('what is two plus two?', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.hear('and what colour is the sky?', 4000, 6000);
    h.delegate('dB', 6100);
    h.settle();
    expect(h.agent.sends).toHaveLength(2);

    // Turn A runs first — the server says so by naming the message.
    h.turnStart('what is two plus two?');
    h.agent.frame({ t: 'speak', id: 'rA', text: 'Four.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
    // Turn B follows.
    h.turnStart('and what colour is the sky?');
    h.agent.frame({ t: 'speak', id: 'rB', text: 'Blue.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });

    const four = h.transport.sent.find((e) => e.content.includes('Four.'));
    const blue = h.transport.sent.find((e) => e.content.includes('Blue.'));
    // THE ASSERTION THAT MATTERS: the right answer under the right task id.
    // Getting this wrong answers question A and the user hears it as B.
    expect(four?.delegation_id).toBe('dA');
    expect(blue?.delegation_id).toBe('dB');
  });

  it('binds in submit order when the server does not stamp the turn', () => {
    const h = harness();
    h.started();
    h.hear('first thing.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.hear('second thing.', 4000, 6000);
    h.delegate('dB', 6100);
    h.settle();
    h.turnStart(); // old server: no text
    h.agent.frame({ t: 'speak', id: 'rA', text: 'Did the first.', n: 1 });
    expect(h.transport.sent.find((e) => e.content.includes('Did the first.'))?.delegation_id).toBe(
      'dA',
    );
  });

  it('a turn the user started by TYPING binds to nothing and is never spoken', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    // The user types something else into the same pane; the server runs THAT
    // first and names it. Attributing it to our request would speak the answer
    // to a question the voice session never asked.
    h.turnStart('hey claude, what is in this directory?');
    h.agent.frame({ t: 'speak', id: 'rT', text: 'Some files.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.everything()).not.toContain('Some files.');
    // …and our request is still pending, not closed by someone else's turn.
    expect(h.session.tasks.map((t) => t.status)).toEqual(['queued']);

    // Now ours runs, and IS spoken.
    h.turnStart('run the tests.');
    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });
    expect(h.commentary().join(' ')).toContain('They pass.');
  });

  it('a reconnect re-broadcasting turn-start does not re-bind to the next task', () => {
    const h = harness();
    h.started();
    h.hear('first thing.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.hear('second thing.', 4000, 6000);
    h.delegate('dB', 6100);
    h.settle();
    h.turnStart('first thing.');
    // The runner reconnects mid-turn; the server resyncs with a bare turn-start
    // for a turn that is ALREADY running.
    h.turnStart();
    h.agent.frame({ t: 'speak', id: 'rA', text: 'Still the first one.', n: 1 });
    expect(
      h.transport.sent.find((e) => e.content.includes('Still the first one.'))?.delegation_id,
    ).toBe('dA');
  });

  it('the heartbeat stops firing once the work is done', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    h.clock.advance(30_000);
    const beats = h.commentary().filter((t) => t.includes('Still working')).length;
    expect(beats).toBeGreaterThan(0);
    h.agent.frame({ t: 'turn-done', ok: true });
    h.clock.advance(120_000);
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBe(beats);
  });
});

// ── THE FOUR WAYS A TASK USED TO BE ANSWERED BY THE WRONG TURN, OR BY NONE ──
//
// Every one of these is the same shape: a frame that says nothing about WHICH
// request it concerns being used to close, bind or fail one anyway.

describe('an unstamped turn-start is not evidence of an old server', () => {
  it('binds nothing once this server has been seen to stamp', () => {
    const h = harness();
    h.started();
    // One stamped turn is all the proof needed that this server stamps.
    h.hear('first thing.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.turnStart('first thing.');
    h.agent.frame({ t: 'turn-done', ok: true });

    // A second request goes out and is waiting its turn…
    h.hear('second thing.', 4000, 6000);
    h.delegate('dB', 6100);
    h.settle();

    // …and the runner reconnects mid-turn on SOMEONE ELSE'S turn (the user
    // typing, a cron). The server rebuilt its state from nothing, so it cannot
    // name the message any more and re-broadcasts a bare turn-start. Reading
    // that as "old server, bind by submit order" hands a live foreign turn to
    // our queued request — which then speaks its output and is closed by a
    // turn-done it never earned.
    h.turnStart();
    h.agent.frame({ t: 'speak', id: 'rX', text: 'Contents of the directory.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });

    expect(h.everything()).not.toContain('Contents of the directory.');
    expect(h.session.tasks.map((t) => t.status)).toEqual(['queued']);

    // And our own turn, when it is named, still binds and still speaks.
    h.turnStart('second thing.');
    h.agent.frame({ t: 'speak', id: 'rB', text: 'Did the second.', n: 1 });
    expect(h.commentary().join(' ')).toContain('Did the second.');
  });

  it('still falls back to submit order against a server that has never stamped', () => {
    // The legacy path is not removed, only narrowed: with no stamped turn ever
    // seen, order is still the best available answer.
    const h = harness();
    h.started();
    h.hear('first thing.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.turnStart();
    h.agent.frame({ t: 'speak', id: 'rA', text: 'Did the first.', n: 1 });
    expect(h.transport.sent.find((e) => e.content.includes('Did the first.'))?.delegation_id).toBe(
      'dA',
    );
  });
});

describe('an `error` is about a REJECTED SEND, not about the running turn', () => {
  /** A running task A, plus a task B the server parked behind it. */
  const twoInFlight = () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.turnStart('run the tests.');
    h.hear('and then deploy it.', 4000, 6000);
    h.delegate('dB', 6100);
    h.settle();
    return h;
  };

  it('does not fail the live turn or drop its answer', () => {
    const h = twoInFlight();
    // The server refuses the SECOND send — queue cap, in this case. It arrives
    // on the same socket, mid-turn, and says nothing about which send it means.
    h.agent.frame({ t: 'error', message: 'too many queued messages (max 20)' });

    // The running turn is untouched and its answer is still spoken under it.
    h.agent.frame({ t: 'speak', id: 'rA', text: 'All 801 pass.', n: 1 });
    expect(h.transport.sent.find((e) => e.content.includes('All 801 pass.'))?.delegation_id).toBe(
      'dA',
    );
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.session.tasks.map((t) => t.id)).toEqual([]);
  });

  it('retires the rejected request instead of leaving it queued forever', () => {
    const h = twoInFlight();
    h.agent.frame({ t: 'error', message: 'too many queued messages (max 20)' });
    h.clock.advance(1000); // let the held delivery reach the floor
    // The failure is spoken, and it is spoken under the request it is about.
    const said = h.transport.sent.find((e) => e.content.includes('too many queued messages'));
    expect(said?.delegation_id).toBe('dB');
    // …and B is gone from the pipeline rather than blocking it forever.
    expect(h.session.tasks.map((t) => t.id)).toEqual(['dA']);
  });

  it('does not silently disarm the cancel', () => {
    // The compounding failure: `error` used to clear `turnRunning`, and the
    // explicit-cancel path gates `agent.stop()` on it. So a rejected send made
    // the very next "stop" stop nothing at all, silently.
    const h = twoInFlight();
    h.agent.frame({ t: 'error', message: 'too many queued messages (max 20)' });
    h.hear('stop', 20_000, 20_800);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });
});

describe('a request cancelled from the chat UI does not haunt the pipeline', () => {
  /** A running task A and a task B parked in the server's queue as row q1. */
  const parked = () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.turnStart('run the tests.');
    h.hear('and then deploy it.', 4000, 6000);
    h.delegate('dB', 6100);
    h.settle();
    h.agent.frame({ t: 'queued', id: 'q1', text: 'and then deploy it.' });
    h.agent.frame({ t: 'queue', items: [{ id: 'q1', text: 'and then deploy it.' }] });
    return h;
  };

  it('retires a task whose queue row was dropped', () => {
    const h = parked();
    // The user taps × on the pending bubble in the chat UI. The server drops the
    // row and rebroadcasts the queue — and that is the ONLY thing it sends. No
    // turn-start will ever name this request and no turn-done will ever close
    // it, so before this fix it stayed `queued` for the life of the session.
    h.agent.frame({ t: 'queue', items: [] });
    h.clock.advance(6000);
    expect(h.session.tasks.map((t) => t.id)).toEqual(['dA']);
    expect(h.commentary().join(' ')).toContain('cancelled before it ran');
  });

  it('does NOT mistake a drain for a cancellation', () => {
    // The row leaves the queue for two reasons and the broadcast does not say
    // which. A drain removes it and rebroadcasts BEFORE the runner's turn-start
    // echoes back, so the grace window is what keeps this from retiring work
    // that is about to run.
    const h = parked();
    h.agent.frame({ t: 'turn-done', ok: true });
    h.agent.frame({ t: 'queue', items: [] });
    h.agent.frame({ t: 'turn-start', text: 'and then deploy it.' });
    h.clock.advance(6000);
    expect(h.session.tasks.map((t) => [t.id, t.status])).toEqual([['dB', 'working']]);
    h.agent.frame({ t: 'speak', id: 'rB', text: 'Deployed.', n: 1 });
    expect(h.commentary().join(' ')).toContain('Deployed.');
  });

  it('does not retire a request that was re-parked under a new row', () => {
    // `editQueued` is a `queue-cancel` plus a fresh send, so an edit that
    // leaves the text unchanged takes the row away and gives a new one back.
    // The write-off has to be revocable, or the edit kills the work.
    const h = parked();
    h.agent.frame({ t: 'queue', items: [] });
    h.clock.advance(500);
    h.agent.frame({ t: 'queued', id: 'q2', text: 'and then deploy it.' });
    h.agent.frame({ t: 'queue', items: [{ id: 'q2', text: 'and then deploy it.' }] });
    h.clock.advance(6000);
    expect(h.session.tasks.map((t) => t.id)).toEqual(['dA', 'dB']);
  });

  it('leaves a fast-path send alone — it was never in the queue to begin with', () => {
    // A send that went out while the agent was idle never becomes a queue row,
    // so its absence from the list means nothing. Reading it as a cancellation
    // would retire every request we ever dispatched.
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('dA', 2100);
    h.settle();
    h.agent.frame({ t: 'queue', items: [] });
    h.clock.advance(6000);
    expect(h.session.tasks.map((t) => t.id)).toEqual(['dA']);
  });
});

describe('a message held for the floor is not deleted by the retirement that produced it', () => {
  it('speaks the answer that arrived while the user was mid-sentence', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');

    // The user starts saying something else, so the floor is busy…
    h.hear('so anyway I was thinking', 5000, 6000);
    // …and that is exactly when the answer lands.
    h.agent.frame({ t: 'speak', id: 'r1', text: 'All 801 pass.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.commentary().join(' ')).not.toContain('All 801 pass.');

    // The turn-done retired the task. Re-testing full staleness when the floor
    // frees up drops the answer the retirement was announcing — which is the
    // whole bug. Only the fence may retract a held append.
    h.clock.advance(2000);
    expect(h.commentary().join(' ')).toContain('All 801 pass.');
  });

  it('still says "I can’t reach the chat right now" when the floor was busy', () => {
    const h = harness();
    h.started();
    h.agent.online = false;
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    // The user carries on talking, so the settle lands on a busy floor.
    h.clock.advance(400);
    h.hear(' now.', 2000, 2400);
    h.clock.advance(300);
    expect(h.agent.sends).toEqual([]);
    h.clock.advance(2000);
    expect(h.commentary().join(' ')).toContain('can’t reach the chat');
  });

  // The FENCE — the half of the staleness test that still applies to a held
  // append — is pinned by 'never speaks the tail of the turn it just killed'
  // above, plus `cancel`'s outright `pending.clear()`. A held item cannot in
  // practice outlive a SPOKEN cancel: both wait on input quiet and the floor's
  // 600ms always wins the 900ms cancel probe.
});

describe('the settle window — the delegation beats the transcript', () => {
  it('waits for a sentence that is still arriving', () => {
    const h = harness();
    h.started();
    h.hear('can you run', 1000, 1500);
    h.delegate('d1', 1400); // fires mid-sentence, as documented
    h.clock.advance(SETTLE_QUIET_MS - 1);
    expect(h.agent.sends).toEqual([]);
    // The rest of the sentence lands during the wait.
    h.hear(' the tests?', 1500, 2100);
    h.clock.advance(SETTLE_QUIET_MS + 10);
    expect(h.agent.sends).toEqual(['can you run the tests?']);
  });

  it('gives up waiting and sends what it has rather than stalling forever', () => {
    const h = harness();
    h.started();
    h.hear('keep talking without ever stopping', 1000, 2000);
    h.delegate('d1', 1900);
    // The user never finishes a sentence; deltas keep coming.
    for (let i = 0; i < 40; i++) {
      h.clock.advance(100);
      h.hear(' more', 2000 + i * 100, 2100 + i * 100);
    }
    expect(h.agent.sends).toHaveLength(1);
    expect(h.agent.sends[0]).toContain('keep talking');
  });

  it('says it did not catch anything when there is no transcript to use', () => {
    const h = harness();
    h.started();
    h.delegate('d1', 2100);
    h.settle();
    expect(h.agent.sends).toEqual([]);
    expect(h.commentary().join(' ')).toMatch(/didn’t catch/i);
  });

  it('says so when the chat socket is down instead of silently losing the request', () => {
    const h = harness();
    h.started();
    h.agent.online = false;
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    expect(h.commentary().join(' ')).toMatch(/can’t reach the chat/i);
  });
});

describe('narrating an agent that takes minutes', () => {
  it('never blocks — the session keeps reacting while a turn runs', () => {
    const h = harness();
    h.started();
    h.hear('do a big thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    expect(h.session.state).toBe('thinking');
    // Two minutes of work, and the session is still alive and still narrating —
    // ALOUD. A silent `thinking` heartbeat is two minutes of dead air.
    h.clock.advance(120_000);
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it('injects results as they arrive, across several appends', () => {
    const h = harness();
    h.started();
    h.hear('do a big thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak-delta', id: 'r1', delta: 'Found the bug. ' });
    h.agent.frame({ t: 'speak-delta', id: 'r1', delta: 'Fixing it now. ' });
    h.agent.frame({ t: 'speak', id: 'r1', text: 'Found the bug. Fixing it now. Done.' });
    // The leading entry is the dispatch filler (the model said nothing of its
    // own here); the answer follows it, split at sentence boundaries.
    expect(h.commentary().slice(1)).toEqual(['Found the bug.', 'Fixing it now.', 'Done.']);
  });

  it('speaks a question — that is the agent needing you', () => {
    const h = harness();
    h.started();
    h.hear('ship it.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({
      t: 'question',
      qid: 'q1',
      questions: [
        {
          question: 'About to `git push`. Proceed?',
          header: 'Push',
          multiSelect: false,
          options: [{ label: 'Push' }, { label: 'Stop' }],
        },
      ],
    });
    expect(h.commentary().join(' ')).toContain('git push');
  });

  it('NEVER speaks the private scratchpad', () => {
    const h = harness();
    h.started();
    h.hear('do a thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'stream', delta: 'The user is probably wrong about this.' });
    h.agent.frame({ t: 'stream', delta: ' I will not say that out loud.' });
    const everything = h.transport.sent.map((e) => e.content).join(' ');
    expect(everything).not.toContain('probably wrong');
    expect(everything).not.toContain('out loud');
  });

  it('drops frames from a turn the user started by TYPING — there is no delegation to speak under', () => {
    const h = harness();
    h.started();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak', id: 'r1', text: 'Answer to a typed question.', n: 1 });
    expect(h.transport.sent).toEqual([]);
    expect(h.session.stats.staleDrops).toBeGreaterThan(0);
  });

  it('emits the final answer BEFORE closing the delegation', () => {
    const h = harness();
    h.started();
    h.hear('do a thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak-delta', id: 'r1', delta: 'the tail with no full stop' });
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.commentary().join(' ')).toContain('the tail with no full stop');
  });
});

describe('the 500-token cap', () => {
  it('splits a long reply across several appends, each inside the cap', () => {
    const h = harness();
    h.started();
    h.hear('explain everything.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    const huge = 'The router now resolves nested tabs correctly. '.repeat(300);
    h.agent.frame({ t: 'speak', id: 'r1', text: huge, n: 1 });
    const parts = h.commentary();
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(estimateTokens(p)).toBeLessThanOrEqual(APPEND_TOKEN_CAP);
  });

  it('caps thinking appends too — a dispatched request can be long', () => {
    const h = harness();
    h.started();
    h.hear(`${'please do this thing '.repeat(400)}.`, 1000, 40_000);
    h.delegate('d1', 40_100);
    h.settle();
    for (const t of h.thinking()) expect(estimateTokens(t)).toBeLessThanOrEqual(APPEND_TOKEN_CAP);
  });
});

describe('nothing is sent before session.started', () => {
  it('queues appends and flushes them on the handshake', () => {
    const h = harness();
    // No `started()` — the channel is up but the session is not.
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    expect(h.transport.sent).toEqual([]);
    h.started();
    expect(h.transport.sent.length).toBeGreaterThan(0);
  });

  it('never sends session.start — the session is already started', () => {
    const h = harness();
    h.started();
    h.hear('hello.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    for (const e of h.transport.sent) expect(e.type).not.toBe('session.start');
  });
});

// ── CANCELLING: explicit, narrow, and the only thing that stops the agent ───
//
// A missed cancel costs one repetition. A false cancel costs minutes of the
// user's work and writes a durable interrupted notice. These are not close, so
// every negative case below is worth more than the positive ones.

describe('explicit cancel', () => {
  const running = () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    return h;
  };

  it('stops the agent on a bare "stop"', () => {
    const h = running();
    h.hear('stop.', 10_000, 10_600);
    h.probe();
    expect(h.agent.stops).toBe(1);
    expect(h.session.stats.cancels).toBe(1);
  });

  it('stops on "okay, never mind"', () => {
    const h = running();
    h.hear('okay, never mind.', 10_000, 11_200);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });

  it('says so out loud, so the user knows it landed', () => {
    const h = running();
    h.hear('cancel that.', 10_000, 11_000);
    h.probe();
    expect(h.commentary().join(' ')).toMatch(/stopped/i);
  });

  it('does NOT stop on "stop the dev server" — that is a TASK', () => {
    const h = running();
    h.hear('stop the dev server.', 10_000, 11_500);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('does NOT cancel on the first word of a sentence still arriving', () => {
    const h = running();
    // "stop" lands alone; the object of the verb is still coming. Judging deltas
    // as they arrive kills the turn here.
    h.hear('stop', 10_000, 10_400);
    h.clock.advance(200);
    expect(h.agent.stops).toBe(0);
    h.hear(' the docker container too', 10_400, 11_800);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('does NOT cancel on a correction — that is a second task', () => {
    const h = running();
    h.hear('actually, do the router one instead.', 10_000, 12_000);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('does NOT fire on a degenerate blip too short to be a word at all', () => {
    const h = running();
    h.hear('stop', 10_000, 10_060);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('DOES fire on a short, crisp "stop" — the one utterance this exists for', () => {
    // A bare "stop" is one syllable and routinely lands under the 300ms floor
    // that a generic barge-in filter wants. Declining it there left only the
    // model-delegated path, which is exactly the path the backstop exists
    // because the model may not take.
    const h = running();
    h.hear('stop', 10_000, 10_220);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });

  it('DOES fire on a "stop" spoken OVER the model — the normal way anyone cancels', () => {
    const h = running();
    // The model is mid-sentence about something else…
    h.speaks('so the next thing I would look at is the router file', 8000, 10_000);
    // …and the user cuts in, which by definition starts inside the echo window.
    h.hear('stop', 10_100, 10_600);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });

  it('does NOT fire on the model’s own echo coming back through the mic', () => {
    const h = running();
    h.speaks('Stop?', 8000, 10_000);
    // Echo, transcribed 100ms after the model stopped. The model really did
    // just say this word, which is the direct evidence the time window was
    // only ever standing in for.
    h.hear('stop', 10_100, 11_500);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('does not mistake our own "Stopped." narration for the user saying "stop"', () => {
    const h = running();
    h.speaks('Stopped. The agent has been interrupted.', 8000, 10_000);
    h.hear('stop', 10_100, 10_600);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });

  it('does nothing when there is no work at all — "stop" is then just a word', () => {
    const h = harness();
    h.started();
    h.hear('stop.', 1000, 2000);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });

  it('fires once per utterance, not once per delta', () => {
    const h = running();
    // One cancel, spread over three deltas. A probe that ruled on each delta
    // would both mis-read the fragments and fire repeatedly.
    h.hear('never', 10_000, 10_400);
    h.hear(' mind', 10_400, 10_800);
    h.probe();
    h.probe();
    expect(h.agent.stops).toBe(1);
    expect(h.session.stats.cancels).toBe(1);
  });

  it('drops the QUEUED backlog too, not just the running turn', () => {
    const h = running();
    h.hear('also check the router.', 8000, 10_000);
    h.delegate('d2', 10_100);
    h.settle();
    h.agent.frame({ t: 'queued', id: 'q9', text: 'also check the router.' });
    h.hear('cancel that.', 20_000, 21_000);
    h.probe();
    expect(h.agent.stops).toBe(1);
    // Stopping the running turn while its successor fires anyway is not what
    // anyone means by "stop".
    expect(h.agent.cancelled).toEqual(['q9']);
    expect(h.session.tasks).toEqual([]);
  });

  it('never speaks the tail of the turn it just killed', () => {
    const h = running();
    h.hear('stop.', 10_000, 10_600);
    h.probe();
    // Cancellation is COOPERATIVE: the dying turn still gets a word in.
    h.agent.frame({ t: 'speak', id: 'r1', text: 'I finished the long thing.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.everything()).not.toContain('I finished the long thing.');
  });

  it('a delegated cancel and the spoken backstop together fire ONE stop', () => {
    const h = running();
    h.hear('stop.', 10_000, 10_600);
    h.probe();
    // The model delegates the same "stop" a beat later, as it does.
    h.delegate('d2', 10_700);
    h.settle();
    expect(h.agent.stops).toBe(1);
    expect(h.agent.sends).toHaveLength(1); // "stop" never reached the agent
  });

  it('a delegated cancel alone still stops the agent', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    // This time the transcript probe is not what catches it — the model routes
    // the cancel through a delegation, which is the intended main path.
    h.hear('cancel that.', 10_000, 11_000);
    h.delegate('d2', 11_100);
    h.clock.advance(SETTLE_QUIET_MS + 10);
    expect(h.agent.stops).toBe(1);
    expect(h.agent.sends).toEqual(['do a long thing.']);
  });
});

describe('UI state', () => {
  it('opens in connecting and reaches listening on the handshake', () => {
    const h = harness();
    expect(h.session.state).toBe('connecting');
    h.started();
    expect(h.session.state).toBe('listening');
  });

  it('reads speaking while the model produces transcript, and decays back', () => {
    const h = harness();
    h.started();
    h.speaks('Here is what I found.', 1000, 2000);
    expect(h.session.state).toBe('speaking');
    h.clock.advance(2000);
    expect(h.session.state).toBe('listening');
  });

  it('reads thinking while the agent works', () => {
    const h = harness();
    h.started();
    h.hear('do a thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    expect(h.session.state).toBe('thinking');
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.session.state).toBe('listening');
  });

  it('goes to error, with a reason, when the transport fails', () => {
    const h = harness();
    h.started();
    h.transport.emitState('failed', 'peer connection failed');
    expect(h.session.state).toBe('error');
    expect(h.states).toContain('error');
  });

  it('goes to ended when the transport closes', () => {
    const h = harness();
    h.started();
    h.transport.emitState('closed');
    expect(h.session.state).toBe('ended');
  });
});

describe('dispose', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.started();
  });

  it('clears every timer', () => {
    h.hear('do a thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.session.dispose('user');
    expect(h.clock.pending).toBe(0);
  });

  it('stops reacting to both wires', () => {
    h.session.dispose('user');
    const before = h.transport.sent.length;
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'speak', id: 'r1', text: 'hello', n: 1 });
    expect(h.transport.sent.length).toBe(before);
    expect(h.agent.sends).toEqual([]);
  });

  it('is idempotent', () => {
    const spy = vi.fn();
    const h2 = harness();
    h2.session.dispose('user');
    h2.session.dispose('user');
    expect(spy).not.toHaveBeenCalled();
    expect(h2.session.state).toBe('ended');
  });
});

describe('a custom mic gate is honoured', () => {
  it('a wide-open gate lets a very short cancel through', () => {
    const h = harness({
      micGate: new MicGate({ minUtteranceMs: 1, minCancelUtteranceMs: 1, postPlaybackMs: 0 }),
    });
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    h.hear('stop', 10_000, 10_050);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });

  it('…and a wide-open gate still refuses a non-cancel', () => {
    const h = harness({
      micGate: new MicGate({ minUtteranceMs: 1, minCancelUtteranceMs: 1, postPlaybackMs: 0 }),
    });
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    h.hear('no', 10_000, 10_050);
    h.probe();
    expect(h.agent.stops).toBe(0);
  });
});

// ── The three ways voice mode shipped silent ────────────────────────────────
//
// Every one of these was invisible in production: no throw, no failed frame, no
// state change. They are here because "it looks like it is working" is exactly
// what each of them looked like.

describe('the append wire format', () => {
  it('sends the payload as `content` — `text` is rejected by the model, silently', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });

    expect(h.transport.sent.length).toBeGreaterThan(0);
    for (const e of h.transport.sent) {
      expect(typeof e.content).toBe('string');
      expect(e.content.length).toBeGreaterThan(0);
      // The whole bug, in one assertion: an append carrying `text` is answered
      // with `missing_required_parameter: 'content'` and never reaches the model.
      expect(e).not.toHaveProperty('text');
    }
  });

  it('stamps an event_id so a rejection can be traced to the append that caused it', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    const ids = h.transport.sent.map((e) => e.event_id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('errors on the model wire are never swallowed', () => {
  it('surfaces a rejected append instead of discarding it as an unknown event', () => {
    const seen: string[] = [];
    const h = harness({ onProtocolError: (l) => seen.push(l) });
    h.started();
    h.transport.emit({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'missing_required_parameter',
        message: "Missing required parameter: 'content'.",
        param: 'content',
        client_event_id: 'mux_1',
      },
    });
    expect(h.session.stats.protocolErrors).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("Missing required parameter: 'content'.");
    expect(seen[0]).toContain('mux_1');
  });

  it('counts acknowledgements, so sent-without-acked is visible', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    expect(h.session.stats.appendsSent).toBeGreaterThan(0);
    expect(h.session.stats.appendsAcked).toBe(0);
    h.transport.emit({ type: 'session.thinking.appended', client_event_id: 'mux_1' });
    h.transport.emit({ type: 'session.commentary.appended', client_event_id: 'mux_2' });
    expect(h.session.stats.appendsAcked).toBe(2);
  });

  it('an error does not end the session or change the UI state', () => {
    const h = harness();
    h.started();
    const before = h.session.state;
    h.transport.emit({ type: 'error', error: { message: 'nope' } });
    expect(h.session.state).toBe(before);
  });
});

describe('filling the silence while an agent works', () => {
  it('speaks a filler shortly after dispatch — there are no built-in ones', () => {
    const h = harness();
    h.started();
    h.hear('do a big thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.clock.advance(SETTLE_QUIET_MS + 10);
    expect(h.agent.sends).toHaveLength(1);
    // Nothing spoken yet — the model is given a beat to say something itself.
    expect(h.commentary()).toEqual([]);
    h.clock.advance(DISPATCH_FILLER_MS + 10);
    expect(h.commentary().join(' ')).toMatch(/on it/i);
  });

  it('stays quiet when the model already spoke for itself — no two voices', () => {
    const h = harness();
    h.started();
    h.hear('do a big thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.clock.advance(SETTLE_QUIET_MS + 10);
    // The model volunteers its own "hang on" off the delegation, as it does.
    h.speaks('Okay, hang on.', 2200, 2600);
    h.clock.advance(DISPATCH_FILLER_MS + 10);
    expect(h.commentary()).toEqual([]);
  });

  it('drops the filler when the user has already moved on', () => {
    const h = harness();
    h.started();
    h.hear('do a big thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.clock.advance(SETTLE_QUIET_MS + 10);
    h.hear('no, something else.', 3000, 4000);
    h.delegate('d2', 4100);
    h.clock.advance(DISPATCH_FILLER_MS + 10);
    expect(h.commentary().filter((t) => /on it/i.test(t))).toEqual([]);
  });

  it('the long-work heartbeat is SPOKEN, not a silent thinking note', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    h.clock.advance(60_000);
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBeGreaterThan(0);
    expect(h.thinking().filter((t) => t.includes('Still working'))).toEqual([]);
  });

  it('names the tool the agent is running, so progress is real information', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    // Tool activity rides the ordinary transcript batch the chat pane renders.
    h.agent.frame({
      t: 'events',
      phase: 'live',
      events: [{ kind: 'tool_use', name: 'Grep', toolUseId: 'x1' }],
    });
    h.clock.advance(30_000);
    expect(h.commentary().join(' ')).toContain('currently running Grep');
  });

  it('reads tool NAMES and never the private scratchpad riding the same frame', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('do a long thing.');
    h.agent.frame({
      t: 'events',
      phase: 'live',
      events: [
        { kind: 'assistant', text: 'The user is wrong but I will not say so.' },
        { kind: 'tool_use', name: 'Bash', toolUseId: 'x2' },
      ],
    });
    h.clock.advance(30_000);
    expect(h.everything()).not.toContain('The user is wrong');
    expect(h.commentary().join(' ')).toContain('currently running Bash');
  });

  it('says how much is queued behind the running task', () => {
    const h = harness();
    h.started();
    h.hear('first long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('first long thing.');
    h.hear('second thing.', 5000, 6000);
    h.delegate('d2', 6100);
    h.settle();
    h.clock.advance(30_000);
    expect(h.commentary().join(' ')).toMatch(/1 more request is queued behind it/);
  });

  it('goes quiet while the agent is blocked on a question it already asked', () => {
    const h = harness();
    h.started();
    h.hear('ship it.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('ship it.');
    h.agent.frame({
      t: 'question',
      qid: 'q1',
      questions: [
        { question: 'Push?', header: 'Push', multiSelect: false, options: [{ label: 'Yes' }] },
      ],
    });
    const before = h.commentary().filter((t) => t.includes('Still working')).length;
    h.clock.advance(120_000);
    // "Still working" over an unanswered question reads as not listening.
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBe(before);
    h.agent.frame({ t: 'question-done', qid: 'q1' });
    h.clock.advance(60_000);
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBeGreaterThan(
      before,
    );
  });
});

// ── WHEN an append reaches the model, which is not the same question as what ─

describe('delivery policy', () => {
  it('holds an answer while the user is mid-sentence, then releases it', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');

    // The user starts a new sentence just as the answer lands.
    h.hear('so what I was thinking is', 20_000, 22_000);
    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });
    // Nothing spoken over them.
    expect(h.commentary().join(' ')).not.toContain('They pass.');
    expect(h.session.stats.deliveriesHeld).toBeGreaterThan(0);

    // They stop. The floor is free, and the answer arrives.
    h.clock.advance(1000);
    expect(h.commentary().join(' ')).toContain('They pass.');
  });

  it('an agent QUESTION interrupts — it is worthless late', () => {
    const h = harness();
    h.started();
    h.hear('ship it.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('ship it.');
    h.hear('and another thing', 20_000, 22_000);
    h.agent.frame({
      t: 'question',
      qid: 'q1',
      questions: [
        {
          question: 'About to `git push`. Proceed?',
          header: 'Push',
          multiSelect: false,
          options: [{ label: 'Push' }, { label: 'Stop' }],
        },
      ],
    });
    // The reversibility gate reaches the user even mid-utterance.
    expect(h.commentary().join(' ')).toContain('git push');
  });

  it('re-anchors a result the conversation has moved past', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    // Three minutes of other conversation.
    h.clock.advance(180_000);
    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });
    h.clock.advance(1000);
    expect(h.session.stats.reanchored).toBeGreaterThan(0);
    // The instruction is SILENT — a model handed it as commentary reads it out.
    expect(h.thinking().join(' ')).toMatch(/finish responding to whatever the user/i);
    expect(h.commentary().join(' ')).not.toMatch(/finish responding to whatever the user/i);
  });

  it('re-anchors the RESULT and not the progress updates', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    // Two minutes of heartbeats, then the answer.
    h.clock.advance(120_000);
    const beats = h.commentary().filter((t) => t.includes('Still working')).length;
    expect(beats).toBeGreaterThan(3);
    // Measured in a live session: without the final gate every one of these was
    // prefixed with "the conversation has moved on", which is both untrue and
    // several hundred wasted tokens each.
    expect(h.session.stats.reanchored).toBe(0);

    h.agent.frame({ t: 'speak', id: 'r1', text: 'They pass.', n: 1 });
    h.clock.advance(1000);
    expect(h.session.stats.reanchored).toBe(1);
  });

  it('does NOT re-anchor an answer that lands in the same beat of conversation', () => {
    const h = harness({ heartbeatMs: 10_000_000 });
    h.started();
    h.hear('what is two plus two?', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('what is two plus two?');
    h.agent.frame({ t: 'speak', id: 'r1', text: 'Four.', n: 1 });
    // Protocol bookkeeping (turn-start) is not the conversation moving on.
    expect(h.session.stats.reanchored).toBe(0);
  });
});

describe('the model always knows what is running', () => {
  it('pushes the task list as silent context on every change', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    // This is what lets "how's it going?" be answered without touching the
    // agent — there is no tool for the model to call on this transport.
    expect(h.thinking().join('\n')).toContain('run the tests.');
    expect(h.thinking().join('\n')).toMatch(/never delegate those/i);
  });

  it('tells the model not to re-send a request that is already running', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    expect(h.thinking().join(' ')).toMatch(/do not invent a result/i);
  });
});

// ── Answering a blocked agent ───────────────────────────────────────────────
//
// A `{t:'question'}` — an `ask_user`, or the reversibility gate holding a
// `git push` — stops the agent dead. The turn is still open, so the server
// QUEUES any `{t:'send'}` that arrives behind it; the only frame that releases
// the gate is `{t:'answer'}`. Verified against a live session before these
// tests existed: the question was spoken, the user said "yes, go ahead and push
// it", it went out as a `send`, the server queued it, and the pane stayed
// `blocked` until the session expired.

/** The real frame the gate raises, labels and curly apostrophe included. */
const GATE_FRAME = {
  t: 'question',
  qid: 'gate-1',
  questions: [
    {
      question:
        'This publishes commits to the remote. Anyone with access can fetch them from that moment. Go ahead?',
      header: 'Push',
      multiSelect: false,
      options: [
        { label: 'Do it', description: 'git push origin HEAD' },
        {
          label: 'Don’t',
          description: 'The agent is told you declined, and carries on without it.',
        },
      ],
    },
  ],
};

/** Dispatch a request, bind its turn, and have the agent block on the gate. */
function blockedOnGate() {
  const h = harness();
  h.started();
  h.hear('push the branch.', 1000, 2000);
  h.delegate('d1', 2100);
  h.settle();
  h.turnStart('push the branch.');
  h.agent.frame(GATE_FRAME);
  return h;
}

describe('a spoken answer reaches the gate', () => {
  it('speaks the question AND names the words to say back', () => {
    const h = blockedOnGate();
    const spoken = h.commentary().join(' ');
    expect(spoken).toContain('The agent is waiting on you.');
    expect(spoken).toContain('Go ahead?');
    // Exact matching is only usable if the user is told which words to use.
    expect(spoken).toMatch(/one of those words exactly/i);
    expect(spoken).toContain('"Do it"');
  });

  it('sends {t:answer} — NOT a {t:send} that the server would queue behind the question', () => {
    const h = blockedOnGate();
    h.hear('do it.', 9000, 9600);
    h.delegate('d2', 9700);
    h.settle();
    expect(h.agent.answers).toEqual([
      {
        qid: 'gate-1',
        answers: [{ question: GATE_FRAME.questions[0]?.question, answers: ['Do it'] }],
      },
    ]);
    // The whole bug: this used to be a send, and a send never unblocks a gate.
    expect(h.agent.sends).toEqual(['push the branch.']);
    expect(h.session.stats.questionsAnswered).toBe(1);
  });

  it('forwards words that match no option verbatim — which the gate reads as a denial with a reason', () => {
    const h = blockedOnGate();
    h.hear('not to main, use a branch.', 9000, 9800);
    h.delegate('d2', 9900);
    h.settle();
    expect(h.agent.answers[0]?.answers[0]?.answers).toEqual(['not to main, use a branch.']);
    expect(h.agent.sends).toEqual(['push the branch.']);
  });

  it('never turns a refusal into the affirmative', () => {
    const h = blockedOnGate();
    h.hear("don't do it.", 9000, 9600);
    h.delegate('d2', 9700);
    h.settle();
    // Anything that is not exactly the affirmative label must not be it.
    expect(h.agent.answers[0]?.answers[0]?.answers).not.toEqual(['Do it']);
  });

  it('does not dispatch the answer as agent work, and says what it did', () => {
    const h = blockedOnGate();
    h.hear('do it.', 9000, 9600);
    h.delegate('d2', 9700);
    h.settle();
    // An answer releases the running turn; it is not a second task, so it must
    // not appear in the running-work snapshot the model narrates from.
    expect(h.session.tasks.some((t) => t.status === 'queued')).toBe(false);
    expect(h.commentary().join(' ')).toContain('Answered: Do it.');
  });

  it('stops treating speech as an answer once the question is done', () => {
    const h = blockedOnGate();
    h.agent.frame({ t: 'question-done', qid: 'gate-1' });
    h.hear('now run the tests.', 9000, 9800);
    h.delegate('d2', 9900);
    h.settle();
    expect(h.agent.answers).toEqual([]);
    expect(h.agent.sends).toEqual(['push the branch.', 'now run the tests.']);
  });

  it('still treats an unmistakable "stop" as a cancel, not as an answer', () => {
    const h = blockedOnGate();
    h.hear('stop.', 9000, 9400);
    h.delegate('d2', 9500);
    h.settle();
    h.probe();
    expect(h.agent.answers).toEqual([]);
    expect(h.agent.stops).toBe(1);
  });

  it('the heartbeat stays quiet while the agent is blocked', () => {
    const h = harness({ heartbeatMs: 5000 });
    h.started();
    h.hear('push the branch.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('push the branch.');
    h.agent.frame(GATE_FRAME);
    const before = h.commentary().length;
    h.clock.advance(60_000);
    // "Still working on it" over an unanswered question reads as a session that
    // is not listening.
    expect(h.commentary().slice(before).join(' ')).not.toMatch(/still working/i);
  });
});

// ═══ A PANE THAT CANNOT ANSWER ALOUD MUST NOT KEEP BILLING ═══
//
// `speak`/`speak-delta` live inside the `reply` tool and nowhere else. Two
// panes will never send one: a pane switched Agent→Chat mid-session (its
// `mcpServers` were fixed when `query()` was constructed and the tool cannot be
// added afterwards, while the mic appears the moment the pane row flips), and a
// pane whose RUNNER PROCESS predates `reply` shipping — runners live for weeks,
// so that is not a migration edge, it is the normal state of a long-lived pane.
//
// Both delegate, work and finish correctly, and say NOTHING. The user hears the
// model's "on it" and then silence; the answer appears in the chat, so nothing
// looks broken; and the session bills to its ten-minute ceiling. Total, silent,
// and indistinguishable from a slow agent — the most expensive failure shape
// this feature has.
describe('a runner with no voice at all', () => {
  /** Delegate one request and let the turn finish successfully. `reply` decides
   *  whether anything is said. */
  const oneTurn = (h: ReturnType<typeof harness>, request: string, reply?: string) => {
    h.hear(request, h.clock.t + 1000, h.clock.t + 2000);
    h.delegate(`d-${request.length}-${h.clock.t}`, h.clock.t + 2100);
    h.settle();
    h.turnStart(request);
    if (reply !== undefined)
      h.agent.frame({ t: 'speak', id: `r-${reply.length}`, text: reply, n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
  };

  it('says what is wrong out loud when a successful turn produces no answer', () => {
    const h = harness();
    h.started();
    oneTurn(h, 'run the tests.');
    const said = h.commentary().join('\n');
    // Not a console warning: the user is holding a phone, not watching a log.
    expect(said).toMatch(/cannot send its answers to voice/i);
    expect(said).toMatch(/written in the chat/i);
  });

  it('then hangs up, because every later request would end the same way', () => {
    const h = harness();
    h.started();
    oneTurn(h, 'run the tests.');
    // Not instantly — the explanation has to be spoken before the peer
    // connection goes, or the warning is as silent as the bug.
    expect(h.states.at(-1)).not.toBe('ended');
    h.clock.advance(MUTE_RUNNER_GRACE_MS + 10);
    expect(h.states.at(-1)).toBe('ended');
    expect(h.details.at(-1)).toBe(MUTE_RUNNER_DETAIL);
  });

  it('says it once, however many turns follow', () => {
    const h = harness();
    h.started();
    oneTurn(h, 'run the tests.');
    const after = h.commentary().length;
    oneTurn(h, 'now lint it.');
    const again = h.commentary().slice(after).join('\n');
    expect(again).not.toMatch(/cannot send its answers to voice/i);
  });
});

describe('a runner that CAN speak is never hung up on', () => {
  const oneTurn = (h: ReturnType<typeof harness>, request: string, reply?: string) => {
    h.hear(request, h.clock.t + 1000, h.clock.t + 2000);
    h.delegate(`d-${request.length}-${h.clock.t}`, h.clock.t + 2100);
    h.settle();
    h.turnStart(request);
    if (reply !== undefined)
      h.agent.frame({ t: 'speak', id: `r-${reply.length}`, text: reply, n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
  };

  it('a turn that answered is not evidence of anything', () => {
    const h = harness();
    h.started();
    oneTurn(h, 'run the tests.', 'They all pass.');
    h.clock.advance(MUTE_RUNNER_GRACE_MS + 10);
    expect(h.commentary().join('\n')).not.toMatch(/cannot send its answers/i);
    expect(h.states).not.toContain('ended');
  });

  // THE LATCH IS A LIFETIME LATCH, and this is why. An agent that has answered
  // ten times and then finishes a turn without calling `reply` is an agent
  // being quiet, not an agent that cannot speak. Hanging the call up there
  // would be a far more annoying bug than the one being fixed.
  it('a quiet turn AFTER a spoken one is just a quiet turn', () => {
    const h = harness();
    h.started();
    oneTurn(h, 'run the tests.', 'They all pass.');
    oneTurn(h, 'now lint it.');
    h.clock.advance(MUTE_RUNNER_GRACE_MS + 10);
    expect(h.commentary().join('\n')).not.toMatch(/cannot send its answers/i);
    expect(h.states).not.toContain('ended');
  });

  it('a FAILED turn explains itself already — that silence is accounted for', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    h.agent.frame({ t: 'turn-done', ok: false, error: 'the runner died' });
    h.clock.advance(MUTE_RUNNER_GRACE_MS + 10);
    expect(h.commentary().join('\n')).toMatch(/turn failed/i);
    expect(h.commentary().join('\n')).not.toMatch(/cannot send its answers/i);
    expect(h.states).not.toContain('ended');
  });

  it('a CANCELLED task was silent because the user silenced it', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    h.hear('stop.', 5000, 5400);
    h.delegate('d2', 5500);
    h.settle();
    h.probe();
    h.agent.frame({ t: 'turn-done', ok: true });
    h.clock.advance(MUTE_RUNNER_GRACE_MS + 10);
    expect(h.commentary().join('\n')).not.toMatch(/cannot send its answers/i);
  });
});

// ═══ THE PROBE WAS JUDGING A SENTENCE THAT WAS STILL BEING SAID ═══
//
// Two windows decide whether "stop" is a cancel, and they were ordered the
// wrong way round:
//
//   · transcript.ts glues a delta onto the OPEN utterance while the gap is
//     ≤ GAP_MS (1200ms), measured on the SPEECH clock the API stamps.
//   · session.ts judged that utterance after CANCEL_PROBE_QUIET_MS (900ms) of
//     quiet, measured on the ARRIVAL clock — `sched.now()`.
//
// So there was a 300ms band, by construction, in which the probe ruled on a
// segment the buffer was still filling. And the two clocks are not the same
// one: realtime ASR batches on its own VAD cadence and the network adds
// jitter, so a 400ms speech gap routinely arrives as a 950ms arrival gap.
//
// The comment on the constant claimed the opposite — that sitting BELOW the
// gluing window meant "the sentence is as finished as this protocol can tell
// us". It is exactly backwards: to judge a finished utterance you must wait
// LONGER than the window in which it can still grow, not shorter.
//
// The cost of being wrong here is the one this whole module exists to avoid:
// minutes of real agent work destroyed, plus a durable interrupted notice, on
// a sentence that was never a cancel.
describe('a cancel is judged only once the sentence has stopped growing', () => {
  const runningTurn = () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    return h;
  };

  it('"stop … the dev server" is a task, even across a one-second hesitation', () => {
    const h = runningTurn();
    const at = h.clock.t;
    h.hear('stop', at + 10_000, at + 10_400);
    // One second of ARRIVAL quiet: past the old 900ms probe, and well inside
    // the 1200ms SPEECH gap the segmenter will still glue across.
    h.clock.advance(1000);
    expect(h.agent.stops).toBe(0);

    h.hear(' the dev server', at + 10_800, at + 11_600);
    h.probe();
    expect(h.agent.stops).toBe(0);
    expect(h.session.stats.cancels ?? 0).toBe(0);
  });

  it('the probe window is strictly longer than the window the text can grow in', () => {
    // Stated as an assertion rather than a comment, because the bug was the two
    // constants drifting into the wrong order with nothing to notice.
    expect(CANCEL_PROBE_QUIET_MS).toBeGreaterThan(GAP_MS);
  });

  it('a bare "stop" still cancels once it has actually finished', () => {
    const h = runningTurn();
    const at = h.clock.t;
    h.hear('stop', at + 10_000, at + 10_400);
    h.probe();
    expect(h.agent.stops).toBe(1);
  });
});

// ═══ SAYING "STOP" AGAIN MADE "STOP" STOP WORKING ═══
//
// The debounce exists because a cancel reaches us twice BY DESIGN — once when
// the model delegates it, once from the transcript backstop a beat later — and
// the user should hear "Stopped." once, not twice.
//
// But the timestamp was stamped on every call, including the SUPPRESSED ones.
// So each repeat pushed the window forward by its own arrival, and a user
// saying "stop" every three seconds — which is exactly what someone does when
// an agent is not dying fast enough — held the window open indefinitely.
//
// The consequence is not "the second stop is ignored", which would be fine. It
// is that `cancel()` returns before `agent.stop()` and before the queue-cancel,
// so NEW work dispatched during that period is uncancellable too. And the
// suppressed branch says nothing aloud, so the user hears silence and assumes
// it landed.
describe('the cancel debounce measures from the cancel that actually fired', () => {
  it('a repeated "stop" does not hold the window open forever', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');

    /** Say it, and run past the probe so the backstop rules on it. */
    const say = () => {
      const at = h.clock.t;
      h.hear('stop.', at + 100, at + 600);
      h.probe();
      // Cancelling clears `turnRunning`, and the backstop declines to judge
      // anything when nothing is running. A cooperative stop takes a moment to
      // land and the server starts the next turn regardless, so put one back.
      h.turnStart();
    };

    say();
    expect(h.agent.stops).toBe(1);
    const firedAt = h.clock.t - 50; // the probe overshoots the timer by 50ms

    // An impatient repeat, LATE in the window. Correctly suppressed — and,
    // under the bug, it re-stamps, moving the window's origin to itself.
    h.clock.advance(1900);
    say();
    expect(h.agent.stops).toBe(1);

    // And now, comfortably past four seconds from the cancel that actually
    // fired — but less than four seconds from the one that was suppressed.
    h.clock.advance(600);
    say();
    expect(h.clock.t - firedAt).toBeGreaterThan(CANCEL_DEBOUNCE_MS);
    expect(h.agent.stops).toBe(2);
  });

  it('still says "Stopped." exactly once for the two doors of one cancel', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.turnStart('run the tests.');
    const at = h.clock.t;
    h.hear('stop.', at + 100, at + 600);
    h.probe();
    // The model's half, arriving a beat later through the same door the
    // delegation uses.
    h.delegate('d2', h.clock.t + 100);
    h.settle();
    expect(h.agent.stops).toBe(1);
    expect(h.commentary().filter((t) => /stopped\./i.test(t))).toHaveLength(1);
  });
});
