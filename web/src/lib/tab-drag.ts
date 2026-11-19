/**
 * What a sidebar tab drag is allowed to MEAN.
 *
 * Drag-to-reorder is a pinned-only gesture. It began as a consequence: the
 * unpinned block was auto-sorted (attention → recency) and re-derived on every
 * poll, so any order you dragged it into evaporated seconds later. Earlier
 * rounds papered over that by PINNING whatever unpinned tab you dropped — a
 * gesture that silently changed a tab's category to make the drag mean
 * something. It surprised more than it helped, so:
 *
 *   - PINNED tab dragged → reorder within the pinned block, nothing else.
 *   - UNPINNED tab dragged → a MOVE only: drop it on another workspace to
 *     re-home it. Dropping it anywhere in its own list does nothing at all.
 *   - Pinning stays explicit (the row's pin affordance / ⋯ menu).
 */
import { reorderByDrop } from './reorder';

export interface DraggableTab {
  id: string;
  pinned?: boolean | undefined;
}

/**
 * The order to apply after dropping pinned tab `from` onto pinned tab `to`.
 *
 * Returns null when the drop is not a pinned-block reorder (either end
 * unpinned or unknown) — the caller must then do nothing, which is the whole
 * point: an unpinned tab cannot be reordered, and dropping ONTO one can't
 * define a manual position either.
 *
 * `pinnedIds` is what gets persisted; `allIds` is the optimistic client-side
 * order, with the unpinned block left exactly as the server last returned it.
 *
 * NOTE THAT THE ORIGINAL REASON HAS EXPIRED. The unpinned block is no longer
 * auto-sorted — it is the stored manual order (shared/tab-order) — so an order
 * dragged into it would now survive. Extending the gesture is a real option;
 * it is not what this function does, and the restriction above should be read
 * as a decision from here on rather than as a consequence.
 */
export function orderAfterPinnedDrop(
  tabs: DraggableTab[],
  from: string,
  to: string,
): { pinnedIds: string[]; allIds: string[] } | null {
  const dragged = tabs.find((t) => t.id === from);
  const target = tabs.find((t) => t.id === to);
  if (!dragged?.pinned || !target?.pinned) return null;
  const pinnedIds = tabs.filter((t) => t.pinned).map((t) => t.id);
  const nextPinned = reorderByDrop(pinnedIds, from, to);
  if (nextPinned === pinnedIds) return null; // from === to, or a stale id
  const rest = tabs.filter((t) => !t.pinned).map((t) => t.id);
  return { pinnedIds: nextPinned, allIds: [...nextPinned, ...rest] };
}

// `paneDropAction` lived here: it decided whether a PANE dragged from the tab
// strip could be dropped on a workspace header (becoming a new tab there). That
// drop is gone along with tab-into-tab merging — the sidebar now takes exactly
// one drop, a TAB onto a WORKSPACE — so the predicate had no callers left.
