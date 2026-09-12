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
  DISPATCH_FILLER_MS,
  SETTLE_MAX_MS,
  SETTLE_QUIET_MS,
  type Scheduler,
  VoiceSession,
  type VoiceUiState,
} from './session';
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
  frame(f: unknown): void;
  online: boolean;
}

function fakeAgent(): FakeAgent {
  const cbs = new Set<(raw: unknown) => void>();
  const a: FakeAgent = {
    sends: [],
    stops: 0,
    online: true,
    send(text) {
      if (!a.online) return false;
      a.sends.push(text);
      return true;
    },
    stop() {
      a.stops += 1;
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
    onProtocolError?: (line: string) => void;
  } = {},
) {
  const clock = new FakeClock();
  const transport = fakeTransport();
  const agent = fakeAgent();
  const states: VoiceUiState[] = [];
  const session = new VoiceSession({
    transport,
    agent,
    scheduler: clock,
    onState: (s) => states.push(s),
    withContext: opts.withContext ?? false,
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

  return {
    clock,
    transport,
    agent,
    session,
    states,
    started,
    hear,
    speaks,
    delegate,
    commentary,
    thinking,
    /** Run past the settle window. */
    settle: () => clock.advance(SETTLE_QUIET_MS + SETTLE_MAX_MS + 10),
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

describe('stale results are dropped, not spoken', () => {
  it('a superseded delegation is never dispatched', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    // The user changes their mind inside the settle window.
    h.clock.advance(100);
    h.hear('actually, check the router instead.', 4000, 5500);
    h.delegate('d2', 5600);
    h.settle();
    // The abandoned request never reaches the agent at all — it is not merely
    // dropped on the way back, it is never asked.
    expect(h.agent.sends).toEqual(['actually, check the router instead.']);
    expect(h.session.stats.requestsDispatched).toBe(1);
    expect(h.session.stats.delegationsClaimed).toBe(2);
  });

  it('stops the running agent turn when a new delegation supersedes it', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('no wait, do the other thing.', 6000, 7500);
    h.delegate('d2', 7600);
    expect(h.agent.stops).toBe(1);
  });

  it('a late reply from the superseded turn is NOT spoken', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('no wait, check the router.', 6000, 7500);
    h.delegate('d2', 7600);
    h.settle();
    const before = h.commentary().length;
    // The abandoned turn finally answers — the reply to a question the user
    // already withdrew. Speaking it under d2 would answer the NEW question
    // with the OLD answer, confidently.
    h.agent.frame({ t: 'speak', id: 'r-old', text: 'The tests all pass.', n: 1 });
    h.agent.frame({ t: 'turn-done', ok: true });
    expect(h.commentary().slice(before).join(' ')).not.toContain('The tests all pass.');
    expect(h.session.stats.staleDrops).toBeGreaterThan(0);
  });

  it('the superseded turn ending does NOT close the new delegation', () => {
    const h = harness();
    h.started();
    h.hear('run the tests.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('no wait, check the router.', 6000, 7500);
    h.delegate('d2', 7600);
    h.settle();
    // The old turn dies from our `{t:'stop'}`.
    h.agent.frame({ t: 'turn-done', ok: true });
    // d2's own turn starts and answers — and IS spoken.
    h.agent.frame({ t: 'turn-start' });
    h.agent.frame({ t: 'speak', id: 'r-new', text: 'The router looks fine.', n: 1 });
    expect(h.commentary().join(' ')).toContain('The router looks fine.');
  });

  it('the heartbeat stops firing once its delegation is stale', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.clock.advance(30_000);
    const beats = h.commentary().filter((t) => t.includes('Still working')).length;
    expect(beats).toBeGreaterThan(0);
    h.agent.frame({ t: 'turn-done', ok: true });
    h.clock.advance(120_000);
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBe(beats);
  });
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

describe('barge-in', () => {
  it('stops a running turn when the user talks over it', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('stop, do something else instead', 10_000, 12_000);
    expect(h.agent.stops).toBe(1);
  });

  it('fires once per utterance, not once per delta', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('stop stop stop', 10_000, 12_000);
    h.hear(' and also this', 12_000, 13_000);
    h.hear(' and this too', 13_000, 14_000);
    expect(h.agent.stops).toBe(1);
  });

  it('does NOT fire on a sub-300ms blip', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('mm', 10_000, 10_120);
    expect(h.agent.stops).toBe(0);
  });

  it('does NOT fire on the model’s own echo coming back through the mic', () => {
    const h = harness();
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.speaks('On it, this will take a while.', 8000, 10_000);
    // Echo, transcribed 100ms after the model stopped.
    h.hear('on it this will take a while', 10_100, 11_500);
    expect(h.agent.stops).toBe(0);
  });

  it('does not fire when no turn is running — there is nothing to interrupt', () => {
    const h = harness();
    h.started();
    h.hear('just chatting, no agent involved', 1000, 3000);
    expect(h.agent.stops).toBe(0);
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
  it('a wide-open gate lets a short utterance barge in', () => {
    const h = harness({ micGate: new MicGate({ minUtteranceMs: 1, postPlaybackMs: 0 }) });
    h.started();
    h.hear('do a long thing.', 1000, 2000);
    h.delegate('d1', 2100);
    h.settle();
    h.agent.frame({ t: 'turn-start' });
    h.hear('no', 10_000, 10_050);
    expect(h.agent.stops).toBe(1);
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
    h.agent.frame({ t: 'turn-start' });
    h.clock.advance(60_000);
    expect(h.commentary().filter((t) => t.includes('Still working')).length).toBeGreaterThan(0);
    expect(h.thinking().filter((t) => t.includes('Still working'))).toEqual([]);
  });
});
