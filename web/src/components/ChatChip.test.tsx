import { CHAT_DECAY_DAYS, chatClock } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { type ChatChipChat, chatTooltip, childDot, chipClock, isChatDone } from './ChatChip';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/**
 * A chat whose clock started `days` ago, with the clock built by the SERVER's
 * own deriver rather than hand-written. That is the point of these fixtures:
 * if the server's curve changes, these tests see the change instead of
 * agreeing with a stale copy of it.
 */
const aged = (days: number, extra: Partial<ChatChipChat> = {}): ChatChipChat => {
  const started_at = NOW - days * DAY;
  const pinned = extra.pinned === true;
  return {
    name: 'chat',
    clock: chatClock({ started_at, now: NOW, pinned }),
    done: !pinned && days >= CHAT_DECAY_DAYS,
    ...extra,
  };
};

describe('chipClock', () => {
  it('starts clean — a fresh chat has no fill at all', () => {
    expect(chipClock(aged(0), NOW)).toEqual({ phase: 'fresh', daysLeft: 4, fill: 0 });
  });

  // The whole visual language: the tile fills in quarter steps as the days
  // pass. These numbers ARE the spec, so they are asserted as numbers.
  it('quantises the server’s continuous fill into quarter steps', () => {
    expect(chipClock(aged(1), NOW).fill).toBe(25);
    expect(chipClock(aged(2), NOW).fill).toBe(50);
    // Day 3 is the final day — the tile stops being a tile and hands over to
    // the dashed outline, so it reports no fill. 75% is never drawn.
    expect(chipClock(aged(3), NOW).phase).toBe('last-day');
    expect(chipClock(aged(3), NOW).fill).toBe(0);
  });

  it('holds a step for the whole day rather than creeping through it', () => {
    // The server's fill is continuous; the chip's is not. Three readings
    // spread across one day must all draw the same tile.
    expect(chipClock(aged(1), NOW).fill).toBe(25);
    expect(chipClock(aged(1.01), NOW).fill).toBe(25);
    expect(chipClock(aged(1.99), NOW).fill).toBe(25);
    expect(chipClock(aged(2), NOW).fill).toBe(50);
  });

  it('crosses into done when the clock runs out', () => {
    expect(chipClock(aged(CHAT_DECAY_DAYS), NOW).phase).toBe('done');
    expect(isChatDone(aged(CHAT_DECAY_DAYS), NOW)).toBe(true);
    expect(isChatDone(aged(2), NOW)).toBe(false);
  });

  it('takes the SERVER’s done verdict over its own arithmetic', () => {
    // Lifecycle is decided server-side and the client only draws it. A young
    // chat the server calls done is done…
    expect(chipClock(aged(0, { done: true }), NOW).phase).toBe('done');
    expect(isChatDone(aged(0, { done: true }), NOW)).toBe(true);
    // …and an expired one the server still calls live is NOT swept away.
    expect(isChatDone(aged(9, { done: false }), NOW)).toBe(false);
    expect(chipClock(aged(9, { done: false }), NOW).phase).not.toBe('done');
  });

  it('never fills a pinned chat, however old — the clock is stopped', () => {
    const pinnedOld = aged(99, { pinned: true });
    expect(pinnedOld.clock?.stopped).toBe(true);
    expect(chipClock(pinnedOld, NOW)).toEqual({ phase: 'pinned', daysLeft: 4, fill: 0 });
    expect(isChatDone(pinnedOld, NOW)).toBe(false);
  });

  describe('rows with no published clock (a server that predates the column)', () => {
    it('derives the same four steps from last_activity_at', () => {
      expect(chipClock({ name: 'x', last_activity_at: NOW - 2 * DAY }, NOW).fill).toBe(50);
      expect(chipClock({ name: 'x', last_activity_at: NOW - 3 * DAY }, NOW).phase).toBe('last-day');
    });

    it('reads a row with no timestamp at all as fresh, not as instantly done', () => {
      expect(chipClock({ name: 'x' }, NOW).phase).toBe('fresh');
      expect(isChatDone({ name: 'x' }, NOW)).toBe(false);
    });
  });
});

describe('childDot', () => {
  it('fades as the parent ages, then hollows out on the last day', () => {
    expect(childDot(chipClock(aged(0), NOW))).toEqual({ hollow: false, opacity: 0.85 });
    expect(childDot(chipClock(aged(1), NOW))).toEqual({ hollow: false, opacity: 0.71 });
    // 0.575 → 0.57, not 0.58: toFixed rounds the float's actual value, and the
    // prototype does exactly the same thing. Kept identical on purpose.
    expect(childDot(chipClock(aged(2), NOW))).toEqual({ hollow: false, opacity: 0.57 });
    expect(childDot(chipClock(aged(3), NOW))).toEqual({ hollow: true, opacity: 0.85 });
    expect(childDot(chipClock(aged(9), NOW))).toEqual({ hollow: true, opacity: 0.85 });
  });

  it('holds a pinned parent at full presence', () => {
    expect(childDot(chipClock(aged(99, { pinned: true }), NOW))).toEqual({
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
    // pinned goes through `aged`, not spread over its result: the clock has to
    // be BUILT stopped, the way the server builds it.
    expect(chatTooltip({ ...aged(9, { pinned: true }), name: 'Main' }, NOW)).toBe('Main · pinned');
  });
});
