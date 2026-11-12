/**
 * HOW LONG A PUBLISHED LINK HAS LEFT, as a reader sees it.
 *
 * A muxpad link answers for seven days and then 410s, and the only place
 * that fact lived was `muxpad publish --list` in a terminal. Here it is a
 * word on the row, in the same status channel the rest of the drawer uses —
 * so "expiring" reads as a warning and "live" does not read as anything.
 *
 * Pure, and exported on its own, because the thresholds are a judgement:
 * two days is when a link worth keeping is worth keeping NOW, and anything
 * further out is just noise on a row whose subject is the artifact.
 */
export interface PublishRecord {
  expires: number | null;
  expired: boolean;
}
export interface PublishTerm {
  label: string;
  /**
   * ITS OWN CHANNEL, not the worker one.
   *
   * This borrowed the drawer's worker states — and the comment claimed
   * "blocked=amber" when `blocked` is the hue for a worker WAITING ON A
   * HUMAN, which this theme renders in the danger red. So every link inside
   * two days shouted `2D LEFT` in red, and every healthy link wore a green
   * plate: 31 rows of alarm and reassurance about a thing that was simply
   * fine. A link's shelf life is not a worker's state and now says so.
   *
   *   live    — plenty of time. Drawn as quiet grey text, no plate.
   *   soon    — inside two days. The one that is allowed to be loud.
   *   expired — the link 410s. Grey, because nothing is wrong: the files
   *             are still there and one click brings it back.
   */
  state: 'live' | 'soon' | 'expired';
}

/** Below this, the row says so in the warning colour. */
const SOON_MS = 2 * 24 * 60 * 60 * 1000;

export function publishTerm(
  rec: PublishRecord | undefined,
  now: number = Date.now(),
): PublishTerm | null {
  if (!rec) return null;
  // Never expires: published before links had a shelf life, or set to 0 on
  // purpose. Saying "live" on every such row would be noise on most of them.
  if (rec.expires === null) return null;
  const left = rec.expires - now;
  if (rec.expired || left <= 0) return { label: 'expired', state: 'expired' };
  const days = Math.ceil(left / 86_400_000);
  return left <= SOON_MS
    ? { label: days <= 1 ? 'today' : `${days}d left`, state: 'soon' }
    : { label: `${days}d`, state: 'live' };
}
