import { describe, expect, it } from 'vitest';
import { CHAT_DECAY_MS, DAY_MS, chatClock, chatClockDone } from './chat-clock.js';

const T0 = 1_800_000_000_000;

describe('chatClock', () => {
  it('is fresh at the moment it starts', () => {
    const c = chatClock({ started_at: T0, now: T0, pinned: false });
    expect(c.fill).toBe(0);
    expect(c.last_day).toBe(false);
    expect(c.stopped).toBe(false);
    expect(c.expires_at).toBe(T0 + CHAT_DECAY_MS);
    expect(chatClockDone(c, T0)).toBe(false);
  });

  it('fills a quarter per day', () => {
    // The prototype's chip buries the emoji from the top as the days pass;
    // this is the number that height comes from.
    for (const [days, fill] of [
      [0, 0],
      [1, 0.25],
      [2, 0.5],
      [3, 0.75],
    ] as const) {
      const c = chatClock({ started_at: T0, now: T0 + days * DAY_MS, pinned: false });
      expect(c.fill).toBeCloseTo(fill, 6);
    }
  });

  it('enters the last day exactly one day before expiry, and stays there', () => {
    const justBefore = chatClock({ started_at: T0, now: T0 + 3 * DAY_MS - 1, pinned: false });
    expect(justBefore.last_day).toBe(false);
    const onTheBoundary = chatClock({ started_at: T0, now: T0 + 3 * DAY_MS, pinned: false });
    expect(onTheBoundary.last_day).toBe(true);
    const nearlyGone = chatClock({ started_at: T0, now: T0 + 4 * DAY_MS - 1, pinned: false });
    expect(nearlyGone.last_day).toBe(true);
  });

  it('is done the instant it expires, not a moment before', () => {
    const c = chatClock({ started_at: T0, now: T0, pinned: false });
    expect(chatClockDone(c, T0 + CHAT_DECAY_MS - 1)).toBe(false);
    expect(chatClockDone(c, T0 + CHAT_DECAY_MS)).toBe(true);
  });

  it('clamps fill rather than running past 1', () => {
    const c = chatClock({ started_at: T0, now: T0 + 40 * DAY_MS, pinned: false });
    expect(c.fill).toBe(1);
  });

  it('clamps fill at 0 for a clock stamped in the future', () => {
    // Clock skew between devices, or a restore that moved the wall clock back.
    // A negative fill would render as a tile drawn upside down.
    const c = chatClock({ started_at: T0, now: T0 - DAY_MS, pinned: false });
    expect(c.fill).toBe(0);
  });

  it('a pinned chat has no cover, no expiry, and can never be done', () => {
    const c = chatClock({ started_at: T0, now: T0 + 400 * DAY_MS, pinned: true });
    expect(c.stopped).toBe(true);
    expect(c.fill).toBe(0);
    expect(c.last_day).toBe(false);
    expect(c.expires_at).toBeNull();
    expect(chatClockDone(c, T0 + 400 * DAY_MS)).toBe(false);
  });

  it('keeps the original start time when pinned, so unpinning resumes it', () => {
    // A pin that re-stamped the clock would silently hand back a full four
    // days on every unpin, which makes pinning a way to launder a dead chat.
    const c = chatClock({ started_at: T0, now: T0 + 3 * DAY_MS, pinned: true });
    expect(c.started_at).toBe(T0);
  });
});
