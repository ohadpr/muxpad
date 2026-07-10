import { createDragOrigin } from './drag-origin';

/**
 * Cross-component plumbing for dragging a PANE (a strip pane-tab in
 * TabView) onto a sidebar tab row (NavTree) to move it there. The custom
 * MIME marks the drag as a muxpad pane; its payload is the pane id. The
 * origin mirror (see drag-origin.ts) lets drop targets gate their hover
 * affordance during dragover. NavTree's tab drags use the same factory.
 */
export const PANE_DRAG_MIME = 'application/x-muxpad-pane-id';

export interface PaneDragOrigin {
  paneId: string;
  fromTabId: string;
}

export const paneDragOrigin = createDragOrigin<PaneDragOrigin>();
