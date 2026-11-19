/**
 * The sidebar's order: the pinned block first, in its manual order, then
 * everything else in the order it was given.
 *
 * ── IT USED TO SORT, AND THAT IS THE CHANGE ─────────────────────────────────
 * The unpinned block was auto-sorted: chats that wanted you NOW first, then
 * most recently touched. The sidebar was meant to be "living" — rows rising
 * and falling as work moved — and both halves of that turned out to cost more
 * than they bought.
 *
 * RECENCY had already been narrowed twice before it was removed. It first read
 * `last_activity_at`, which a tailing log bumps every five seconds: measured
 * on the live cockpit, six `working` chats held six of the global top seven,
 * all under a minute old, none of it anything the user had done. Moving it to
 * `last_user_at` fixed that and left the deeper problem — the list still
 * rearranged itself while you were reading it. The machinery that grew around
 * that is the evidence: a client-side re-sort on every `tab.updated` so the
 * order would not go stale, and `tab-freeze` on top of it to hold the one row
 * you were standing on still while the rest moved under your cursor. Two
 * mechanisms, in opposite directions, to make a moving list usable.
 *
 * ATTENTION went for a plainer reason: "this chat is blocked" is a thing to
 * SAY on a row, not a reason to move it. A row that jumps when its agent
 * changes state is a row you cannot point at — OpenBot shipped an
 * attention-promoting default in 0.67.0 and shipped the switch to turn it off
 * in 0.68.0, one day later, after users said it was "really breaking
 * organizing our agents for us".
 *
 * So the order is now MANUAL and stable: pinned rows where you put them, the
 * rest in their stored position, new rows appended. Status is on the row —
 * spinner, `YOU`, unread bold — and a collapsed workspace still carries its
 * rollup mark, so nothing is hidden by a list that holds still.
 *
 * RECENCY DID NOT DISAPPEAR, it moved: ⌘K with an empty query lists the chats
 * you touched most recently, across every workspace, each naming the workspace
 * it lives in (web/src/lib/nav-search `recentTabs`). That is the surface a
 * recency order belongs on — one you open, read and leave — rather than one
 * you are trying to point at.
 *
 * ── WHY THIS STILL LIVES IN shared ──────────────────────────────────────────
 * Both sides run it. The server publishes the order; the client re-applies the
 * same rule when it splices a pushed row in, so a `tab.updated` cannot put the
 * pinned divider in the wrong place and an inserted row lands where the server
 * would have put it.
 */

/** The fields the two functions below read. A superset of both Tab and the
 *  decorated row, so either side can pass what it already has.
 *
 *  `status` and `attention` are deliberately NOT here any more: they were read
 *  by the comparator that promoted a blocked chat, and leaving them on this
 *  type would be an invitation to read them again. The order does not know
 *  what a chat is doing. */
export interface SortableTab {
  id: string;
  last_activity_at?: number | null | undefined;
  /** See {@link userTouchAt} — the key the recents list orders on. */
  last_user_at?: number | null | undefined;
}

/**
 * WHEN YOU LAST TOUCHED THIS CHAT — and why it is not `last_activity_at`.
 *
 * `last_activity_at` is bumped by pty OUTPUT (sampled every 5s) as well as by
 * you. Inside ONE workspace that is tolerable and is the shipped behaviour: you
 * already know where you are, the list is your current context, and a chat that
 * is producing output is at least a chat that is doing something.
 *
 * ACROSS all workspaces it stops being tolerable, because there the order is
 * the whole surface. Measured on the live cockpit while this was written: 6 of
 * 58 chats were `working` and they held 6 of the global top 7, all under a
 * minute old, none of them anything the user had done. A list whose top is
 * "whichever agent printed a line most recently" is a churn feed, not a way
 * back to what you were doing — and migration v27 had already written the
 * sentence for a different column: *"a chat left tailing a log would be
 * immortal"*.
 *
 * So the global list reads `last_user_at`: stamped by tab CREATION and by the
 * acts that restart the decay clock (a message you sent, an unarchive), and by
 * nothing the machine does on its own. See migrations v33.
 *
 * ── THE FALLBACK IS WIRE COMPAT, NOT A SECOND POLICY ─────────────────────────
 * `last_user_at` is NOT NULL on every row a current server publishes, including
 * rows that predate it (v33 backfills them). `undefined` here therefore means
 * exactly one thing — an OLDER server that has no such column — and falling
 * back to `last_activity_at` degrades that client to today's ordering rather
 * than to no ordering at all. It is not a tier the current product ever enters.
 */
export function userTouchAt(t: SortableTab): number | null {
  return t.last_user_at ?? t.last_activity_at ?? null;
}

/* `tabWantsYou`, `compareUnpinnedTabs` and `compareByUserTouch` USED TO LIVE
 * HERE, and deleting them is the point — see the file note above.
 *
 * `compareByUserTouch` had already gone for its own reason, worth keeping
 * because it is the same lesson: it was a SECOND comparator for the global
 * list, kept separate on the argument that the two lists answer different
 * questions ("what is going on in here" vs "what was I doing"). The
 * per-workspace list then moved onto the same key, leaving the two functions
 * byte-for-byte identical while the docstring went on claiming they differed.
 * Two identical functions are not two policies.
 *
 * What survives of all three is `userTouchAt` below, which is a measurement
 * rather than an order, and is now read by one caller: the ⌘K recents list. */

/**
 * The published sidebar order for one workspace's tabs.
 *
 * STABLE. The pinned block keeps its manual order and the rest keep theirs;
 * nothing here reads status, activity or recency, which is the whole point.
 * `Array.prototype.sort` is not involved at all — a comparator returning 0 for
 * every pair would do the same thing while inviting someone to add a key to
 * it.
 *
 * The caller supplies the order it wants preserved: the server passes its
 * stored `position` order, and the client passes the array it is holding with
 * a new row appended.
 */
export function sortSidebarTabs<T extends SortableTab & { pinned?: boolean | undefined }>(
  tabs: readonly T[],
): T[] {
  // PINNED FIRST is the one rearrangement left, and it is not a sort: the
  // sidebar draws its divider at `tabs.filter(t => t.pinned).length`, so the
  // two blocks have to be contiguous or the divider lands in the wrong place.
  const pinned = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  return [...pinned, ...rest];
}
