/**
 * The meta column's one job: say when this chat next runs itself, in as few
 * characters as will still be unambiguous, and in a shape that COLUMNISES.
 *
 * The rail's meta cell is right-aligned monospace with tabular figures, so
 * `07:00` and `Sun 09:00` stack with their colons and digits on the same
 * vertical lines. That only works if the label is built from a fixed
 * vocabulary — which is why the time is forced to 24-hour and the weekday to
 * three letters, rather than handed to `toLocaleString` and hoped for. A
 * locale that renders `7:00 AM` breaks the column outright: variable-width
 * meridiem, a leading digit that isn't zero-padded, and a space where every
 * other row has a digit.
 *
 * Three shapes, cheapest-first:
 *   today            `07:00`
 *   within a week    `Sun 09:00`
 *   further out      `12 Sep`      — the clock time stops being the useful
 *                                    fact once it's a fortnight away
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Midnight-to-midnight day difference in LOCAL time (not 24h buckets). */
function calendarDaysApart(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  // Divide by a whole day AFTER truncating to local midnights, so a DST
  // boundary in between (a 23- or 25-hour day) still rounds to a whole number.
  return Math.round((b - a) / 86_400_000);
}

/**
 * @param nextDueAt epoch ms of the next fire
 * @param now       epoch ms — injected so this is testable and so every row in
 *                  one render agrees on "today"
 */
export function nextCronLabel(nextDueAt: number, now: number = Date.now()): string {
  const due = new Date(nextDueAt);
  if (Number.isNaN(due.getTime())) return '';
  const days = calendarDaysApart(new Date(now), due);
  const clock = `${pad2(due.getHours())}:${pad2(due.getMinutes())}`;
  // Overdue (a scheduler that hasn't caught up yet) reads as today, not as
  // some weekday in the past — the useful fact is the time it wanted.
  if (days <= 0) return clock;
  if (days < 7) return `${WEEKDAYS[due.getDay()]} ${clock}`;
  return `${due.getDate()} ${MONTHS[due.getMonth()]}`;
}

/**
 * The same fact, for the RAIL, where the row has about 30px to spare.
 *
 * TODAY ONLY. `nextCronLabel` above has three shapes and the widest of them
 * (`Thu 11:08`) is nine characters — measured at roughly a third of a 270px
 * rail, against names that were already ellipsising. Reported as one of three
 * things crowding the right of every row.
 *
 * The cut is not arbitrary. The reason the time is on the rail at all is the
 * glance question — "does anything run before I go out?" — and that question is
 * about today. A job due on Thursday does not need a readout in a navigator; it
 * needs to be FINDABLE, which the glyph alone already does. So the rail answers
 * "today, at —" and says nothing else; the tooltip still carries the cron's
 * name and the full `nextCronLabel` for every other case.
 *
 * It also makes the column STABLE: the one shape it can now render is `HH:MM`,
 * so the meta cell is the same width on every row that has one, and the
 * tabular-figure alignment the original was built for is no longer competing
 * with a weekday that only some rows have.
 */
export function railCronLabel(nextDueAt: number, now: number = Date.now()): string {
  const due = new Date(nextDueAt);
  if (Number.isNaN(due.getTime())) return '';
  // Overdue reads as today for the same reason it does above: the useful fact
  // is the time it wanted, not that a scheduler is behind.
  if (calendarDaysApart(new Date(now), due) > 0) return '';
  return `${pad2(due.getHours())}:${pad2(due.getMinutes())}`;
}
