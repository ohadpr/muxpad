import { describe, expect, it } from 'vitest';
import { DIRECTED_WAIT_MS, directedIsStale } from './chat-directed';

/**
 * How long a directed card lives at the foot of the chat.
 *
 * The strip holds work IN FLIGHT. Two ways a card stops being that, and they
 * end differently: a card that got its ANSWER leaves (the answer is a real
 * message in the transcript — reported as "still have this weird thing fixed at
 * the bottom"), and a card nothing ever answered STAYS, because it is the only
 * record the request was made at all.
 */
describe('a directed card is in-flight only', () => {
  const now = 1_800_000_000_000;

  it('spins while the answer could still come', () => {
    expect(directedIsStale({ at: now - 60_000 }, now)).toBe(false);
    expect(directedIsStale({ at: now - DIRECTED_WAIT_MS + 1_000 }, now)).toBe(false);
  });

  it('gives up once nothing is coming', () => {
    // The answer is a MODEL doing as it was asked — busy, confused, crashed, or
    // answering in prose without the marker all leave it spinning forever.
    expect(directedIsStale({ at: now - DIRECTED_WAIT_MS - 1_000 }, now)).toBe(true);
  });

  it('an ANSWERED card is never stale, however old', () => {
    // It is not waiting, so it cannot have given up — and it leaves the strip
    // entirely, which is a separate decision made where it is rendered.
    expect(directedIsStale({ at: 0, reportedAt: 1 }, now)).toBe(false);
  });

  it('waits long enough to be past any real answer', () => {
    // Short enough not to leave furniture all day, long enough that a slow
    // chat is not written off mid-thought.
    expect(DIRECTED_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(DIRECTED_WAIT_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
