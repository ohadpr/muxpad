/**
 * Should a tab URL be treated as DEAD and bounced to the workspace root?
 *
 * Pulled out of WorkspaceLayout's effect so the decision is testable without a
 * router, a cache or a clock — the effect around it is plumbing; this is the
 * part that was wrong.
 *
 * ─── WHAT IT GOT WRONG ──────────────────────────────────────────────────────
 * The effect needs to know whether the tab list is FRESH before concluding that
 * a slug is gone, and it used to infer that from `tabs.length ===
 * workspace.tab_count` — two numbers from two different endpoints that refresh
 * independently. Creating a chat moves them one at a time: the optimistic row
 * makes the list N+1 while the workspace rollup still says N, then the rollup
 * catches up. If the list is momentarily stale when that second update lands,
 * the two numbers agree while the list does NOT contain the tab you are
 * standing on — so the guard passes and the URL is declared dead.
 *
 * The user sees: a new chat is created, and they are put back on the one they
 * came from (the workspace root redirects to the last-visited tab). Measured at
 * 4 clicks in 6, and 6 in 6 once console logging shifted the timing.
 *
 * So freshness is no longer INFERRED. The caller asks the server and passes the
 * answer in. This function only decides what to do with it.
 */
export interface StaleUrlInput {
  /** The slug in the address bar, or null when the URL names no tab. */
  urlTabSlug: string | null;
  /** The list we already hold. */
  cached: readonly { slug: string }[];
  /**
   * The list the SERVER just confirmed, or null when we could not ask (offline,
   * a failed fetch, a request still in flight).
   */
  confirmed: readonly { slug: string }[] | null;
}

export function tabUrlIsDead(i: StaleUrlInput): boolean {
  if (!i.urlTabSlug) return false;
  // Present in what we hold: nothing to recover from, and no reason to ask.
  if (i.cached.some((t) => t.slug === i.urlTabSlug)) return false;
  // We could not confirm. A failed read is not evidence that a tab is gone, and
  // the cost of being wrong is throwing the user off a page that works.
  if (!i.confirmed) return false;
  return !i.confirmed.some((t) => t.slug === i.urlTabSlug);
}
