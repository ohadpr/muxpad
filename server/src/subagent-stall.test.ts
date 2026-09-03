import { describe, expect, it } from 'vitest';
import type { SubagentProgress } from '@muxpad/shared';
import { SUBAGENT_STALL_MS, isMaterialProgress, reapStalledEntries } from './ws.js';

const p = (over: Partial<SubagentProgress> & { toolUseId: string }): SubagentProgress => ({
  steps: 1,
  ...over,
});

const T0 = 1_700_000_000_000;

describe('isMaterialProgress', () => {
  it('a first sighting is always news', () => {
    expect(isMaterialProgress(undefined, p({ toolUseId: 'a' }))).toBe(true);
  });

  it('the keepalive re-announce is NOT news', () => {
    // This is the whole reason the stall clock keys on content and not on
    // arrival: every 5s the runner re-sends each live entry unchanged. If that
    // restarted the clock, a ghost would keep itself alive with the runner's
    // own heartbeat and nothing would ever be reaped.
    const prev = p({ toolUseId: 'a', steps: 3, lastTool: 'Bash: pnpm test', seenAt: T0 });
    expect(isMaterialProgress(prev, { ...prev })).toBe(false);
  });

  it('any advancing field is news', () => {
    const prev = p({ toolUseId: 'a', steps: 3, lastTool: 'Bash', label: 'audit', seenAt: T0 });
    expect(isMaterialProgress(prev, { ...prev, steps: 4 })).toBe(true);
    expect(isMaterialProgress(prev, { ...prev, lastTool: 'Read' })).toBe(true);
    expect(isMaterialProgress(prev, { ...prev, label: 'audit v2' })).toBe(true);
    expect(isMaterialProgress(prev, { ...prev, seenAt: T0 + 1 })).toBe(true);
  });
});

describe('reapStalledEntries', () => {
  it('keeps an entry whose runner says it was recently active', () => {
    const subagents = new Map([['a', p({ toolUseId: 'a', seenAt: T0 })]]);
    const changed = new Map<string, number>();
    expect(reapStalledEntries(subagents, changed, T0 + 60_000)).toEqual([]);
    expect(subagents.size).toBe(1);
  });

  it('NEVER touches a row from a runner that sends seenAt, however stale', () => {
    // The scope rule, and the most important test in this file. A runner new
    // enough to stamp `seenAt` ends its own subagents and knows things we
    // cannot see: which rows are parked behind a rate limit (hours), and that
    // silence may be one enormous tool call (`agent wait --timeout=3600` is a
    // thing this codebase does). Silence is not evidence at the server, so we
    // do not act on it. Reaping here would hide a LIVE agent's row and read
    // the pane as idle while real work runs.
    const parked = p({ toolUseId: 'a', steps: 3, seenAt: T0 });
    const subagents = new Map([['a', parked]]);
    const changed = new Map([['a', T0]]);
    const hoursLater = T0 + 6 * 60 * 60_000;
    expect(reapStalledEntries(subagents, changed, hoursLater)).toEqual([]);
    expect(subagents.size).toBe(1);
  });

  it('reaps a stalled pre-seenAt row on the same clock that spares a modern one', () => {
    // Same silence, same window, opposite verdicts — the ONLY difference is
    // whether the runner is capable of cleaning up after itself.
    const now = T0 + SUBAGENT_STALL_MS + 1;
    const old = new Map([['old', p({ toolUseId: 'old', steps: 2 })]]);
    const modern = new Map([['new', p({ toolUseId: 'new', steps: 2, seenAt: T0 })]]);
    expect(reapStalledEntries(old, new Map([['old', T0]]), now)).toEqual(['old']);
    expect(reapStalledEntries(modern, new Map([['new', T0]]), now)).toEqual([]);
  });

  it('reaps a pre-seenAt ghost on our own frozen-payload stamp', () => {
    // The population this exists for: a runner too old to send `seenAt`, whose
    // rows are re-announced verbatim every 5s forever. Only the server's own
    // "payload last changed" stamp can tell that nothing is happening.
    const subagents = new Map([['ghost', p({ toolUseId: 'ghost', steps: 12 })]]);
    const changed = new Map([['ghost', T0]]);
    expect(reapStalledEntries(subagents, changed, T0 + SUBAGENT_STALL_MS + 1)).toEqual(['ghost']);
    expect(changed.has('ghost')).toBe(false);
  });

  it('gives an unstamped entry a full window instead of reaping on sight', () => {
    const subagents = new Map([['a', p({ toolUseId: 'a' })]]);
    const changed = new Map<string, number>();
    const now = T0 + 10 * 24 * 60 * 60_000;
    expect(reapStalledEntries(subagents, changed, now)).toEqual([]);
    expect(changed.get('a')).toBe(now); // adopted, clock starts now
    expect(reapStalledEntries(subagents, changed, now + SUBAGENT_STALL_MS + 1)).toEqual(['a']);
  });

  it('reaps only the stalled rows, leaving live ones alone', () => {
    // The exact shape of the live pane that motivated this: some rows advancing,
    // some frozen, one process, one roster.
    const now = T0 + SUBAGENT_STALL_MS * 2;
    const subagents = new Map([
      ['live', p({ toolUseId: 'live', steps: 9, seenAt: now - 5_000 })],
      ['ghost1', p({ toolUseId: 'ghost1', steps: 2 })],
      ['ghost2', p({ toolUseId: 'ghost2', steps: 7 })],
    ]);
    const changed = new Map([
      ['live', now - 5_000],
      ['ghost1', T0],
      ['ghost2', T0],
    ]);
    expect(reapStalledEntries(subagents, changed, now).sort()).toEqual(['ghost1', 'ghost2']);
    expect([...subagents.keys()]).toEqual(['live']);
  });

  it('is not final: a reaped row returns the moment it reports again', () => {
    // Reaping unlists, it never kills. A false positive costs one tick.
    const subagents = new Map([['a', p({ toolUseId: 'a', steps: 4 })]]);
    const changed = new Map([['a', T0]]);
    reapStalledEntries(subagents, changed, T0 + SUBAGENT_STALL_MS + 1);
    expect(subagents.size).toBe(0);

    const back = p({ toolUseId: 'a', steps: 5 });
    expect(isMaterialProgress(subagents.get('a'), back)).toBe(true);
    subagents.set('a', back);
    expect(subagents.size).toBe(1);
  });

  it('an empty roster sweeps to nothing', () => {
    expect(reapStalledEntries(new Map(), new Map(), T0)).toEqual([]);
  });
});

