// Which read-state acknowledgement an open tab sends — the decision TabView's
// seen-effect makes, pulled out so it can be held to its meaning in a test.
//
// The question is "which panes is the reader looking at?", and the answer
// depends on how the tab is LAID OUT, not on the device: the split mosaic shows
// every pane at once, so the whole tab is seen (bulk `/tabs/:id/seen`); any
// single-pane arrangement — mobile, AND desktop 'tabbed' mode — shows one pane
// and the hidden siblings must keep flagging (surgical `/panes/:id/seen`).
// Keying this on `isMobile` bulk-cleared hidden siblings in desktop tabbed mode:
// a hidden pane's turn finishing moved the seen-signature, and the bulk route
// wiped the bold off a reply nobody had seen.

export type SeenAck = { kind: 'pane'; id: string } | { kind: 'tab'; id: string } | null;

export function seenAckTarget(opts: {
  /** `isMobile || viewMode === 'tabbed'` — one pane visible at a time. */
  singlePane: boolean;
  /** The pane a single-pane view is showing (null when none resolves). */
  activePaneId: string | null;
  tabId: string;
}): SeenAck {
  if (opts.singlePane) return opts.activePaneId ? { kind: 'pane', id: opts.activePaneId } : null;
  return { kind: 'tab', id: opts.tabId };
}
