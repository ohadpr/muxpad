import type { LayoutNode } from './types.js';

/**
 * Walk the binary layout tree, replacing the first leaf matching
 * `targetId` with a split.
 *
 * `position` controls which side of the split the new pane lands on:
 *   - 'after'  (default): `{ direction, first: target, second: newId }`
 *     — new pane is to the right (row) or below (column).
 *   - 'before':           `{ direction, first: newId, second: target }`
 *     — new pane is to the left (row) or above (column).
 *
 * Returns the (possibly modified) layout AND a `placed` flag telling
 * the caller whether `targetId` was actually found.
 *
 * Callers choose their own fallback when `placed === false`:
 *   - Server (`POST /api/tabs/:id/panes` with `append_to_layout`):
 *     fall back to a root-append so the new pane is still visible.
 *   - UI (`TabView.splitFromPane`): just return the layout unchanged
 *     — the UI knows exactly which pane was clicked, so a miss means
 *     a real bug, not a "where do I put this" question.
 *
 * Edge cases handled inside:
 *   - Empty layout (`null` / `''`): the new pane becomes the root;
 *     `placed` is true because the caller's "place this somewhere"
 *     intent is satisfied. `position` doesn't apply (no sibling).
 *   - Single-leaf layout: replaced with a split, `placed` true iff
 *     the leaf matched `targetId`. For single-leaf layouts the two
 *     resulting trees ("split at the leaf" and "root-append") are
 *     identical, so callers don't need to special-case this.
 */
export interface SpliceLayoutResult {
  layout: LayoutNode;
  placed: boolean;
}

export function spliceLayoutAtTarget(
  layout: LayoutNode,
  targetId: string,
  newId: string,
  direction: 'row' | 'column',
  position: 'after' | 'before' = 'after',
): SpliceLayoutResult {
  // Encapsulates the only place `position` affects the output: which side
  // of the split the new pane lands on. Keeps the walker below boring.
  const split = (target: string): LayoutNode =>
    position === 'before'
      ? { direction, first: newId, second: target }
      : { direction, first: target, second: newId };

  if (layout === '' || layout == null) {
    return { layout: newId, placed: true };
  }
  if (typeof layout === 'string') {
    return {
      layout: split(layout),
      placed: layout === targetId,
    };
  }
  let placed = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (typeof node === 'string') {
      if (node === targetId) {
        placed = true;
        return split(node);
      }
      return node;
    }
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  const next = walk(layout);
  return { layout: next, placed };
}

/**
 * Walk the binary layout tree and drop every leaf for which `keep` returns
 * false, collapsing any branch left with a single child. Returns `''` if the
 * whole tree is pruned away. Pure; the one collapse routine shared by:
 *   - `removeLeafFromLayout` (keep everything but one id) — pane moves, and
 *   - the server's `pruneDeadPanes` (keep only ids in a validity set) — load-
 *     time / migration cleanup.
 */
export function pruneLayout(layout: LayoutNode, keep: (paneId: string) => boolean): LayoutNode {
  if (layout === '' || layout == null) return '';
  if (typeof layout === 'string') return keep(layout) ? layout : '';
  const first = pruneLayout(layout.first, keep);
  const second = pruneLayout(layout.second, keep);
  if (first === '' && second === '') return '';
  if (first === '') return second;
  if (second === '') return first;
  return { ...layout, first, second };
}

/**
 * Remove the first leaf matching `paneId` from the tree, collapsing any
 * branch left with a single child. Returns `''` if the tree becomes empty.
 * Used by the pane-move endpoint to splice a pane out of its source tab.
 */
export function removeLeafFromLayout(layout: LayoutNode, paneId: string): LayoutNode {
  return pruneLayout(layout, (id) => id !== paneId);
}

/**
 * Append `paneId` as a new split wrapping the whole existing tree. Placement
 * is intentionally dumb — the pane lands as the second child of a single
 * top-level split (or becomes the root if the tree is empty). The move UX
 * deliberately doesn't let the user pick a target pane / side on arrival, so
 * a predictable root-append is all the destination tab needs.
 */
export function appendLeafToLayout(
  layout: LayoutNode,
  paneId: string,
  direction: 'row' | 'column' = 'row',
): LayoutNode {
  if (layout === '' || layout == null) return paneId;
  return { direction, first: layout, second: paneId };
}

/**
 * All leaf pane ids of the tree, in visual (left-to-right / top-to-bottom)
 * order. Used by the tab-merge endpoint to enumerate the panes being
 * re-homed; order matters so merged panes keep their strip order.
 */
export function collectLayoutLeaves(layout: LayoutNode): string[] {
  if (layout === '' || layout == null) return [];
  if (typeof layout === 'string') return [layout];
  return [...collectLayoutLeaves(layout.first), ...collectLayoutLeaves(layout.second)];
}
