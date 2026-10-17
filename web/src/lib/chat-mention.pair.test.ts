import { describe, expect, it } from 'vitest';
import { type LogEntry, threadSpawnPairs } from './chat-mention';

/**
 * THE KEY THAT LETS TWO ENDS FIND EACH OTHER.
 *
 * `threadSpawnPairs` already drew a stub on each end of a split pair. A stub
 * says a pair EXISTS; it cannot say which of the cards across a screenful of
 * log is the partner, and on a fan-out there are several candidates in both
 * directions. The same key now rides both ends so a hover can light the other.
 */
type Card = {
  kind: 'launch' | 'completion';
  chat: { tabId: string };
  round?: { id: string };
};
const entry = (c: Card, openedAt?: number): LogEntry<unknown> =>
  ({ kind: 'card', card: c, ...(openedAt !== undefined ? { openedAt } : {}) }) as never;

const launch = (tabId: string, round?: string) =>
  entry({ kind: 'launch', chat: { tabId }, ...(round ? { round: { id: round } } : {}) });
const done = (tabId: string, round?: string) =>
  entry({ kind: 'completion', chat: { tabId }, ...(round ? { round: { id: round } } : {}) });

const pairs = (l: readonly LogEntry<unknown>[]) =>
  threadSpawnPairs(l).map((x) => (x.kind === 'card' ? [x.thread, x.pair] : null));

describe('a split pair carries one key on both ends', () => {
  it('gives the two ends the SAME key', () => {
    const out = pairs([launch('t1'), done('t1')]);
    expect(out[0]?.[0]).toBe('open');
    expect(out[1]?.[0]).toBe('close');
    expect(out[0]?.[1]).toBe(out[1]?.[1]);
    expect(out[0]?.[1]).toBeTruthy();
  });

  it('gives DIFFERENT workers different keys — a fan-out is the whole point', () => {
    // Four cards, two pairs, interleaved exactly as a batch delivery lands
    // them. If the key were per-position rather than per-worker, hovering one
    // would light the wrong partner, which is worse than lighting none.
    const out = pairs([launch('t1'), launch('t2'), done('t1'), done('t2')]);
    expect(out[0]?.[1]).toBe(out[2]?.[1]);
    expect(out[1]?.[1]).toBe(out[3]?.[1]);
    expect(out[0]?.[1]).not.toBe(out[1]?.[1]);
  });

  it('separates two ROUNDS of the same worker', () => {
    // The same tab spawned twice has two launches and two completions, and the
    // tab id alone cannot tell them apart.
    const out = pairs([launch('t1', 'r1'), done('t1', 'r1'), launch('t1', 'r2'), done('t1', 'r2')]);
    expect(out[0]?.[1]).toBe(out[1]?.[1]);
    expect(out[2]?.[1]).toBe(out[3]?.[1]);
    expect(out[0]?.[1]).not.toBe(out[2]?.[1]);
  });

  it('a launch with no completion gets NEITHER — no key, no stub', () => {
    // Still running, or its completion has not loaded. A key with one end is a
    // key for nothing, and a stub is a line to nowhere.
    const out = pairs([launch('t1'), done('t2'), launch('t2')]);
    expect(out[0]).toEqual([undefined, undefined]);
  });

  it('a COLLAPSED pair gets neither — it is one card, not two ends', () => {
    const out = pairs([launch('t1'), entry({ kind: 'completion', chat: { tabId: 't1' } }, 5)]);
    expect(out[1]).toEqual([undefined, undefined]);
  });
});
