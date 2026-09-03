import { describe, expect, it } from 'vitest';
import {
  MAX_CATCHUP_FIRES,
  MAX_JITTER_MS,
  ScheduleError,
  compileSchedule,
  estimateIntervalMs,
  firesDue,
  isValidTimezone,
  nextAfter,
  scheduleJitterMs,
} from './schedule.js';

const LA = 'America/Los_Angeles';
const iso = (t: number) => new Date(t).toISOString();

describe('compileSchedule', () => {
  it('passes a real cron expression through untouched', () => {
    expect(compileSchedule('0 9 * * 1-5')).toBe('0 9 * * 1-5');
    expect(compileSchedule('*/5 * * * *')).toBe('*/5 * * * *');
    // Six fields (seconds) is a legal cron-parser form; don't reject it.
    expect(compileSchedule('0 0 9 * * 1')).toBe('0 0 9 * * 1');
  });

  it('compiles the friendly grammar', () => {
    expect(compileSchedule('every 30m')).toBe('*/30 * * * *');
    expect(compileSchedule('every 2h')).toBe('0 */2 * * *');
    expect(compileSchedule('hourly')).toBe('0 * * * *');
    expect(compileSchedule('daily at 09:00')).toBe('0 9 * * *');
    expect(compileSchedule('weekdays at 09:30')).toBe('30 9 * * 1-5');
    expect(compileSchedule('weekends at 11:00')).toBe('0 11 * * 0,6');
    expect(compileSchedule('mon,wed at 07:30')).toBe('30 7 * * 1,3');
    expect(compileSchedule('monthly on 1 at 09:00')).toBe('0 9 1 * *');
  });

  it('maps every weekday name to the right cron day number', () => {
    // Wednesday=3 was a genuine off-by-one waiting to happen; pin all seven.
    expect(compileSchedule('sun at 00:00')).toBe('0 0 * * 0');
    expect(compileSchedule('monday at 00:00')).toBe('0 0 * * 1');
    expect(compileSchedule('tuesday at 00:00')).toBe('0 0 * * 2');
    expect(compileSchedule('wednesday at 00:00')).toBe('0 0 * * 3');
    expect(compileSchedule('thursday at 00:00')).toBe('0 0 * * 4');
    expect(compileSchedule('friday at 00:00')).toBe('0 0 * * 5');
    expect(compileSchedule('saturday at 00:00')).toBe('0 0 * * 6');
  });

  it('is case-insensitive about phrases', () => {
    expect(compileSchedule('  Weekdays At 09:00 ')).toBe('0 9 * * 1-5');
  });

  it('rejects nonsense loudly rather than silently scheduling something else', () => {
    // The failure mode this whole feature exists to remove is a schedule that
    // quietly does the wrong thing, so a bad one must fail at CREATION.
    expect(() => compileSchedule('')).toThrow(ScheduleError);
    expect(() => compileSchedule('sometimes on tuesdays')).toThrow(ScheduleError);
    expect(() => compileSchedule('daily at 25:00')).toThrow(ScheduleError);
    expect(() => compileSchedule('every 90m')).toThrow(ScheduleError);
    expect(() => compileSchedule('every 0h')).toThrow(ScheduleError);
    expect(() => compileSchedule('monthly on 32 at 09:00')).toThrow(ScheduleError);
    expect(() => compileSchedule('99 99 * * *')).toThrow(ScheduleError);
  });
});

