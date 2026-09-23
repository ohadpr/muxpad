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
