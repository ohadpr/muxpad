import { termsPresent, textMatchesTerms } from './search-highlight';

/**
 * The handoff from a search result to the chat it points at: "you are being
 * taken here BECAUSE this message says that — so show them where."
 *
 * ── ONLY THE MESSAGE TIER ───────────────────────────────────────────────────
 * The search box has two tiers, and only one of them may produce a jump.
 *
 * A MESSAGE hit came out of the archive's FTS5 index: the server found the term
 * inside a specific message and handed back its `sid` and `ts`. Following that
 * row is a request to go and read that message, so carrying the term along and
 * lighting it up is just finishing the sentence the result row started.
 *
 * An INSTANT hit matched a tab name, a workspace name or a headline. The term
 * may not occur in the transcript at ALL — "Investing" is the chat's name, not
 * something anyone said in it — so there is nothing honest to highlight, and
 * hunting for a stray occurrence to mark would invent a match the search never
 * made and move the reader somewhere they did not ask to go. Instant hits
 * therefore open the tab and change nothing about it; the term stays
 * highlighted where it actually matched, in the row you clicked and in the tab
 * name you land on. See `NavSearch.openTab`.
 *
 * ── WHY A MODULE STORE AND NOT THE URL ──────────────────────────────────────
 * Two reasons, and the second is the important one.
 *
 * The route is `/w/$wsSlug/t/$tabSlug` and a tab can hold several panes, so the
 * URL does not name the pane a hit belongs to — the app already solves that
 * with `setLastPaneId` + a `muxpad:select-pane` event, and a jump rides the
 * same rails so there is one handoff mechanism rather than two.
 *
 * And a highlight must not be DURABLE. A `?q=` in the URL survives a reload, a
 * bookmark, a share and a back button, so a chat would come back lit up hours
 * later with no explanation — exactly the "still highlighted an hour later"
 * failure. Kept in a module map, a pending jump dies with the tab; kept in
 * component state once claimed, it dies with the visit.
 */

export interface SearchJump {
  /** Which pane's chat the hit is in. */
  paneId: string;
  /** What the user typed. Split into terms by the highlighter, not here — the
   *  raw query is also what gets shown if we have to say we couldn't find it. */
  query: string;
  /** The session the archive found it in. A chat that has since been `/clear`ed
   *  or resumed into a new sid is a different conversation, and the jump is
   *  dropped rather than applied to whatever is there now. */
  sid: string;
  /**
   * Epoch ms of the matched message, or null when the transcript line carried
   * no parseable timestamp.
   *
   * NOT an event id: the archive indexes `(text, sid, ts, role)` and never
   * stores the ChatEvent `id`, and one transcript line fans out into several
   * events that share a `ts`. So `ts` narrows the search to an instant and the
   * TEXT decides which event at that instant is the one — see `pickSearchTarget`.
   */
  ts: number | null;
}

/** The live-delivery event, for a ChatPane that is already mounted. */
export const SEARCH_JUMP_EVENT = 'muxpad:search-jump';

/**
 * Pending jumps, keyed by pane.
 *
 * Both a mailbox and a broadcast, for the same reason `setLastPaneId` is: the
 * destination ChatPane may not be mounted yet (following a result into a
 * workspace you have not opened mounts it several commits later), and it may be
 * mounted already (jumping inside the tab you are looking at). The event covers
 * the second case; the map covers the first, and is claimed on mount.
 *
 * One entry per pane — a second jump to the same chat supersedes the first,
 * which is what "search again while the last hit is still lit" should do.
 */
const pending = new Map<string, SearchJump>();

/** Ask a pane's chat to jump to, and light up, a search hit. */
export function requestSearchJump(jump: SearchJump): void {
  pending.set(jump.paneId, jump);
  window.dispatchEvent(new CustomEvent(SEARCH_JUMP_EVENT, { detail: jump }));
}