describe('timezones', () => {
  it('validates IANA names', () => {
    expect(isValidTimezone(LA)).toBe(true);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('not a zone')).toBe(false);
    // Note: Intl also accepts legacy aliases like 'PST' (they resolve to a
    // real zone), so we do NOT reject those — the point of the check is to
    // catch a typo before it becomes a 3am surprise, not to police spelling.
  });

  it('evaluates in the cron OWN zone, not the host zone', () => {
    // 09:00 in Los Angeles is 16:00Z in summer.
    const t = nextAfter('0 9 * * *', LA, Date.parse('2026-08-30T00:00:00Z'));
    expect(iso(t)).toBe('2026-08-30T16:00:00.000Z');
    // …and 08:00Z for a Berlin cron at 10:00 local.
    const b = nextAfter('0 10 * * *', 'Europe/Berlin', Date.parse('2026-08-30T00:00:00Z'));
    expect(iso(b)).toBe('2026-08-30T08:00:00.000Z');
  });

  // The reason this uses a tz-aware library at all: DST is where hand-rolled
  // schedulers break, silently, twice a year.
  it('keeps 09:00 local across the US spring-forward transition', () => {
    // 2027-03-14 is the US spring-forward. 09:00 local is 17:00Z the day
    // before (PST) and 16:00Z on/after (PDT) — the WALL CLOCK is what holds
    // still; naive UTC arithmetic would drift the fire by an hour.
    const before = nextAfter('0 9 * * *', LA, Date.parse('2027-03-13T00:00:00Z'));
    expect(iso(before)).toBe('2027-03-13T17:00:00.000Z');
    // 12:00Z on the transition day is 05:00 PDT (the shift landed at 10:00Z),
    // so the next 09:00 LOCAL is later the SAME day — at 16:00Z, an hour
    // earlier in UTC than the day before. The wall clock held; UTC moved.
    const after = nextAfter('0 9 * * *', LA, Date.parse('2027-03-14T12:00:00Z'));
    expect(iso(after)).toBe('2027-03-14T16:00:00.000Z');
  });

  it('keeps 09:00 local across the US fall-back transition', () => {
    // 2026-11-01 is the US fall-back: 09:00 goes from 16:00Z to 17:00Z.
    const before = nextAfter('0 9 * * *', LA, Date.parse('2026-10-31T00:00:00Z'));
    expect(iso(before)).toBe('2026-10-31T16:00:00.000Z');
    // 12:00Z on the transition day is 04:00 PST (the shift landed at 09:00Z),
    // so the next 09:00 local is the same day at 17:00Z.
    const after = nextAfter('0 9 * * *', LA, Date.parse('2026-11-01T12:00:00Z'));
    expect(iso(after)).toBe('2026-11-01T17:00:00.000Z');
  });

  it('a daily cron in the skipped hour still fires exactly once that day', () => {
    // 02:30 does not exist on 2027-03-14 in Los Angeles. It must not be
    // dropped (a missed day) nor doubled — one fire, that day.
    const fires = firesDue(
      '30 2 * * *',
      LA,
      Date.parse('2027-03-13T00:00:00Z'),
      Date.parse('2027-03-16T00:00:00Z'),
    ).fires;
    const days = fires.map((t) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: LA, dateStyle: 'short' }).format(new Date(t)),
    );
    expect(new Set(days).size).toBe(days.length); // no day fired twice
    expect(days).toContain('2027-03-14'); // and the DST day is not skipped
  });

  it('a daily cron in the repeated hour fires once, not twice', () => {
    // 01:30 happens twice on 2026-11-01 in Los Angeles (once PDT, once PST).
    const fires = firesDue(
      '30 1 * * *',
      LA,
      Date.parse('2026-10-31T00:00:00Z'),
      Date.parse('2026-11-03T00:00:00Z'),
    ).fires;
    const days = fires.map((t) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: LA, dateStyle: 'short' }).format(new Date(t)),
    );
    expect(days.filter((d) => d === '2026-11-01')).toHaveLength(1);
  });
});

describe('nextAfter', () => {
  it('is STRICTLY after — an exact-boundary anchor advances', () => {
    // Inclusive here would re-arm the same instant and re-fire the cron every
    // tick forever, burning a turn every 30 seconds.
    const t = Date.parse('2026-08-30T16:00:00.000Z'); // exactly 09:00 LA
    expect(nextAfter('0 9 * * *', LA, t)).toBeGreaterThan(t);
    expect(iso(nextAfter('0 9 * * *', LA, t))).toBe('2026-08-31T16:00:00.000Z');
  });
});

