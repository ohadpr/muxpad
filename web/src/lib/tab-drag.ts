/**
 * What a sidebar tab drag is allowed to MEAN.
 *
 * Two gestures share the row, and they are told apart by where you drop:
 *
 *   - ONTO ANOTHER ROW IN THE SAME BLOCK → reorder, persisted.
 *   - ONTO A WORKSPACE HEADER            → move it there (WorkspaceNode).
 *
 * ── REORDER USED TO BE PINNED-ONLY, AND THAT WAS A CONSEQUENCE ──────────────
 * The unpinned block was auto-sorted (attention → recency) and re-derived on
 * every poll, so any order you dragged it into evaporated seconds later.
 * Earlier rounds papered over that by PINNING whatever unpinned tab you
 * dropped — a gesture that silently changed a tab's category to make the drag
 * mean something, and it surprised more than it helped.
 *
 * The block is stable now (shared/tab-order), so a dragged order survives, and
 * without this the order was two-thirds of a design: no recency, no drag,
 * therefore permanently "oldest first" with no way to arrange it.
 *
 * ── A DROP ACROSS A BLOCK BOUNDARY IS STILL REFUSED ─────────────────────────
 * Pinned ↔ unpinned, and live ↔ done. Not an oversight: dropping an unpinned
 * row onto a pinned one is the "it silently pins it" gesture coming back, and
 * dropping a live chat into the done drawer is a retirement performed by
 * accident. Both of those are explicit acts with their own affordances. What
 * the two blocks DO share is the persisted order, so a reorder writes the
 * whole list.
 */
import { reorderByDrop } from './reorder';

export interface DraggableTab {
  id: string;
  pinned?: boolean | undefined;
  /** Finished — archived, decayed, or a worker that delivered. These live in
   *  their own drawer, which is its own block. */
  done?: boolean | undefined;
}

/** Which block a row belongs to. Two rows may only be reordered against each
 *  other when these agree. */
function blockOf(t: DraggableTab): string {
  return `${t.pinned ? 'pin' : 'free'}:${t.done ? 'done' : 'live'}`;
}

/**
 * The order to apply after dropping `from` onto `to`.
 *
 * Returns null when the drop is not a legal reorder — a different block at
 * either end, an unknown id, or a row dropped on itself — and the caller must
 * then do nothing.
 *
 * `ids` is the WHOLE list in its new display order, which is what gets
 * persisted: `POST /api/tabs/reorder` writes `position = index` for every id
 * it is given, so passing one block alone would leave the other block's
 * positions describing an order nobody is looking at. It is also what the
 * client applies optimistically, so the two cannot disagree.
 */
export function orderAfterDrop(
  tabs: DraggableTab[],
  from: string,
  to: string,
): { ids: string[] } | null {
  if (from === to) return null;
  const dragged = tabs.find((t) => t.id === from);
  const target = tabs.find((t) => t.id === to);
  if (!dragged || !target) return null;
  if (blockOf(dragged) !== blockOf(target)) return null;
  const ids = tabs.map((t) => t.id);
  const next = reorderByDrop(ids, from, to);
  if (next === ids) return null; // a stale id the list no longer holds
  return { ids: next };
}

// `paneDropAction` lived here: it decided whether a PANE dragged from the tab
// strip could be dropped on a workspace header (becoming a new tab there). That
// drop is gone along with tab-into-tab merging — the sidebar now takes exactly
// one drop, a TAB onto a WORKSPACE — so the predicate had no callers left.
