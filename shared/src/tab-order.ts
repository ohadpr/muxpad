/**
 * The living sidebar's order for UNPINNED tabs: needs-attention first, then
 * most recently active.
 *
 * ── WHY THIS LIVES IN shared ─────────────────────────────────────────────────
 * It used to live on the server alone, as the sort behind GET /api/tabs, and
 * that made the server the only thing that could ever reorder the sidebar. The
 * client held the resulting sequence and deliberately did not re-derive it: a
 * `tab.updated` push patched the row IN PLACE and left the array order alone,
 * so a tab that had just become the most recently active one did not move until
 * the next 5s poll — and not at all while that poll is stopped, which it is for
 * a collapsed workspace or a hidden document. Coming back to the app after a
 * few minutes away showed an order minutes stale on EVERY device, which is
 * precisely when a recency-ordered sidebar is supposed to be most useful.
 *
 * The reason the client refused to sort was real — rows must not jump around
 * under the cursor — but that hazard already has an owner: `freezeActiveTab`
 * (web/src/lib/tab-freeze.ts) holds the row you are ON where you found it and
 * lets everything else re-sort around it, which that file calls "the whole
 * point of a living sidebar". The two behaviours contradicted each other; this
 * is the shared definition that lets the client honour the same order the
 * server publishes, immediately, without a refetch.
 */

/** The fields the order actually reads. A superset of both Tab and the
 *  decorated row, so either side can pass what it already has. */
export interface SortableTab {
  id: string;
  status?: 'blocked' | 'working' | 'ready' | 'dead' | 'idle' | undefined;
  attention?: boolean | undefined;
  last_activity_at?: number | null | undefined;
  /** See {@link userTouchAt} — the key the GLOBAL list orders on. */
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

/** "This tab wants you NOW" — the one condition still worth reordering for.
 *  Reads `status` when the row carries it and falls back to the deprecated
 *  `attention` alias otherwise. The fallback is not decoration: `attention` is
 *  the raw BEL bit, and an AGENT chat never rings BEL — so a pane parked on
 *  `ask_user`, the highest-value case there is, would get no promotion at all
 *  if this partitioned on `attention` alone. */
export function tabWantsYou(t: SortableTab): boolean {
  return t.status === 'blocked' || t.attention === true;
}

export function compareUnpinnedTabs(
  a: SortableTab,
  b: SortableTab,
  _positions?: Map<string, number>,
): number {
  const attn = Number(tabWantsYou(b)) - Number(tabWantsYou(a));
  if (attn !== 0) return attn;
  // Nulls last: -Infinity is smaller than any real timestamp, and we sort
  // descending, so a never-active tab lands at the bottom of its partition.
  const at =
    (b.last_activity_at ?? Number.NEGATIVE_INFINITY) -
    (a.last_activity_at ?? Number.NEGATIVE_INFINITY);
  // NaN guard: (-Inf) - (-Inf) is NaN, which would make the comparator
  // inconsistent and the sort implementation-defined.
  if (at !== 0 && !Number.isNaN(at)) return at < 0 ? -1 : 1;
  // Only wire fields may break ties. The server's manual positions are NOT
  // the client's last published indices: status/recency can reorder them.
  // IDs give both sides the same total order, even when a push creates a tie.
  // The optional legacy argument is ignored; pinned manual order is separate.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The GLOBAL list's order — the same shape as {@link compareUnpinnedTabs} with
 * the recency key swapped for {@link userTouchAt}.
 *
 * Deliberately a SECOND comparator rather than a change to the first. The two
 * lists answer different questions and the codebase already has the bug class
 * where one value gets two meanings:
 *
 *   per workspace  "what is going on in here" — you chose the workspace, so
 *                  the machine's activity is signal. Unchanged, and every
 *                  surface that reads the server's published order (the tree,
 *                  the sheet's picked list, quick-switch numbering, the search
 *                  ranking) keeps exactly the order it has today.
 *   globally       "what was I doing" — you chose nothing, so only YOUR acts
 *                  can rank 58 chats across three workspaces.
 *
 * The attention partition is IDENTICAL and is kept on purpose: `blocked` is the
 * one bit the mobile rail still draws per row, and a global list that buried a
 * chat waiting on you would be a regression in the surface's one loud signal.
 * Only the recency key below it moves.
 */
export function compareByUserTouch(a: SortableTab, b: SortableTab): number {
  const attn = Number(tabWantsYou(b)) - Number(tabWantsYou(a));
  if (attn !== 0) return attn;
  // Nulls last, NaN-guarded — the same reasoning as compareUnpinnedTabs, and
  // for the same reason: (-Inf) - (-Inf) is NaN, which makes a comparator
  // inconsistent and its sort implementation-defined.
  const at =
    (userTouchAt(b) ?? Number.NEGATIVE_INFINITY) - (userTouchAt(a) ?? Number.NEGATIVE_INFINITY);
  if (at !== 0 && !Number.isNaN(at)) return at < 0 ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The published sidebar order for one workspace's tabs: the pinned block in its
 * manual order, untouched, then the unpinned block by `compareUnpinnedTabs`.
 *
 * Unpinned ties use the wire ID, independent of any previous array order.
 * The optional positions argument remains for source compatibility only.
 */
export function sortSidebarTabs<T extends SortableTab & { pinned?: boolean | undefined }>(
  tabs: readonly T[],
  positions: Map<string, number> = new Map(),
): T[] {
  const pinned = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned).sort((a, b) => compareUnpinnedTabs(a, b, positions));
  return [...pinned, ...rest];
}
