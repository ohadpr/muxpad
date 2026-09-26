import { CHAT_DECAY_DAYS, chatClock } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { type ChatChipChat, chatTooltip, chipClock, isChatDone, isChatRetired } from './ChatChip';

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
    expect(chipClock(aged(0))).toEqual({ phase: 'fresh', daysLeft: 4, fill: 0 });
  });

  // The whole visual language: the tile fills in quarter steps as the days
  // pass. These numbers ARE the spec, so they are asserted as numbers.
  it('quantises the server’s continuous fill into quarter steps', () => {
    expect(chipClock(aged(1)).fill).toBe(25);
    expect(chipClock(aged(2)).fill).toBe(50);
    // Day 3 is the final day — the tile stops being a tile and hands over to
    // the dashed outline, so it reports no fill. 75% is never drawn.
    expect(chipClock(aged(3)).phase).toBe('last-day');
    expect(chipClock(aged(3)).fill).toBe(0);
  });

  it('holds a step for the whole day rather than creeping through it', () => {
    // The server's fill is continuous; the chip's is not. Three readings
    // spread across one day must all draw the same tile.
    expect(chipClock(aged(1)).fill).toBe(25);
    expect(chipClock(aged(1.01)).fill).toBe(25);
    expect(chipClock(aged(1.99)).fill).toBe(25);
    expect(chipClock(aged(2)).fill).toBe(50);
  });

  it('crosses into done when the clock runs out', () => {
    expect(chipClock(aged(CHAT_DECAY_DAYS)).phase).toBe('done');
    expect(isChatDone(aged(CHAT_DECAY_DAYS))).toBe(true);
    expect(isChatDone(aged(2))).toBe(false);
  });

  it('takes the SERVER’s done verdict over its own arithmetic', () => {
    // Lifecycle is decided server-side and the client only draws it. A young
    // chat the server calls done is done…
    expect(chipClock(aged(0, { done: true })).phase).toBe('done');
    expect(isChatDone(aged(0, { done: true }))).toBe(true);
    // …and an expired one the server still calls live is NOT swept away.
    expect(isChatDone(aged(9, { done: false }))).toBe(false);
    expect(chipClock(aged(9, { done: false })).phase).not.toBe('done');
  });

  it('never fills a pinned chat, however old — the clock is stopped', () => {
    const pinnedOld = aged(99, { pinned: true });
    expect(pinnedOld.clock?.stopped).toBe(true);
    expect(chipClock(pinnedOld)).toEqual({ phase: 'pinned', daysLeft: 4, fill: 0 });
    expect(isChatDone(pinnedOld)).toBe(false);
  });

  // ─── ONE OWNER ───────────────────────────────────────────────────────────
  // The chip reads the published clock and derives NO lifecycle of its own.
  // These replaced a set that asserted a `last_activity_at` fallback — a second
  // implementation of the decay rules living in the client, which is the exact
  // bug shape muxpad has shipped three times (sidebar order vs the poll, the
  // status bar vs the roster, the agents counter vs spawned panes). Every one
  // was two surfaces deriving one value with no single owner.
  describe('derives no lifecycle of its own', () => {
    it('draws a clean tile when there is NO clock, and claims nothing', () => {
      // `null` (a sub-chat, which cannot decay) and `undefined` (not told) both
      // land here, and both must render as "nothing to report" rather than as a
      // guess in either direction.
      expect(chipClock({ name: 'x' })).toEqual({ phase: 'fresh', daysLeft: 4, fill: 0 });
      expect(chipClock({ name: 'x', clock: null })).toEqual({
        phase: 'fresh',
        daysLeft: 4,
        fill: 0,
      });
      expect(isChatDone({ name: 'x' })).toBe(false);
    });

    it('ignores a timestamp entirely — a clockless row never ages', () => {
      // `last_activity_at` is not even in the prop type any more; passing one
      // must not resurrect a countdown through some other path.
      const ancient = { name: 'x', last_activity_at: NOW - 99 * DAY } as ChatChipChat;
      expect(chipClock(ancient)).toEqual({ phase: 'fresh', daysLeft: 4, fill: 0 });
      expect(isChatDone(ancient)).toBe(false);
    });

    it('takes `done` from the row and never computes it', () => {
      // An EXPIRED clock the server still calls live stays live. The client
      // does not get a second opinion, even an arithmetically correct one.
      const expired = chatClock({ started_at: NOW - 99 * DAY, now: NOW, pinned: false });
      expect(isChatDone({ name: 'x', clock: expired, done: false })).toBe(false);
      expect(chipClock({ name: 'x', clock: expired, done: false }).phase).not.toBe('done');
      // …and a young chat the server calls done is done.
      const young = chatClock({ started_at: NOW, now: NOW, pinned: false });
      expect(isChatDone({ name: 'x', clock: young, done: true })).toBe(true);
    });

    it('reads last_day and stopped straight off the row', () => {
      // Not recomputed from expires_at, and not second-guessed: a clock the
      // server flags as its final day draws the dashed tile whatever its fill
      // says, and a stopped clock is pinned whatever its dates say.
      const clock = chatClock({ started_at: NOW, now: NOW, pinned: false });
      expect(chipClock({ name: 'x', clock: { ...clock, last_day: true } }).phase).toBe('last-day');
      expect(chipClock({ name: 'x', clock: { ...clock, stopped: true, fill: 0.9 } }).phase).toBe(
        'pinned',
      );
    });
  });
});

