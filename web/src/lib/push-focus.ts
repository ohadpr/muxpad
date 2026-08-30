// The pane a push-notification tap wants focused, held in a module variable
// (not React state) until the OWNING tab's TabView mounts or activates and
// consumes it. This is the DETERMINISTIC backstop for the two ways the racy
// `muxpad:show-pane` event misses:
//   1. The target TabView doesn't exist yet when the event fires — a
//      cross-workspace deep link whose tab list loads asynchronously.
//   2. The tab already has a different active pane, so the `?pane` URL seed is
//      ignored (TabView only seeds mobileActiveId from the URL when it's null).
// Set on push-navigate; consumed exactly once by the tab it targets.
let pending: { tabId: string; paneId: string; at: number } | null = null;

/**
 * How long an unconsumed entry stays armed.
 *
 * It is only ever consumed by the ONE tab it names, and there is no guarantee
 * that tab is ever rendered: a tap whose target tab was deleted from another
 * device, or a deep link into a workspace the navigator refuses to show,
 * leaves the slot loaded indefinitely. Weeks later, opening that tab for
 * ordinary reasons would silently yank the view to a pane the user last heard
 * about in a notification they've long forgotten. A tap is consumed within a
 * second or two of arriving, so anything past this window is stale by
 * definition. Matches PUSH_TARGET_TTL_MS — same event, same expiry.
 */
export const PUSH_FOCUS_TTL_MS = 120_000;

export function setPushFocusPane(tabId: string, paneId: string, now = Date.now()): void {
  pending = { tabId, paneId, at: now };
}

/** Return + clear the pending focus pane iff it targets `tabId` and is fresh. */
export function consumePushFocusPane(tabId: string, now = Date.now()): string | null {
  if (!pending) return null;
  if (now - pending.at > PUSH_FOCUS_TTL_MS) {
    // Expired. Drop it here rather than only on a matching read — otherwise a
    // target for a tab that never renders sits armed forever.
    pending = null;
    return null;
  }
  if (pending.tabId !== tabId) return null;
  const { paneId } = pending;
  pending = null;
  return paneId;
}

/** Test seam — clear the slot between cases. */
export function resetPushFocusPane(): void {
  pending = null;
}
