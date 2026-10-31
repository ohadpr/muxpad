/**
 * HOW LONG AGO, IN AS FEW CHARACTERS AS POSSIBLE.
 *
 * For places where the age is a FOOTNOTE on something else — a pinned card's
 * freshness, a rail row's last activity — and has to fit in a column the eye
 * passes over rather than reads. One unit, no "ago", no punctuation.
 *
 * The thresholds round rather than truncate (46s is "1m", not "0m") because
 * the failure these columns have is reading as zero: a row that says "0m" and
 * a row that says nothing look the same at a glance, and one of them is wrong.
 *
 * NOTE: ChatCards.tsx carries a private copy of this, written first. It is
 * another agent's file and uncommitted as this lands, so folding the two is a
 * one-line change for whoever touches that file next rather than a conflict
 * now. Two copies of a formatter is a small debt; editing somebody's
 * in-flight work to save it is not.
 */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 45) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The same thing for a row whose window is measured in HOURS.
 *
 * The recently-active band decays at 16 hours, so its ages live in minutes
 * and hours and a seconds column is noise that changes under the pointer. A
 * chat you are in the middle of says `now` — which is the honest answer and
 * also the only one that does not tick.
 */
export function activeAge(ms: number): string {
  return ms < 90_000 ? 'now' : shortAge(ms);
}
