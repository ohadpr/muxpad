/**
 * New ordering after dragging `from` and dropping it onto `to`.
 *
 * Direction-aware so an item can reach either end: dragging downward (the
 * dragged item starts before the target) drops it AFTER the target; dragging
 * upward drops it BEFORE. Returns the input unchanged when from===to or either
 * id is missing.
 */
export function reorderByDrop(ids: string[], from: string, to: string): string[] {
  if (from === to) return ids;
  const fromIdx = ids.indexOf(from);
  const toIdx = ids.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return ids;
  const next = ids.slice();
  next.splice(fromIdx, 1);
  let insertAt = next.indexOf(to);
  if (fromIdx < toIdx) insertAt += 1; // dragged downward → land after target
  next.splice(insertAt, 0, from);
  return next;
}
