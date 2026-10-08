/**
 * WHERE A TIMED THING CAN HONESTLY GO IN A PARTIALLY-LOADED LOG.
 *
 * The chat renders a WINDOW of a conversation — the newest messages, plus
 * however much history has been paged in. Two other sources draw into that
 * window at their own speed and with their own timestamps: spawn cards (from
 * the sidebar corpus) and browser moments (from `/api/browsers`). Neither is
 * limited to the window, so both constantly hold things whose moment is not in
 * the document.
 *
 * ── THE SAME BUG, THREE TIMES ───────────────────────────────────────────────
 * Both placement loops had the identical shape: walk the entries, emit anything
 * whose `at` is not greater than this entry's, flush the rest at the end. That
 * is correct in the middle and wrong at both edges, and each edge was reported
 * separately as something else:
 *
 *   tail  — with no entries loaded yet the loop body never runs, so EVERYTHING
 *           flushes at the bottom. "I see all the historic agents it launched
 *           stacked at the bottom… only then it resolves into the proper
 *           history."
 *   head  — anything older than the oldest loaded message satisfies the test
 *           against the FIRST entry, so it all lands there. Measured: 24 of 38
 *           opening rows were spawn cards in one run; and separately, every
 *           browser card in a chat sitting at indices 0–2. "I bumped into a ton
 *           of cards"; "it acts real weird once I try to scroll past the cards
 *           representing browser automation."
 *
 * Fixing it in one call site and then the other is how it got to three. This is
 * the rule in one place, so the next thing that draws into the log inherits it
 * instead of rediscovering it.
 */

/**
 * The index of the first moment that is inside the window.
 *
 * `floor` is the oldest loaded TRANSCRIPT time, or null when the server has
 * said there is no earlier history — then nothing is below the window, because
 * the window starts at the beginning of the conversation.
 *
 * Taking the floor from the transcript rather than from the list being walked
 * matters: by the time spawn cards are placed, browser moments are already in
 * that list, and a browser opening can be dated older than every message
 * loaded. Reading the floor off the first dated entry therefore read that
 * moment and let every card through — which is why the first attempt at the
 * head fix measured no change at all.
 */
export function windowStart<M extends { at: number }>(
  moments: readonly M[],
  floor: number | null,
): number {
  if (floor === null) return 0;
  let i = 0;
  while (i < moments.length && (moments[i] as M).at < floor) i++;
  return i;
}

/**
 * May anything be flushed at the END of the log?
 *
 * Only once some entry has given the log a timeline. Before that the bottom is
 * not "the present", it is just the nearest edge — and it is the one the reader
 * is looking at, which makes it the worst available guess.
 */
export function canFlushTail(entries: readonly { at: number | null }[]): boolean {
  return entries.some((e) => e.at !== null);
}