describe('the reap must STICK against a live keepalive', () => {
  // The failure this guards: a keepalive-era runner re-announces its whole
  // roster every 5s and knows nothing about the server's decision to retire a
  // row. Without a tombstone the row returns within one tick, the next sweep
  // reaps it again, and the pane's count blinks forever while every chat client
  // takes a bogus `done` every minute.
  //
  // These tests drive the same sequence the frame handler implements, so they
  // fail if the suppression is removed from either side.
  const keepaliveEcho = (p: SubagentProgress): SubagentProgress => ({ ...p });

  it('a reaped row does NOT come back on the keepalive echo', () => {
    const ghost = p({ toolUseId: 'g', steps: 4, lastTool: 'Bash: sleep' });
    const subagents = new Map([['g', ghost]]);
    const changed = new Map([['g', T0]]);
    const reaped = new Map<string, SubagentProgress>();

    expect(reapStalledEntries(subagents, changed, T0 + SUBAGENT_STALL_MS + 1, reaped)).toEqual(['g']);
    expect(reaped.get('g')).toEqual(ghost); // tombstone captured the payload

    // Five seconds later the runner re-announces it, unchanged.
    const echo = keepaliveEcho(ghost);
    expect(isMaterialProgress(reaped.get('g'), echo)).toBe(false); // → handler ignores it
    expect(subagents.size).toBe(0);
  });

  it('but a row that resumes real work DOES come back', () => {
    const parked = p({ toolUseId: 'g', steps: 4 });
    const subagents = new Map([['g', parked]]);
    const changed = new Map([['g', T0]]);
    const reaped = new Map<string, SubagentProgress>();
    reapStalledEntries(subagents, changed, T0 + SUBAGENT_STALL_MS + 1, reaped);

    // It was only parked — a rate-limit hold, or one enormous tool call. Its
    // next step must lift the tombstone, or a live agent stays invisible.
    const resumed = p({ toolUseId: 'g', steps: 5, lastTool: 'Read' });
    expect(isMaterialProgress(reaped.get('g'), resumed)).toBe(true);
    reaped.delete('g');
    subagents.set('g', resumed);
    expect(subagents.size).toBe(1);
    expect(reaped.size).toBe(0);
  });

  it('a stalled row is reaped exactly once, not once per sweep', () => {
    const subagents = new Map([['g', p({ toolUseId: 'g', steps: 2 })]]);
    const changed = new Map([['g', T0]]);
    const reaped = new Map<string, SubagentProgress>();
    let now = T0 + SUBAGENT_STALL_MS + 1;

    expect(reapStalledEntries(subagents, changed, now, reaped)).toEqual(['g']);
    // Subsequent sweeps, with the runner still echoing (and the handler still
    // suppressing), must find nothing left to announce.
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      expect(reapStalledEntries(subagents, changed, now, reaped)).toEqual([]);
    }
  });

  it('the tombstone map is bounded, like every other roster map', () => {
    // A ghost never speaks again, so its tombstone is released by nothing and
    // would live as long as the connection — and connections live for weeks.
    const subagents = new Map<string, SubagentProgress>();
    const changed = new Map<string, number>();
    const reaped = new Map<string, SubagentProgress>();
    for (let i = 0; i < 100; i++) {
      subagents.set(`g${i}`, p({ toolUseId: `g${i}`, steps: 1 }));
      changed.set(`g${i}`, T0);
    }
    reapStalledEntries(subagents, changed, T0 + SUBAGENT_STALL_MS + 1, reaped);
    expect(subagents.size).toBe(0);
    expect(reaped.size).toBeLessThanOrEqual(32);
  });
});