/**
 * Claim the pending jump for a pane, if any. CONSUMING: a jump is a one-shot
 * instruction, so a later remount (a tab re-render, a reconnect) must not
 * re-apply it and drag a reader who has moved on back into history.
 */
export function takeSearchJump(paneId: string): SearchJump | null {
  const jump = pending.get(paneId);
  if (!jump) return null;
  pending.delete(paneId);
  return jump;
}

/** Test seam: drop everything unclaimed. */
export function clearSearchJumps(): void {
  pending.clear();
}

/** The bit of a ChatEvent `pickSearchTarget` needs. Structural so the picker
 *  is testable without building whole events. */
export interface JumpCandidate {
  id: string;
  ts: number | null;
  text?: string | undefined;
}

/**
 * Which loaded event is the message the search hit named?
 *
 * The archive can only say "in session S, at instant T, something matched", and
 * that is not enough on its own: `ts` is not unique (one transcript line
 * becomes several events sharing a timestamp), it can be null, and the loaded
 * window may not contain that instant at all. So the choice is made on both
 * axes at once, TEXT first:
 *
 *   1. Only events whose text actually contains a term are candidates. This is
 *      the honesty guarantee — we will never mark a message that does not say
 *      the thing, and if nothing loaded says it we return null and the caller
 *      goes and pages history in rather than lighting up whatever is nearest.
 *   2. Among those, more distinct terms beats fewer. FTS5 conjoins terms by
 *      default, so the message the user was sent to contains all of them; a
 *      message mentioning only one is a bystander.
 *   3. Then nearest in time to the hit's `ts`. This is what disambiguates a
 *      word the conversation uses constantly — without it, "the first match on
 *      screen" would be the answer, and the user would be told the wrong
 *      message is why they are here.
 *   4. Ties (equal distance, or no `ts` to compare) go to the NEWEST candidate.
 *      With no timestamp to go on, the recent mention is the likely one, and it
 *      is also the cheapest place to reach.
 *
 * Returns the event `id`, which is what the renderer keys the highlight to.
 */
export function pickSearchTarget(
  events: readonly JumpCandidate[],
  opts: { terms: readonly string[]; ts: number | null },
): string | null {
  if (opts.terms.length === 0) return null;
  let best: { id: string; score: number; distance: number; index: number } | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as JumpCandidate;
    const text = e.text;
    if (!text || !textMatchesTerms(text, opts.terms)) continue;
    const score = termsPresent(text, opts.terms);
    // No usable pair of timestamps → every candidate is equally close, and rule
    // 4 (newest wins) decides. Infinity, not 0, so a candidate WITH a timestamp
    // is always preferred over one without when the hit has a `ts` to compare.
    const distance =
      opts.ts !== null && e.ts !== null ? Math.abs(e.ts - opts.ts) : Number.POSITIVE_INFINITY;
    if (
      !best ||
      score > best.score ||
      (score === best.score &&
        (distance < best.distance || (distance === best.distance && i > best.index)))
    ) {
      best = { id: e.id, score, distance, index: i };
    }
  }
  return best?.id ?? null;
}

/**
 * Could the hit still be found by paging further back?
 *
 * True when the hit is older than the oldest message loaded — the transcript
 * window opens on the server's 128 KB tail, so a hit from last week is simply
 * not in the document yet and no amount of searching it will help. False when
 * the hit's instant is already INSIDE the loaded range and we still found
 * nothing: paging then cannot produce it, and the honest answer is to say so.
 *
 * A hit with no `ts` is treated as seekable — we have no evidence either way,
 * and the caller's page budget bounds the cost of being wrong.
 */
export function jumpMayBeOlder(events: readonly JumpCandidate[], ts: number | null): boolean {
  if (ts === null) return true;
  let oldest: number | null = null;
  for (const e of events) {
    if (e.ts === null) continue;
    if (oldest === null || e.ts < oldest) oldest = e.ts;
  }
  return oldest === null || ts < oldest;
}
