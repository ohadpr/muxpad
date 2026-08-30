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

/**
 * What dropping a dragged PANE on a workspace header should do.
 *
 *  - `new-tab`  — extract the pane into a fresh tab in that workspace.
 *  - `move-tab` — the pane is its tab's ONLY pane, so it effectively IS that
 *    tab: move the whole tab across instead. Extracting would delete a tab
 *    and rebuild an identical one, losing its name/icon/slug and bouncing
 *    anyone viewing it to the workspace root; a tab move keeps all of that
 *    and comes with an undo.
 *  - `none`     — a solo pane dropped on the workspace it already lives in.
 *    There is nothing to extract (the server refuses that churn), so the row
 *    must not advertise itself as a drop target either.
 *
 * Unknown origin (a drag whose mirror was never set) falls back to `new-tab`:
 * the server is the one that enforces the churn rule, and its answer for a
 * solo pane at home is a harmless no-op.
 */
export function paneDropAction(
  origin: PaneDragOrigin | null | undefined,
  destWorkspaceId: string,
): 'new-tab' | 'move-tab' | 'none' {
  if (!origin?.soloPane || !origin.fromWorkspaceId) return 'new-tab';
  return origin.fromWorkspaceId === destWorkspaceId ? 'none' : 'move-tab';
}