/**
 * A SUB-CHAT HAS NO CLOCK.
 *
 * It retires when it delivers, and its dot has exactly two states. These tests
 * replaced a set that asserted the dot's opacity tracked the PARENT's remaining
 * days — a mark that said "your parent is three days old", which is not a fact
 * about this chat and is not readable off six pixels of alpha anyway.
 */
describe('isChatRetired — the sub-chat’s one question', () => {
  /** A sub-chat as the server publishes it: `spawned_by` set, and NO clock. */
  const sub = (done: boolean): ChatChipChat => ({ name: 'kid', spawned_by: 'p', done });

  it('is retired once it has delivered, and not before', () => {
    expect(isChatRetired(sub(true))).toBe(true);
    expect(isChatRetired(sub(false))).toBe(false);
  });

  it('reads a row with no verdict yet as still working', () => {
    // The safe direction: a sub-chat wrongly shown as live is a row you can see
    // and act on; one wrongly retired has silently left the list.
    expect(isChatRetired({ name: 'kid', spawned_by: 'p' })).toBe(false);
  });

  it('never consults a clock — age cannot retire a sub-chat', () => {
    // Even handed a long-expired clock (which the server would not send), only
    // delivery decides.
    const ancient = chatClock({ started_at: NOW - 99 * DAY, now: NOW, pinned: false });
    expect(isChatRetired({ name: 'kid', spawned_by: 'p', clock: ancient, done: false })).toBe(
      false,
    );
  });
});

describe('chatTooltip', () => {
  // The row is one line — name only. The headline is NOT deleted, it moves
  // here, and this test is what stops it being dropped on the floor.
  it('carries the headline the one-line row no longer shows', () => {
    const t = chatTooltip(
      ...[{ ...aged(1), name: 'muxpad', headline: 'wiring the decay indicator' }],
    );
    expect(t).toContain('muxpad');
    expect(t).toContain('wiring the decay indicator');
    expect(t).toContain('3d left');
  });

  // A sub-chat has no clock, so it must not invent a countdown. It reports the
  // one thing it has — whether it delivered — and says nothing while working.
  it('never puts a countdown on a SUB-CHAT, which has no clock', () => {
    const working = { name: 'Work review', spawned_by: 'p', done: false };
    expect(chatTooltip(working)).toBe('Work review');
    expect(chatTooltip({ ...working, done: true })).toBe('Work review · done');
    expect(chatTooltip({ ...working, headline: 'reviewing the scroll rewrite' })).toBe(
      'Work review · reviewing the scroll rewrite',
    );
    // …and not even when a clock is somehow present on the row.
    expect(
      chatTooltip({
        ...working,
        clock: chatClock({ started_at: NOW - 2 * DAY, now: NOW, pinned: false }),
      }),
    ).not.toContain('left');
  });

  it('says where the clock stands when there is no headline', () => {
    expect(chatTooltip({ ...aged(0), name: 'Main' })).toBe('Main · 4d left');
    expect(chatTooltip({ ...aged(3), name: 'Main' })).toBe('Main · last day');
    expect(chatTooltip({ ...aged(9), name: 'Main' })).toBe('Main · done');
    // pinned goes through `aged`, not spread over its result: the clock has to
    // be BUILT stopped, the way the server builds it.
    expect(chatTooltip({ ...aged(9, { pinned: true }), name: 'Main' })).toBe('Main · pinned');
  });
});
