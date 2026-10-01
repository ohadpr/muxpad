import { describe, expect, it } from 'vitest';
import {
  CHAT_DECAY_MS,
  CHAT_STAGGER_MS,
  DAY_MS,
  chatClock,
  chatClockDone,
  staggeredClockStart,
} from './chat-clock.js';

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

describe('staggeredClockStart', () => {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  /**
   * `n` ULID-shaped ids that all share ONE timestamp prefix — the adversarial
   * case, not the friendly one. A real install's tabs were created over
   * months, so their prefixes differ; ids minted in one burst (a fleet of
   * workers, an import) differ only in the 16 random characters, and those are
   * the ids a weak hash would bucket together.
   */
  function ulids(n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      let suffix = '';
      // A cheap LCG, so the suffixes are arbitrary but the test is not. Read
      // from the TOP five bits: an LCG's low bits have a period of a few
      // steps, which would make these ids correlated in a way real randomness
      // is not, and the test would then be measuring the fixture.
      let s = Math.imul(i + 1, 2654435761) >>> 0;
      for (let c = 0; c < 16; c++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        suffix += CROCKFORD[s >>> 27];
      }
      out.push(`01JQK7XY0A${suffix}`);
    }
    return out;
  }

  it('is the same answer every time it is asked', () => {
    // A restore-from-backup re-runs the backfill. If the offset were random,
    // the second pass would deal every surviving chat a different death date
    // than the one the user has been watching count down.
    expect(staggeredClockStart('01JQK7XY0AZZZZZZZZZZZZZZZZ', T0)).toBe(
      staggeredClockStart('01JQK7XY0AZZZZZZZZZZZZZZZZ', T0),
    );
  });

  it('only ever moves a clock LATER, so nothing decays sooner than it would have', () => {
    // The day-one guarantee, as the one property worth stating: staggering can
    // add time to a chat's life and can never take any away. Everything below
    // is a consequence of this, including "nothing is done before day four".
    for (const id of ulids(200)) {
      const start = staggeredClockStart(id, T0);
      expect(start).toBeGreaterThanOrEqual(T0);
      expect(start).toBeLessThan(T0 + CHAT_STAGGER_MS);
      expect(Number.isInteger(start)).toBe(true);
      expect(chatClockDone(chatClock({ started_at: start, now: T0, pinned: false }), T0)).toBe(
        false,
      );
      // Not merely "not done at boot" — not done a minute before day four
      // either, which is the claim the user was actually given.
      const dayFour = T0 + CHAT_DECAY_MS - 1;
      const c = chatClock({ started_at: start, now: dayFour, pinned: false });
      expect(chatClockDone(c, dayFour)).toBe(false);
    }
  });

  it('thins a real sidebar over days instead of emptying it in one', () => {
    // 90 tabs is the size of the sidebar this was measured against.
    const starts = ulids(90).map((id) => staggeredClockStart(id, T0));
    const perDay = [0, 1, 2].map(
      (d) => starts.filter((s) => s - T0 >= d * DAY_MS && s - T0 < (d + 1) * DAY_MS).length,
    );
    // Every day of the window carries a real share of the crossings. The
    // assertion that matters is the absence of a day holding all of them.
    for (const n of perDay) expect(n).toBeGreaterThan(90 / 6);
    expect(perDay.reduce((a, b) => a + b, 0)).toBe(90);
  });

  it('leaves the sweeper at most a couple of crossings in any one tick', () => {
    // The OTHER half of the cliff, and the more expensive one: the sweeper
    // ticks once a minute and emits one `tab.updated` per crossing, each of
    // which costs every connected client a full workspace walk. Synchronised,
    // that is 90 events in one tick. Spread over three days there are 4320
    // ticks for 90 chats, so collisions are a coincidence rather than the
    // design.
    const minutes = ulids(90).map((id) => Math.floor((staggeredClockStart(id, T0) - T0) / 60_000));
    const perMinute = new Map<number, number>();
    for (const m of minutes) perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(2);
  });
});
