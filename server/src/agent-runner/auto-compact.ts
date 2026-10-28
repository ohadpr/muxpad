/**
 * COMPACTION HAPPENS ON ITS OWN, AND NOBODY IS ASKED ABOUT IT.
 *
 * ─── What this reverses, and why that is not a mistake ─────────────────────
 *
 * muxpad used to compact nothing on a percentage, deliberately. The rule was
 * written after a 200k window silently rewrote live threads (measured on one:
 * two automatic compactions in three hours, 372k tokens of verbatim history
 * gone), and it was a good rule for the thing it was reacting to — a
 * compaction cannot be undone from inside a session, so it is a decision.
 *
 * The cost of making it the reader's decision was a number on screen. A cell
 * that appeared at 70% and turned red at 88%, in a chat, whose only purpose
 * was to make somebody feel the ceiling coming. The instruction that replaced
 * it is exactly about that cost: "I don't want the user to be thinking about
 * compaction. Compaction should just happen without putting the user into
 * stress all the time. If we need to adjust down the point of context where
 * compaction happens… just pick it, and it should just happen automagically."
 *
 * So the decision moves back to the machine, and the two things that made the
 * old automatic compaction bad do not come with it:
 *
 *  · IT FIRES AT A PERCENTAGE OF THE MODEL'S REAL WINDOW, not of an imposed
 *    cap. The thread that lost 372k tokens was on a 1M model with a 200k
 *    window configured under it, so "full" arrived at a fifth of the room it
 *    actually had.
 *  · IT COMPACTS WITH INSTRUCTIONS. Unguided, the observed result was 216k
 *    tokens in and 4,663 out — the shape of the conversation kept and the
 *    specifics it was made of lost. Same instructions the Compact button and
 *    the overflow self-heal use.
 *
 * ─── The threshold, and why 90 ─────────────────────────────────────────────
 *
 * The harness compacts on its own near the ceiling (~95% observed on this
 * machine: a session that triggered at 968,136 of 1,000,000). That is already
 * automatic, and 90 is not an attempt to beat it to the punch for its own
 * sake. It is a margin: at 95% a single long agentic turn can cross the
 * remaining 50k inside one tool loop and fail the send instead of compacting
 * it, which is the failure `context-heal.ts` exists to clean up after. Ten
 * points of headroom is about two long turns' worth of growth.
 *
 * ─── Hysteresis, which is the whole implementation ─────────────────────────
 *
 * A compaction does not reliably land under the threshold — it frees what the
 * history allows, and a thread that is mostly recent turns may come back at
 * 88%. Firing on "pct >= 90" alone would then compact again on the next status
 * frame, and again, which is the loop that turns a conversation into a
 * paragraph. So the trigger ARMS only after the fill has fallen back under a
 * lower mark, and a compaction that frees nothing fires exactly once.
 */

/** Fire a compaction at this fill. See the note above for the margin argument. */
export const AUTO_COMPACT_PCT = 90;

/**
 * …and do not fire again until the fill has come back DOWN past this.
 *
 * Not a "close enough to 90" number: it is the point below which a second
 * compaction would have real history to work with. A compaction that lands at
 * 88% has already taken what it could; one that lands at 70% means the thread
 * has grown a whole new conversation since.
 */
export const AUTO_COMPACT_REARM_PCT = 75;

export class AutoCompactor {
  /** False from the moment one fires until the fill drops past the re-arm. */
  private armed = true;

  /**
   * Should this status reading trigger a compaction?
   *
   * `inTurn` is a hard gate rather than a preference: `/compact` rides the
   * normal turn queue, so firing mid-turn would park it behind the running
   * work and compact against a context that has moved on by the time it runs.
   * The next status refresh after the turn ends sees the same fill and fires
   * then — which is the moment a compaction is cheapest anyway.
   */
  consider(pct: number | undefined, inTurn: boolean): boolean {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return false;
    if (pct <= AUTO_COMPACT_REARM_PCT) this.armed = true;
    if (inTurn) return false;
    if (!this.armed || pct < AUTO_COMPACT_PCT) return false;
    this.armed = false;
    return true;
  }
}
