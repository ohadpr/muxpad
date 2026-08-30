// Schedule math for `muxpad cron` — the ONLY place a cron expression is
// interpreted. Two jobs:
//
//   1. Compile a friendly grammar ("every 30m", "weekdays at 09:00") down to a
//      five-field cron expression, so the stored `schedule` column is always
//      one thing and every reader (CLI, UI, tick) agrees on its meaning.
//   2. Answer "when next?" and "what did I miss?" in a named IANA ZONE.
//
// Timezone is not a formatting concern here, it is the correctness concern.
// Hand-rolled UTC arithmetic gets "09:00 every weekday" wrong twice a year,
// silently, and a scheduler that is silently wrong is exactly what this
// feature exists to replace. `cron-parser` (luxon-backed) does the zone work;
// we never do date math ourselves.
import { CronExpressionParser } from 'cron-parser';

/**
 * Hard cap on how many occurrences we will enumerate for one catch-up. A
 * `* * * * *` cron across a month of downtime is ~43k fires; enumerating them
 * all to then collapse to ONE is pure waste, and under `catchup=all` it would
 * be an attempt to enqueue 43k messages. The cap is generous for real use
 * (a 30-minute job across a 10-day outage is 480) and the count we report is
 * clamped to it, flagged by `capped`.
 */
export const MAX_CATCHUP_FIRES = 1000;

export class ScheduleError extends Error {}

/** Validate an IANA zone name by asking Intl (the same database luxon uses). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The host's IANA zone — the default for a cron created without `--tz`. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const DOW: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/**
 * Compile a human phrase to a five-field cron expression. Anything that
 * already LOOKS like a cron expression (5 or 6 whitespace-separated fields)
 * is validated and passed through unchanged — the grammar is a convenience,
 * never a wall between the user and cron.
 *
 * Supported phrases (case-insensitive):
 *   every <n>m|min|mins|minutes      every 15m         -> star/15 …
 *   every <n>h|hr|hrs|hours          every 2h
 *   hourly                           -> 0 * * * *
 *   daily|every day at HH:MM         daily at 09:00
 *   weekdays at HH:MM                -> M-F
 *   weekends at HH:MM                -> Sat+Sun
 *   <dow>[,<dow>…] at HH:MM          mon,wed at 07:30
 *   monthly on <d> at HH:MM          monthly on 1 at 09:00
 */
export function compileSchedule(input: string): string {
  const raw = input.trim();
  if (!raw) throw new ScheduleError('schedule is empty');
  // Already a cron expression? Let cron-parser be the judge; its error message
  // is better than anything we would invent.
  const fields = raw.split(/\s+/);
  if (fields.length === 5 || fields.length === 6) {
    assertParsable(raw);
    return raw;
  }
  const s = raw.toLowerCase();

  let m = s.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes)$/);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 59)
      throw new ScheduleError('every <n> minutes: n must be 1-59 (use hours above that)');
    return `*/${n} * * * *`;
  }
  m = s.match(/^every\s+(\d+)\s*(h|hr|hrs|hour|hours)$/);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 23) throw new ScheduleError('every <n> hours: n must be 1-23');
    return `0 */${n} * * *`;
  }
  if (s === 'hourly') return '0 * * * *';
  if (s === 'minutely' || s === 'every minute') return '* * * * *';

  const at = s.match(/\bat\s+(\d{1,2}):(\d{2})$/);
  const hh = at ? Number(at[1]) : null;
  const mm = at ? Number(at[2]) : null;
  if (at && (hh === null || mm === null || hh > 23 || mm > 59))
    throw new ScheduleError(`invalid time of day in "${raw}"`);
  const head = at ? s.slice(0, s.length - at[0].length).trim() : s;

  if (at) {
    if (head === 'daily' || head === 'every day') return `${mm} ${hh} * * *`;
    if (head === 'weekdays' || head === 'every weekday') return `${mm} ${hh} * * 1-5`;
    if (head === 'weekends') return `${mm} ${hh} * * 0,6`;
    const monthly = head.match(/^monthly\s+on\s+(\d{1,2})$/);
    if (monthly) {
      const d = Number(monthly[1]);
      if (d < 1 || d > 31) throw new ScheduleError('monthly on <d>: d must be 1-31');
      return `${mm} ${hh} ${d} * *`;
    }
    const days = head.split(/\s*,\s*/).filter(Boolean);
    if (days.length > 0 && days.every((d) => d in DOW)) {
      const nums = [...new Set(days.map((d) => DOW[d] as number))].sort((a, b) => a - b);
      return `${mm} ${hh} * * ${nums.join(',')}`;
    }
  }
  throw new ScheduleError(
    `could not read the schedule "${raw}" — use a cron expression ('0 9 * * 1-5') or a phrase like 'daily at 09:00', 'weekdays at 09:00', 'every 30m'`,
  );
}

function assertParsable(expr: string): void {
  try {
    CronExpressionParser.parse(expr);
  } catch (e) {
    throw new ScheduleError(`invalid cron expression "${expr}": ${(e as Error).message}`);
  }
}

/**
 * The first occurrence STRICTLY AFTER `from`, in `tz`. Returns epoch ms.
 *
 * "Strictly after" is load-bearing: the tick re-anchors with
 * `nextAfter(expr, tz, now)` immediately after firing, and an inclusive
 * boundary would re-arm the same instant and fire the cron again on the next
 * tick — a self-sustaining loop that costs a turn every 30 seconds.
 */
export function nextAfter(expr: string, tz: string, from: number): number {
  const it = CronExpressionParser.parse(expr, { currentDate: new Date(from), tz });
  return it.next().getTime();
}

export interface DueFires {
  /** Slot times (epoch ms) that came due in (anchor-1, now], oldest first. */
  fires: number[];
  /** True when MAX_CATCHUP_FIRES clipped the list — `fires` is a prefix. */
  capped: boolean;
}

/**
 * Every occurrence at or after `anchor` and at or before `now`. `anchor` is
 * the cron's persisted `next_due_at`, so this answers both "is it due?" (one
 * element) and "what did I miss while the laptop was asleep?" (many) with the
 * same call — there is no separate catch-up code path to drift.
 */
export function firesDue(expr: string, tz: string, anchor: number, now: number): DueFires {
  const fires: number[] = [];
  if (anchor > now) return { fires, capped: false };
  // Start one ms BEFORE the anchor so an anchor that is itself an occurrence
  // is included (`next()` is strictly-after).
  const it = CronExpressionParser.parse(expr, { currentDate: new Date(anchor - 1), tz });
  while (fires.length < MAX_CATCHUP_FIRES) {
    const t = it.next().getTime();
    if (t > now) break;
    fires.push(t);
  }
  return { fires, capped: fires.length >= MAX_CATCHUP_FIRES };
}

/**
 * Human, zone-correct rendering of an instant — used by `muxpad cron list`
 * so the next-due column reads in the cron's OWN zone, not the terminal's.
 */
export function formatInZone(at: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}
