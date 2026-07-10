/**
 * Cross-component plumbing for dragging a PANE (a strip pane-tab in
 * TabView) onto a sidebar tab row (NavTree) to move it there.
 *
 * The custom MIME marks the drag as a muxpad pane; its payload is the pane
 * id. But `dataTransfer.getData` is unreadable during dragover (only
 * `types` is exposed), so drop targets can't tell from the event alone
 * whether the pane is coming from THEMSELVES (a no-op). This module-level
 * mirror carries the origin for exactly that gating — the drop itself
 * always reads the real payload. Same pattern as NavTree's activeTabDrag.
 */
export const PANE_DRAG_MIME = 'application/x-muxpad-pane-id';

export interface PaneDragOrigin {
  paneId: string;
  fromTabId: string;
}

let active: PaneDragOrigin | null = null;

export function setActivePaneDrag(origin: PaneDragOrigin | null): void {
  active = origin;
}

export function getActivePaneDrag(): PaneDragOrigin | null {
  return active;
}
