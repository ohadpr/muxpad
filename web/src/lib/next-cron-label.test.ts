import { describe, expect, it } from 'vitest';
import { nextCronLabel } from './next-cron-label';

/** Local-time constructor, so the tests read in the same frame the code does. */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('nextCronLabel', () => {
  // Wednesday 2026-09-02, 10:30 local.
  const now = at(2026, 9, 2, 10, 30);

  it('shows only the clock for TODAY', () => {
    expect(nextCronLabel(at(2026, 9, 2, 23, 30), now)).toBe('23:30');
  });

  it('zero-pads the hour so the digits column up', () => {
    // The whole reason the meta cell is monospace with tabular figures: a
    // ragged `7:00` next to `23:30` makes the column unreadable.
    expect(nextCronLabel(at(2026, 9, 2, 7, 0), now)).toBe('07:00');
  });

  it('prefixes a short weekday within the week', () => {
    expect(nextCronLabel(at(2026, 9, 6, 9, 0), now)).toBe('Sun 09:00');
    expect(nextCronLabel(at(2026, 9, 3, 7, 0), now)).toBe('Thu 07:00');
  });

  it('falls back to a date once the clock stops being the useful fact', () => {
    expect(nextCronLabel(at(2026, 9, 12, 9, 0), now)).toBe('12 Sep');
  });

  it('treats an OVERDUE fire as today — the useful fact is the time it wanted', () => {
    expect(nextCronLabel(at(2026, 9, 2, 6, 0), now)).toBe('06:00');
    expect(nextCronLabel(at(2026, 9, 1, 6, 0), now)).toBe('06:00');
  });

  it('is 24-hour regardless of locale', () => {
    // toLocaleString would render `7:00 PM` in en-US, which has a variable
    // width meridiem and an unpadded hour — the column dies.
    expect(nextCronLabel(at(2026, 9, 2, 19, 0), now)).toBe('19:00');
    expect(nextCronLabel(at(2026, 9, 2, 0, 5), now)).toBe('00:05');
  });

  it('counts CALENDAR days, not 24-hour buckets', () => {
    // 23:00 today → 01:00 tomorrow is 2 hours away but a different day, and
    // must read as a weekday, not as a bare clock the user reads as "tonight".
    const late = at(2026, 9, 2, 23, 0);
    expect(nextCronLabel(at(2026, 9, 3, 1, 0), late)).toBe('Thu 01:00');
  });

  it('the two common shapes are the widths the meta floor was sized for', () => {
    expect(nextCronLabel(at(2026, 9, 2, 7, 0), now)).toHaveLength(5);
    expect(nextCronLabel(at(2026, 9, 6, 9, 0), now)).toHaveLength(9);
  });

  it('degrades to empty on a garbage timestamp rather than rendering NaN', () => {
    expect(nextCronLabel(Number.NaN, now)).toBe('');
  });

  it('exactly 7 days out crosses into the date form', () => {
    expect(nextCronLabel(at(2026, 9, 9, 9, 0), now)).toBe('9 Sep');
    expect(nextCronLabel(at(2026, 9, 8, 9, 0), now)).toBe('Tue 09:00');
  });
});