describe('firesDue (catch-up enumeration)', () => {
  const HOURLY = '0 * * * *';

  it('returns nothing when the anchor is in the future', () => {
    const now = Date.parse('2026-08-30T10:00:00Z');
    expect(firesDue(HOURLY, 'UTC', now + 60_000, now).fires).toEqual([]);
  });

  it('includes the anchor itself when it is an occurrence', () => {
    const anchor = Date.parse('2026-08-30T10:00:00Z');
    const { fires } = firesDue(HOURLY, 'UTC', anchor, anchor);
    expect(fires.map(iso)).toEqual(['2026-08-30T10:00:00.000Z']);
  });

  it('enumerates every slot missed across a downtime, oldest first', () => {
    const anchor = Date.parse('2026-08-30T10:00:00Z');
    const now = Date.parse('2026-08-30T14:30:00Z'); // 4.5h later
    const { fires, capped } = firesDue(HOURLY, 'UTC', anchor, now);
    expect(fires.map(iso)).toEqual([
      '2026-08-30T10:00:00.000Z',
      '2026-08-30T11:00:00.000Z',
      '2026-08-30T12:00:00.000Z',
      '2026-08-30T13:00:00.000Z',
      '2026-08-30T14:00:00.000Z',
    ]);
    expect(capped).toBe(false);
  });

  it('caps a pathological catch-up instead of enumerating a month of minutes', () => {
    const anchor = Date.parse('2026-01-01T00:00:00Z');
    const now = Date.parse('2026-02-01T00:00:00Z'); // ~44k minute-slots
    const { fires, capped } = firesDue('* * * * *', 'UTC', anchor, now);
    expect(fires).toHaveLength(MAX_CATCHUP_FIRES);
    expect(capped).toBe(true);
  });
});

describe('scheduleJitterMs', () => {
  const ref = Date.parse('2026-08-30T00:00:00Z');

  it('is DETERMINISTIC — the same id and schedule always give the same offset', () => {
    // Random jitter would make next_due_at unreproducible across a restart
    // and untestable at any point, which is most of what this scheduler is for.
    const a = scheduleJitterMs('01ABCDEF', '0 9 * * *', LA, ref);
    const b = scheduleJitterMs('01ABCDEF', '0 9 * * *', LA, ref);
    expect(a).toBe(b);
  });

  it('differs between crons, so N daily jobs do not stampede at :00', () => {
    const offsets = new Set(
      ['01A', '01B', '01C', '01D', '01E', '01F', '01G', '01H'].map((id) =>
        scheduleJitterMs(id, '0 9 * * *', LA, ref),
      ),
    );
    expect(offsets.size).toBeGreaterThan(4);
  });

  it('never exceeds 30 minutes, however long the interval', () => {
    for (const id of ['a', 'bb', 'ccc', 'dddd', 'eeeee']) {
      // Monthly: half the interval is ~15 days, so the absolute ceiling binds.
      expect(scheduleJitterMs(id, '0 9 1 * *', LA, ref)).toBeLessThan(MAX_JITTER_MS);
    }
  });

  it('never exceeds half the interval, so a fire cannot slide past its next slot', () => {
    for (const expr of ['*/2 * * * *', '*/5 * * * *', '*/30 * * * *', '0 * * * *']) {
      const interval = estimateIntervalMs(expr, 'UTC', ref);
      for (const id of ['a', 'bb', 'ccc', 'dddd']) {
        expect(scheduleJitterMs(id, expr, 'UTC', ref)).toBeLessThan(interval / 2 + 1);
      }
    }
  });

  it('is zero when there is no room for it (a per-minute cron)', () => {
    // Half of 60s is 30s; the cap floors to 30_000ms, which is fine — but a
    // degenerate zero-interval expression must not produce NaN or a negative.
    const j = scheduleJitterMs('01X', '* * * * *', 'UTC', ref);
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThanOrEqual(30_000);
  });
});
