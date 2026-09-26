import { describe, expect, it } from 'vitest';
import {
  type ChatChipChat,
  DECAY_DAYS,
  chatClock,
  chatTooltip,
  childDot,
  isChatDone,
} from './ChatChip';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/** A chat whose clock started `days` ago. */
const aged = (days: number, extra: Partial<ChatChipChat> = {}): ChatChipChat => ({
  name: 'chat',
  clock_started_at: NOW - days * DAY,
  ...extra,
});

describe('chatClock', () => {
  it('starts clean — a fresh chat has no fill at all', () => {
    const c = chatClock(aged(0), NOW);
    expect(c).toEqual({ phase: 'fresh', daysLeft: 4, fill: 0 });
  });

  // The whole visual language: 25 / 50 / 75 as the days pass. These four
  // numbers are the spec, so they are asserted as numbers and not as a shape.
  it('fills from the top in quarter steps as the days pass', () => {
    expect(chatClock(aged(1), NOW).fill).toBe(25);
    expect(chatClock(aged(2), NOW).fill).toBe(50);
    // Day 3 is the last day — the tile is spent, so it reports no fill and
    // hands over to the dashed outline. 75% is never drawn on a tile that is
    // about to stop being one.
    expect(chatClock(aged(3), NOW).phase).toBe('last-day');
    expect(chatClock(aged(3), NOW).fill).toBe(0);
  });

  it('quantises to whole days — a fill does not creep between them', () => {
    expect(chatClock(aged(1), NOW).fill).toBe(25);
    // 23h59m later: still day one, still 25%.
    expect(chatClock({ ...aged(1), clock_started_at: NOW - DAY - 1 }, NOW).fill).toBe(25);
    expect(chatClock({ ...aged(1), clock_started_at: NOW - 2 * DAY + 1 }, NOW).fill).toBe(25);
  });

  it('crosses into done when the clock runs out', () => {
    expect(chatClock(aged(DECAY_DAYS), NOW).phase).toBe('done');
    expect(chatClock(aged(99), NOW).daysLeft).toBe(0);
    expect(isChatDone(aged(DECAY_DAYS), NOW)).toBe(true);
    expect(isChatDone(aged(2), NOW)).toBe(false);
  });

  it('takes the SERVER’s done verdict over its own arithmetic', () => {
    // Lifecycle is decided server-side; the client only draws it. A young chat
    // the server calls done is done.
    expect(chatClock(aged(0, { done: true }), NOW).phase).toBe('done');
    // …and an old one the server still calls live is NOT swept away.
    expect(chatClock(aged(99, { done: false }), NOW).phase).not.toBe('done');
  });

  it('never fills a pinned chat, however old', () => {
    const c = chatClock(aged(99, { pinned: true }), NOW);
    expect(c).toEqual({ phase: 'pinned', daysLeft: DECAY_DAYS, fill: 0 });
    expect(isChatDone(aged(99, { pinned: true }), NOW)).toBe(false);
  });

  it('falls back to last_activity_at, then to now, for rows with no clock', () => {
    expect(chatClock({ name: 'x', last_activity_at: NOW - 2 * DAY }, NOW).fill).toBe(50);
    // No clock columns at all (a server that predates them): treat it as fresh
    // rather than as instantly done.
    expect(chatClock({ name: 'x' }, NOW).phase).toBe('fresh');
  });

  it('clamps a clock that starts in the future', () => {
    expect(chatClock({ name: 'x', clock_started_at: NOW + 5 * DAY }, NOW)).toEqual({
      phase: 'fresh',
      daysLeft: 4,
      fill: 0,
    });
  });
});

describe('childDot', () => {
  it('fades as the parent ages, then hollows out on the last day', () => {
    expect(childDot(chatClock(aged(0), NOW))).toEqual({ hollow: false, opacity: 0.85 });
    expect(childDot(chatClock(aged(1), NOW))).toEqual({ hollow: false, opacity: 0.71 });
    // 0.575 → 0.57, not 0.58: toFixed rounds the float's actual value, and the
    // prototype does exactly the same thing. Kept identical on purpose.
    expect(childDot(chatClock(aged(2), NOW))).toEqual({ hollow: false, opacity: 0.57 });
    expect(childDot(chatClock(aged(3), NOW))).toEqual({ hollow: true, opacity: 0.85 });
    expect(childDot(chatClock(aged(9), NOW))).toEqual({ hollow: true, opacity: 0.85 });
  });

  it('holds a pinned parent at full presence', () => {
    expect(childDot(chatClock(aged(99, { pinned: true }), NOW))).toEqual({
      hollow: false,
      opacity: 0.85,
    });
  });
});

describe('chatTooltip', () => {
  // The row is one line — name only. The headline is NOT deleted, it moves
  // here, and this test is what stops it being dropped on the floor.
  it('carries the headline the one-line row no longer shows', () => {
    const t = chatTooltip(
      { ...aged(1), name: 'muxpad', headline: 'wiring the decay indicator' },
      NOW,
    );
    expect(t).toContain('muxpad');
    expect(t).toContain('wiring the decay indicator');
    expect(t).toContain('3d left');
  });

  it('says where the clock stands when there is no headline', () => {
    expect(chatTooltip({ ...aged(0), name: 'Main' }, NOW)).toBe('Main · 4d left');
    expect(chatTooltip({ ...aged(3), name: 'Main' }, NOW)).toBe('Main · last day');
    expect(chatTooltip({ ...aged(9), name: 'Main' }, NOW)).toBe('Main · done');
    expect(chatTooltip({ ...aged(9), name: 'Main', pinned: true }, NOW)).toBe('Main · pinned');
  });
});
