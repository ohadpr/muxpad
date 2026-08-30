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
  /** Workspace the pane's tab lives in — lets a workspace row tell "into
   *  somewhere else" from "back where it came from" during dragover. */
  fromWorkspaceId?: string;
  /** True when this pane is the only one in its tab. Such a pane IS its tab,
   *  so "extract it into a new tab here" is a no-op at home (the server
   *  refuses the identity churn) and a whole-tab move anywhere else. Drop
   *  targets use it to avoid advertising a gesture that would do nothing. */
  soloPane?: boolean;
}

export const paneDragOrigin = createDragOrigin<PaneDragOrigin>();
