/**
 * One-shot navigation hint for the gather gestures (tab merge, pane move).
 *
 * When a gesture dissolves the tab the user is LOOKING AT (merge of the
 * viewed tab; its last pane dragged away), the deletion arrives as a
 * tab.removed event whose handler redirects to the workspace ROOT — dumping
 * the user away from the panes they just moved (and racing any explicit
 * post-await navigate the gesture might try). Instead, the gesture records
 * where the panes went BEFORE calling the API, keyed by the source tab id;
 * the redirect consults (and consumes) the hint and lands on the
 * destination. A hint nobody consumes — the source tab wasn't the active
 * one, or the call failed — expires harmlessly.
 */
interface FollowTarget {
  sourceTabId: string;
  wsSlug: string;
  tabSlug: string;
  at: number;
}

let target: FollowTarget | null = null;

const TTL_MS = 10_000;

export function setFollowTarget(sourceTabId: string, wsSlug: string, tabSlug: string): void {
  target = { sourceTabId, wsSlug, tabSlug, at: Date.now() };
}

/**
 * Retract the hint when the gesture turns out NOT to remove the source tab
 * (move failed, no-op, or the source kept other panes) — a lingering hint
 * would be consumed by a later UNRELATED removal of that tab (the user
 * closing it by hand) and teleport them to a stale destination.
 */
export function clearFollowTarget(sourceTabId: string): void {
  if (target?.sourceTabId === sourceTabId) target = null;
}

/**
 * Consume the hint for this removed tab. Only a matching source consumes it
 * — an unrelated tab.removed (user closed something else) must not teleport
 * the user to a stale destination.
 */
export function consumeFollowTarget(
  removedTabId: string,
): { wsSlug: string; tabSlug: string } | null {
  if (!target || target.sourceTabId !== removedTabId) return null;
  const t = target;
  target = null;
  if (Date.now() - t.at > TTL_MS) return null;
  return { wsSlug: t.wsSlug, tabSlug: t.tabSlug };
}
