/**
 * What a sidebar tab drag is allowed to MEAN.
 *
 * Manual order is a pinned-only concept: the unpinned block is auto-sorted
 * (attention → recency) and re-derived on every poll, so any order you
 * drag it into would evaporate seconds later. Earlier rounds papered over
 * that by PINNING whatever unpinned tab you dropped — a gesture that silently
 * changed a tab's category to make the drag mean something. It surprised more
 * than it helped, so:
 *
 *   - PINNED tab dragged → reorder within the pinned block, nothing else.
 *   - UNPINNED tab dragged → a MOVE only: drop it on another workspace to
 *     re-home it. Dropping it anywhere in its own list does nothing at all.
 *   - Pinning stays explicit (the row's pin affordance / ⋯ menu).
 */
import type { PaneDragOrigin } from './pane-drag';
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
 * `pinnedIds` is what gets persisted (the server stores manual order for the
 * pinned block only); `allIds` is the optimistic client-side order, with the
 * auto-sorted block left exactly as the server last returned it.
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
