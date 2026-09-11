// CLAIMING WORK, AND KNOWING WHEN IT STOPPED MATTERING.
//
// Two independent hazards, one registry.
//
// HAZARD 1 — DUPLICATE DELIVERY. `session.delegation.created` is not
// exactly-once; the contract says so outright. An agent turn costs minutes and
// real money, so "handle it twice" is not a cosmetic bug, it is two Claude
// sessions racing to edit the same repo. Every delegation is therefore CLAIMED
// before any work starts: `claim` returns a context the first time and null
// forever after, and the caller's only legal response to null is to do nothing
// at all. Claiming is synchronous and happens before the first await, which is
// what makes it a lock rather than a hint.
//
// HAZARD 2 — STALE RESULTS. Voice conversations move; agent turns do not. The
// user asks for X, waits four seconds, changes their mind and asks for Y. The
// X turn is still running and will eventually produce a reply, and speaking it
// after the user has moved on is worse than saying nothing. So tasks are
// VERSIONED: a revision counter bumps whenever the conversation moves on, each
// claim snapshots it, and every deferred path — the settle timer, the long-work
// heartbeat, each append — re-checks `currentRevision() !== ctx.revision` and
// returns. This mirrors the canonical adapter exactly, and it is the only
// correct shape: you cannot cancel an agent turn's tail, you can only refuse
// to speak it.
//
// Note that the two hazards want opposite things from memory. Duplicate
// suppression wants ids remembered forever; staleness wants state forgotten so
// it doesn't grow. The split below is deliberate: FULL contexts are dropped
// when finished, but ids stay in a bounded FIFO of seen ids, which is small
// and lets a duplicate be recognised long after its work completed.

export interface DelegationContext {
  readonly id: string;
  /** Conversation revision at claim time. Compared, never displayed. */
  readonly revision: number;
  readonly claimedAt: number;
  /** The delegation's `offset_ms`, kept so the settle timer can re-ask the
   *  transcript buffer for a sentence that has since finished arriving. */
  readonly offsetMs: number;
}

/** How many delegation ids to remember for duplicate suppression. A voice
 *  session is minutes long and delegates single digits per minute; this is
 *  three orders of magnitude of headroom, and bounded so a pathological
 *  session cannot grow without limit. */
const SEEN_CAP = 512;

export class DelegationRegistry {
  private revision = 0;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly open = new Map<string, DelegationContext>();

  /**
   * Take exclusive ownership of a delegation.
   *
   * Returns a context on the FIRST call for an id and null on every
   * subsequent call, including calls that arrive long after the work has
   * finished. Idempotent by construction: there is no window between the
   * membership test and the insert, because this function does not await.
   */
  claim(id: string, opts: { now: number; offsetMs: number }): DelegationContext | null {
    if (!id || this.seen.has(id)) return null;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_CAP) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
    const ctx: DelegationContext = {
      id,
      revision: this.revision,
      claimedAt: opts.now,
      offsetMs: opts.offsetMs,
    };
    this.open.set(id, ctx);
    return ctx;
  }

  /** Has this id ever been claimed? Duplicate detection for callers that want
   *  to log the duplicate rather than silently drop it. */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * The conversation has moved on — everything claimed before now is stale.
   *
   * Called when a NEW delegation is claimed, when the user barges in, and when
   * the session restarts. Returns the new revision.
   */
  bumpRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  currentRevision(): number {
    return this.revision;
  }

  /**
   * The one predicate every deferred path asks before it acts. A finished
   * delegation is stale too: its turn is over, and a late append against it
   * would narrate work nobody is waiting on.
   */
  isStale(ctx: DelegationContext): boolean {
    return this.currentRevision() !== ctx.revision || !this.open.has(ctx.id);
  }

  /** The newest still-open delegation — the one live results belong to. */
  active(): DelegationContext | undefined {
    let best: DelegationContext | undefined;
    for (const ctx of this.open.values()) {
      if (!best || ctx.claimedAt >= best.claimedAt) best = ctx;
    }
    return best;
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  /** Work is done (or abandoned). The id stays in `seen`, so a duplicate
   *  delivery after completion is still refused. */
  finish(id: string): void {
    this.open.delete(id);
  }

  /** End of session. Open work is abandoned and the revision bumps so any
   *  timer that survives the teardown finds itself stale. */
  reset(): void {
    this.open.clear();
    this.bumpRevision();
  }
}
