// The pane a push-notification tap wants focused, held in a module variable
// (not React state) until the OWNING tab's TabView mounts or activates and
// consumes it. This is the DETERMINISTIC backstop for the two ways the racy
// `muxpad:show-pane` event misses:
//   1. The target TabView doesn't exist yet when the event fires — a
//      cross-workspace deep link whose tab list loads asynchronously.
//   2. The tab already has a different active pane, so the `?pane` URL seed is
//      ignored (TabView only seeds mobileActiveId from the URL when it's null).
// Set on push-navigate; consumed exactly once by the tab it targets.
let pending: { tabId: string; paneId: string } | null = null;

export function setPushFocusPane(tabId: string, paneId: string): void {
  pending = { tabId, paneId };
}

/** Return + clear the pending focus pane iff it targets `tabId`. */
export function consumePushFocusPane(tabId: string): string | null {
  if (pending?.tabId === tabId) {
    const { paneId } = pending;
    pending = null;
    return paneId;
  }
  return null;
}
