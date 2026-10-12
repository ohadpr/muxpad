/**
 * HOW MUCH HISTORY ONE CHAT IS ALLOWED TO DRAG IN BY ITSELF.
 *
 * ── THE MEASUREMENT THIS EXISTS FOR ─────────────────────────────────────────
 * Reported as "loading speed of chats is degrading, sometimes feels stuck,
 * maybe trying to load too much". On the real muxpad chat, on open: 941 rows,
 * 6,805 DOM nodes, 114,977 px — 152 screens. Scrolling up for twelve seconds
 * took it to 1,775 rows and 202,971 px, still climbing, because nothing ever
 * stopped it: `onScroll` pages whenever `scrollTop` is in the top zone, and the
 * only limit is reaching the start of the transcript.
 *
 * A 12,000 px scroll gesture moved the reader 4,965 px in that state. The
 * document was growing faster than they could scroll.
 *
 * ── WHY A COUNT, AND WHY THIS COUNT ─────────────────────────────────────────
 * The thing that hurts is the number of RENDERED ROWS, so that is what is
 * bounded — not pages (whose size varies with message length) and not bytes
 * (which say nothing about DOM cost). A server tail is ~126 rows, so 800 is
 * roughly six scroll-backs: past "I want to re-read the last thing" and well
 * past "I nudged up by accident", without approaching the scale that made the
 * document unscrollable.
 *
 * It is a budget for AUTOMATIC loading only. The reader can always ask for
 * more, and asking grants another full budget — see `historyCap`. That is the
 * difference between a limit and a wall: nothing becomes unreachable, it just
 * stops happening without being asked for.
 */
export const AUTO_PAGE_EVENTS = 800;

/**
 * The ceiling right now, given how many times the reader has asked for more.
 *
 * Each ask grants another whole budget rather than a single page: a reader who
 * has said "go back further" once is digging, and making them click six times
 * to cross what the scroll would have crossed by itself is the friction this is
 * trying not to add.
 */
export function historyCap(grants: number): number {
  return AUTO_PAGE_EVENTS * (1 + Math.max(0, grants));
}

/**
 * May the scroll position alone pull in another page?
 *
 * `loaded` is the client's event count — see above for why that is not the
 * same as the rendered row count, and why the difference is safe.
 */
export function canAutoPageHistory(opts: { loaded: number; grants: number }): boolean {
  return opts.loaded < historyCap(opts.grants);
}

/**
 * Should the reader be offered a "load earlier" control?
 *
 * Only when there IS more and the budget is what is stopping it. A chat that
 * has reached the start of its transcript must not show a button that does
 * nothing, and a chat under its budget must not show one either — there the
 * scroll already works, and a button would be a second way to do the thing that
 * is already happening.
 */
export function showLoadEarlier(opts: {
  loaded: number;
  grants: number;
  hasMoreOlder: boolean;
}): boolean {
  return opts.hasMoreOlder && !canAutoPageHistory(opts);
}
