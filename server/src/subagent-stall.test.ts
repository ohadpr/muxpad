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

  it('trusts the runner`s seenAt over our own stamp', () => {
    // Our stamp is old (we have not seen the payload change), but the runner
    // reports recent real activity: a long silent tool call. Keep the row.
    const subagents = new Map([['a', p({ toolUseId: 'a', seenAt: T0 + 59 * 60_000 })]]);
    const changed = new Map([['a', T0]]);
    expect(reapStalledEntries(subagents, changed, T0 + 60 * 60_000)).toEqual([]);
  });

  it('reaps an entry whose seenAt is past the window', () => {
    const subagents = new Map([['a', p({ toolUseId: 'a', seenAt: T0 })]]);
    const changed = new Map<string, number>();
    expect(reapStalledEntries(subagents, changed, T0 + SUBAGENT_STALL_MS + 1)).toEqual(['a']);
    expect(subagents.size).toBe(0);
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

  it('reaping a row whose seenAt is frozen does not re-arm on its own echo', () => {
    // The keepalive-era shape specifically: `seenAt` IS present but frozen, so
    // the freshness check would reap it again every single sweep.
    const frozen = p({ toolUseId: 'g', steps: 9, seenAt: T0 });
    const subagents = new Map([['g', frozen]]);
    const reaped = new Map<string, SubagentProgress>();
    const now = T0 + SUBAGENT_STALL_MS + 1;

    expect(reapStalledEntries(subagents, new Map(), now, reaped)).toEqual(['g']);
    expect(isMaterialProgress(reaped.get('g'), keepaliveEcho(frozen))).toBe(false);
  });
});
