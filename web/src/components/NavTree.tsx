import {
  DEFAULT_TAB_ICON,
  type PaneSpec,
  type Tab,
  type Workspace,
  collectLayoutLeaves,
} from '@muxpad/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { HOUSE_CHAT_CREATE, HOUSE_CHAT_PANE_CREATE } from '../lib/agent-backend';
import { createDragOrigin } from '../lib/drag-origin';
import { clearFollowTarget, setFollowTarget } from '../lib/follow-tab';
import { getLastPaneId, setLastPaneId } from '../lib/last-visited';
import { pushUndo } from '../lib/move-undo-store';
import { isExpanded, toggleExpanded, useNavExpansion } from '../lib/nav-expansion';
import { tabRowAffordances } from '../lib/nav-row-affordances';
import { PANE_DRAG_MIME, type PaneDragOrigin, paneDragOrigin } from '../lib/pane-drag';
import { reorderByDrop } from '../lib/reorder';
import { orderAfterPinnedDrop, paneDropAction } from '../lib/tab-drag';
import { useFrozenTabOrder } from '../lib/tab-freeze';
import { useDismissable } from '../lib/use-dismissable';
import { applyTabOrder, refreshTabs, useTabs } from '../tabs';
import { useLongPress } from '../use-long-press';
import { MAX_QUICK_SWITCH_TABS, useTabQuickSwitch } from '../use-tab-quickswitch';
import {
  applyWorkspaceOrder,
  refreshWorkspaces,
  useWorkspaces,
  visibleWorkspaces,
} from '../workspaces';
import { NewTabButton } from './NewTabButton';
import { StatusMark } from './StatusMark';
import { SvgClose } from './icons';
import './NavTree.css';

// Lazy so emoji-mart + its dataset load only when the picker is opened.
const EmojiMartPicker = lazy(() => import('./EmojiMartPicker'));

/** Match emoji-mart's light/dark skin to the active muxpad theme via --bg luminance. */
function pickerTheme(): 'light' | 'dark' {
  try {
    // Resolve --bg through a hidden probe: the browser normalizes whatever
    // format the theme uses (hex, rgb(), oklch, named) into rgb() on the
    // computed `color`, so we don't depend on --bg being hex.
    const probe = document.createElement('span');
    probe.style.color = 'var(--bg)';
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const m = /(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(rgb);
    if (m) {
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? 'dark' : 'light';
    }
  } catch {
    /* fall through */
  }
  return 'dark';
}

export type NavTreeVariant = 'sidebar' | 'sheet';

// Which sheet tabs the user has expanded/collapsed into their pane list, kept
// at module scope so it SURVIVES the sheet closing (which unmounts the tree).
// Reopening the navigator then restores exactly what you had open, instead of
// snapping every tab shut again. Explicit entry wins; tabs with no entry fall
// back to the auto-expand-active-tab default. Session-lived (reset on reload).
const sheetTabExpanded = new Map<string, boolean>();

type Editing = { kind: 'workspace' | 'tab'; id: string } | null;

// Custom drag MIME for "this drag is a tab being moved across workspaces".
// Distinct from the plain-text id that useListReorder sets, so a workspace
// row can tell a cross-workspace tab drop apart from a workspace-reorder drag
// (only `dataTransfer.types` is readable during dragover — hence a dedicated
// type rather than sniffing the payload).
const TAB_DRAG_MIME = 'application/x-muxpad-tab';

interface TabDragPayload {
  tabId: string;
  tabName: string;
  fromWorkspaceId: string;
}

/** Middle band of a tab row = the "merge / move INTO this tab" drop zone;
 *  the edges stay with reorder — the file-tree drop-into convention. */
function inMergeBand(e: React.DragEvent): boolean {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (e.clientY - r.top) / Math.max(1, r.height);
  return y >= 0.3 && y <= 0.7;
}

// Origin of the in-flight tab drag, set on dragstart / cleared on dragend.
// `dataTransfer.getData` is unreadable during dragover (only `types` is
// exposed), so a workspace row can't tell from the event alone whether a
// hovering tab came from ITSELF (a reorder) or another workspace (a move).
// This module-level mirror lets the drop target make that call during
// dragover — used only to gate the cross-workspace drop affordance, never as
// the source of truth for the move itself (the drop reads the real payload).
const tabDragOrigin = createDragOrigin<TabDragPayload>();

/**
 * Move a tab to another workspace and offer an undo. Refreshes both
 * workspaces' tab caches (the global event router does too, but doing it
 * here makes the sidebar update feel immediate) plus the workspace rollup.
 * Shared by the tab context menu and the drag-onto-workspace-row gesture.
 */
async function moveTabToWorkspace(args: {
  tabId: string;
  tabName: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  toWorkspaceName: string;
}): Promise<void> {
  const refresh = () =>
    Promise.all([
      refreshTabs(args.fromWorkspaceId),
      refreshTabs(args.toWorkspaceId),
      refreshWorkspaces(),
    ]);
  try {
    await api.moveTabToWorkspace(args.tabId, args.toWorkspaceId);
    await refresh();
    pushUndo({
      message: `Moved “${args.tabName}” to “${args.toWorkspaceName}”`,
      run: async () => {
        try {
          await api.moveTabToWorkspace(args.tabId, args.fromWorkspaceId);
          await refresh();
        } catch (err) {
          console.error('undo tab→workspace move failed', err);
        }
      },
    });
  } catch (err) {
    console.error('move tab→workspace failed', err);
  }
}

/**
 * Move a dragged pane into `dest` — the drag-a-pane-onto-a-workspace-header
 * gesture. The pane's pty/agent keeps running untouched; only its parent tab
 * changes.
 *
 * Two shapes, because a pane that is its tab's ONLY pane effectively IS that
 * tab: extracting it into a "new" tab would delete a tab and build an
 * identical one, throwing away its name, icon and slug — and, if you were
 * looking at it, dropping you on the workspace root when it vanished. So a
 * solo pane travels as a TAB MOVE (`moveTabToWorkspace`, which brings its own
 * undo); anything else extracts into a fresh tab over there.
 *
 * No navigation either way: you dropped it over there precisely because
 * you're staying here.
 */
async function movePaneToNewTabIn(
  paneId: string,
  dest: Workspace,
  origin: PaneDragOrigin | null,
): Promise<void> {
  const action = paneDropAction(origin, dest.id);
  if (action === 'none') return; // solo pane, already a tab of this workspace
  if (action === 'move-tab' && origin?.fromWorkspaceId) {
    const name = (await api.getTab(origin.fromTabId).catch(() => null))?.name ?? 'this tab';
    await moveTabToWorkspace({
      tabId: origin.fromTabId,
      tabName: name,
      fromWorkspaceId: origin.fromWorkspaceId,
      toWorkspaceId: dest.id,
      toWorkspaceName: dest.name,
    });
    return;
  }
  try {
    const res = await api.movePane(paneId, { newTab: true, toWorkspaceId: dest.id });
    // Defensive: the server refuses to churn a tab's identity by extracting
    // its only pane at home. The solo branch above means we shouldn't get
    // here, but a stale drag origin must not look like a successful move.
    if (res.to_tab.id === res.from_tab_id) return;
    await Promise.all([
      refreshTabs(dest.id),
      ...(res.from_workspace_id && res.from_workspace_id !== dest.id
        ? [refreshTabs(res.from_workspace_id)]
        : []),
      refreshWorkspaces(),
    ]);
    if (!res.from_tab_removed) {
      pushUndo({
        message: `Moved pane to “${dest.name}”`,
        run: async () => {
          try {
            await api.movePane(paneId, { toTabId: res.from_tab_id });
            await Promise.all([
              refreshTabs(dest.id),
              ...(res.from_workspace_id ? [refreshTabs(res.from_workspace_id)] : []),
              refreshWorkspaces(),
            ]);
          } catch (err) {
            console.error('undo pane→workspace move failed', err);
          }
        },
      });
    }
  } catch (err) {
    console.error('move pane→workspace failed', err);
  }
}

/** Props spread onto a draggable row to make it reorderable. */
interface DragItemProps {
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  'data-dragging'?: 'true';
  /** Which edge of this row the drop line renders on — where the dragged row
   *  will land (top = before this row, bottom = after). Absent when not a
   *  current drop target. */
  'data-drop-edge'?: 'top' | 'bottom';
}

/**
 * Native HTML5 drag-to-reorder for a flat list. `orderedIds` is the current
 * order; on drop it computes the new order (dragging downward drops AFTER the
 * target so an item can reach the end) and calls `persist`. Returns a function
 * giving the props to spread on each row. Touch never starts an HTML5 drag, so
 * this is inert on mobile — reorder is a desktop-sidebar affordance.
 */
function useListReorder(
  orderedIds: string[],
  /** `draggedId` / `targetId` are the two rows the gesture actually named —
   *  the new order alone can't identify them (moving A past B changes both
   *  their indices), and the tab list needs them to decide whether the drop
   *  is a legal pinned-block reorder at all. */
  persist: (ids: string[], draggedId: string, targetId: string) => void,
  opts?: {
    /** Return false to decline an otherwise-valid dragover (e.g. tab rows
     *  cede their middle band to the merge-into affordance); a declined row
     *  also clears its own drop-edge highlight so the two never coexist. */
    claimOver?: (e: React.DragEvent) => boolean;
  },
): (id: string) => DragItemProps {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  return (id: string) => {
    // Direction-aware drop edge: dragging downward lands AFTER the target
    // (line on its bottom), upward lands BEFORE it (top) — matches
    // reorderByDrop so the line shows exactly where the row will go.
    let dropEdge: 'top' | 'bottom' | null = null;
    if (overId === id && dragId !== null && dragId !== id) {
      const from = orderedIds.indexOf(dragId);
      const to = orderedIds.indexOf(id);
      // Guard against a mid-drag list reconcile (refresh) dropping dragId out of
      // the order — indexOf -1 would otherwise force a wrong 'bottom' edge.
      if (from >= 0 && to >= 0) dropEdge = from < to ? 'bottom' : 'top';
    }
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragId(id);
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers won't start a drag unless dataTransfer carries data.
        try {
          e.dataTransfer.setData('text/plain', id);
        } catch {
          /* noop */
        }
      },
      onDragOver: (e: React.DragEvent) => {
        if (!dragId || dragId === id) return;
        if (opts?.claimOver && !opts.claimOver(e)) {
          if (overId === id) setOverId(null);
          return;
        }
        e.preventDefault(); // allow drop
        e.dataTransfer.dropEffect = 'move';
        if (overId !== id) setOverId(id);
      },
      onDragLeave: (e: React.DragEvent) => {
        // Clear the highlight only when leaving the row entirely (not when the
        // pointer crosses into a child element), so dragging off the list onto
        // empty space / the +button doesn't leave a stuck accent.
        if (overId === id && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOverId(null);
        }
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const from = dragId;
        setDragId(null);
        setOverId(null);
        if (!from || from === id) return;
        const next = reorderByDrop(orderedIds, from, id);
        if (next !== orderedIds) persist(next, from, id);
      },
      onDragEnd: () => {
        setDragId(null);
        setOverId(null);
      },
      ...(dragId === id ? { 'data-dragging': 'true' as const } : {}),
      ...(dropEdge ? { 'data-drop-edge': dropEdge } : {}),
    };
  };
}

interface NavTreeProps {
  activeWorkspaceSlug: string;
  activeTabSlug: string | null;
  variant: NavTreeVariant;
  /** Called right before any row navigation — the sheet uses it to dismiss. */
  onNavigate?: () => void;
}

/**
 * The workspace/tab navigator tree — ONE component for both chrome homes:
 *
 *   variant="sidebar" — persistent left rail on desktop (Settings →
 *     Navigation → Sidebar). Replaces the WorkspaceSwitcher + TabBar top
 *     chrome entirely: dense file-navigator rows, hover-revealed close
 *     buttons, double-click inline rename on the active workspace/tab,
 *     Ctrl+1…9 quick-switch kept.
 *   variant="sheet" — content of the mobile drop-down panel. Same tree,
 *     thumb-height rows, close buttons always faintly present (touch has
 *     no hover).
 *
 * Hierarchy is carried by STRUCTURE (disclosure + indent) and STATE
 * (accent rail = "you are here", red dot = "wants you"), not type-size
 * escalation — the same grammar as the rest of muxpad's chrome.
 *
 * Every workspace is collapsible, including the active one. Expansion
 * state persists across sessions (lib/nav-expansion.ts); untouched
 * workspaces default to "expanded iff active", so the dominant flow —
 * switching tabs inside the current workspace — is always one click.
 */
export function NavTree({ activeWorkspaceSlug, activeTabSlug, variant, onNavigate }: NavTreeProps) {
  const navigate = useNavigate();
  // The tree lists VISIBLE workspaces only. Hidden workspaces are plumbing
  // (a system container); nothing routes there by default.
  const { workspaces: allWorkspaces } = useWorkspaces();
  const workspaces = visibleWorkspaces(allWorkspaces);
  const expansion = useNavExpansion();
  // Single edit slot hoisted here so only one rename can be in flight
  // across the whole tree.
  const [editing, setEditing] = useState<Editing>(null);
  const [creatingWs, setCreatingWs] = useState(false);

  // Drag-to-reorder workspaces (desktop sidebar). Persist the new order, then
  // refresh; on failure refresh anyway to snap back to the server's truth.
  const wsDnd = useListReorder(
    workspaces.map((w) => w.id),
    (ids) => {
      applyWorkspaceOrder(ids); // move immediately; refresh below reconciles
      void (async () => {
        try {
          await api.reorderWorkspaces(ids);
        } catch (err) {
          console.error('reorder workspaces failed', err);
        }
        await refreshWorkspaces();
      })();
    },
  );

  const createWorkspace = async () => {
    if (creatingWs) return;
    setCreatingWs(true);
    try {
      // Bootstrap workspace + first tab-with-pane in one go so the user
      // lands somewhere usable (the server creates the pane atomically).
      const w = await api.createWorkspace();
      const t = await api.createTab(w.id, { bootstrap: 'shell' });
      await refreshWorkspaces();
      onNavigate?.();
      void navigate({ to: '/w/$wsSlug/t/$tabSlug', params: { wsSlug: w.slug, tabSlug: t.slug } });
    } catch (err) {
      console.error('createWorkspace failed', err);
    } finally {
      setCreatingWs(false);
    }
  };

  return (
    <nav className="navtree" data-variant={variant} aria-label="Workspaces and tabs">
      {/* The label is the mobile sheet's only title, so keep it there. On
          desktop the brand plate above the tree already names the app and
          the tree is the only section — the label is redundant, so drop it. */}
      {variant === 'sheet' && (
        <div className="navtree-section">
          <span className="navtree-section-label">Workspaces</span>
        </div>
      )}
      <div className="navtree-scroll">
        {workspaces.map((w) => (
          <WorkspaceNode
            key={w.id}
            workspace={w}
            isActive={w.slug === activeWorkspaceSlug}
            expanded={isExpanded(expansion, w.slug, activeWorkspaceSlug)}
            activeWorkspaceSlug={activeWorkspaceSlug}
            activeTabSlug={activeTabSlug}
            variant={variant}
            editing={editing}
            setEditing={setEditing}
            onNavigate={onNavigate}
            rowDnd={variant === 'sidebar' ? wsDnd(w.id) : undefined}
          />
        ))}
        {/* Same action language as "+ New tab", at the workspace indent. */}
        <button
          type="button"
          className="navtree-add navtree-new-workspace"
          onClick={() => void createWorkspace()}
          disabled={creatingWs}
        >
          {creatingWs ? 'Creating…' : '+ New workspace'}
        </button>
      </div>
    </nav>
  );
}

interface WorkspaceNodeProps {
  workspace: Workspace;
  isActive: boolean;
  expanded: boolean;
  activeWorkspaceSlug: string;
  activeTabSlug: string | null;
  variant: NavTreeVariant;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onNavigate?: (() => void) | undefined;
  rowDnd?: DragItemProps | undefined;
}

function WorkspaceNode({
  workspace,
  isActive,
  expanded,
  activeWorkspaceSlug,
  activeTabSlug,
  variant,
  editing,
  setEditing,
  onNavigate,
  rowDnd,
}: WorkspaceNodeProps) {
  const navigate = useNavigate();
  const isEditing = editing?.kind === 'workspace' && editing.id === workspace.id;
  // Touch rename: long-press the row (the hook ignores mouse/pen, so
  // this never trips on desktop, where double-click does it).
  const { pressing, handlers: pressHandlers } = useLongPress({
    onLongPress: () => setEditing({ kind: 'workspace', id: workspace.id }),
    fireOnTimer: true, // in-page rename — see the hook's iOS note
  });

  // Accept a tab dragged from ANOTHER workspace, dropped anywhere on this
  // group (header row OR — when expanded — the tab list below it; the handlers
  // live on the whole .navtree-group so an expanded workspace's body isn't a
  // dead zone). Gated on the tab-drag origin mirror originating elsewhere, so dragging a
  // tab to reorder it WITHIN its own workspace never lights this up or steals
  // the drop. Workspace-reorder dnd stays on the ws-row (rowDnd) and is a
  // different drag type, so it's unaffected.
  const [tabDropOver, setTabDropOver] = useState(false);
  const isCrossWsTabDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TAB_DRAG_MIME) &&
    tabDragOrigin.get()?.fromWorkspaceId !== workspace.id;
  const onGroupDragOver = (e: React.DragEvent) => {
    if (!isCrossWsTabDrag(e)) return; // workspace reorder / same-ws tab reorder
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!tabDropOver) setTabDropOver(true);
  };
  const onGroupDragLeave = (e: React.DragEvent) => {
    if (tabDropOver && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setTabDropOver(false);
    }
  };
  const onGroupDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(TAB_DRAG_MIME);
    if (!raw) return;
    setTabDropOver(false);
    try {
      const payload = JSON.parse(raw) as TabDragPayload;
      if (payload.fromWorkspaceId === workspace.id) return; // same-ws → reorder owns it
      e.preventDefault();
      void moveTabToWorkspace({
        tabId: payload.tabId,
        tabName: payload.tabName,
        fromWorkspaceId: payload.fromWorkspaceId,
        toWorkspaceId: workspace.id,
        toWorkspaceName: workspace.name,
      });
    } catch {
      // malformed payload — ignore
    }
  };

  // Accept a PANE dragged from the tab strip, dropped on this workspace's
  // HEADER: the pane leaves its tab and lands in a brand-new tab here. The
  // header is the only sensible target for "put this somewhere in that
  // workspace" — its tab rows already mean "into THAT tab", and a workspace
  // you're looking at from the outside has no other obvious slot.
  //
  // Deliberately allowed for a pane from this same workspace too: that's the
  // ordinary "pop this pane out into its own tab" gesture, just aimed at the
  // header rather than the pane chrome's button. The ONE case we decline is a
  // pane that's already its tab's only pane being dropped on its own
  // workspace — there is nothing to extract, so lighting up would promise a
  // move that can't happen.
  const [paneDropOver, setPaneDropOver] = useState(false);
  const isPaneDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(PANE_DRAG_MIME) &&
    paneDropAction(paneDragOrigin.get(), workspace.id) !== 'none';
  const onHeaderDragOver = (e: React.DragEvent) => {
    if (!isPaneDrag(e)) return; // not ours — let the ws-reorder handlers see it
    e.preventDefault();
    // The group below also listens (tab drags); a pane drop is fully handled
    // here, so don't let it bubble into a second interpretation.
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!paneDropOver) setPaneDropOver(true);
  };
  const onHeaderDragLeave = (e: React.DragEvent) => {
    if (paneDropOver && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setPaneDropOver(false);
    }
  };
  // Reorder dnd for the header row — dropped while renaming (an input owns
  // the row then, and dragging text inside it must not start a row drag).
  const wsRowDnd = rowDnd && !isEditing ? rowDnd : undefined;
  const onHeaderDrop = (e: React.DragEvent) => {
    setPaneDropOver(false);
    const paneId = e.dataTransfer.getData(PANE_DRAG_MIME);
    if (!paneId || !isPaneDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void movePaneToNewTabIn(paneId, workspace, paneDragOrigin.get());
  };

  const closeWorkspace = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Desktop keeps the confirm the old switcher had — closing cascade-
    // kills every tab and pane. The sheet stays confirm-free because
    // window.confirm is flaky in iOS PWA standalone mode (silent no-op).
    if (variant === 'sidebar') {
      const n = workspace.tab_count;
      if (
        !window.confirm(
          `Close workspace "${workspace.name}"? All ${n} ${n === 1 ? 'tab' : 'tabs'} and their panes will be killed.`,
        )
      )
        return;
    }
    try {
      await api.deleteWorkspace(workspace.id);
      await refreshWorkspaces();
      if (isActive) {
        onNavigate?.();
        void navigate({ to: '/' });
      }
    } catch (err) {
      console.error('deleteWorkspace failed', err);
      window.alert(`Failed to close workspace: ${String(err)}`);
    }
  };

  return (
    <div
      className="navtree-group"
      data-active={isActive ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      onDragOver={onGroupDragOver}
      onDragLeave={onGroupDragLeave}
      onDrop={onGroupDrop}
    >
      <div
        className="navtree-ws-row"
        data-active={isActive ? 'true' : undefined}
        data-unread={workspace.unread ? 'true' : undefined}
        data-pressing={pressing ? 'true' : undefined}
        data-tab-drop={tabDropOver ? 'true' : undefined}
        data-pane-drop={paneDropOver ? 'true' : undefined}
        {...wsRowDnd}
        // Pane drops are layered ON TOP of workspace-reorder dnd: a pane drag
        // is claimed here and goes no further, anything else falls through to
        // the reorder handlers spread above (hence the explicit chaining —
        // these props would otherwise just replace them).
        onDragOver={(e) => {
          onHeaderDragOver(e);
          if (!e.isPropagationStopped()) wsRowDnd?.onDragOver(e);
        }}
        onDragLeave={(e) => {
          onHeaderDragLeave(e);
          wsRowDnd?.onDragLeave(e);
        }}
        onDrop={(e) => {
          onHeaderDrop(e);
          if (!e.isPropagationStopped()) wsRowDnd?.onDrop(e);
        }}
      >
        <button
          type="button"
          className="navtree-disclosure"
          onClick={() => toggleExpanded(workspace.slug, activeWorkspaceSlug)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
          data-expanded={expanded ? 'true' : undefined}
        >
          <SvgChevronRight />
        </button>
        {isEditing ? (
          <RenameInput
            initial={workspace.name}
            onCommit={async (name) => {
              setEditing(null);
              if (!name || name === workspace.name) return;
              try {
                await api.patchWorkspace(workspace.id, { name });
              } catch (err) {
                console.error('rename workspace failed', err);
              }
              await refreshWorkspaces();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Link
            to="/w/$wsSlug"
            params={{ wsSlug: workspace.slug }}
            className="navtree-ws-name"
            // The row owns drag-to-reorder; stop the anchor's native
            // drag-the-URL from hijacking it.
            draggable={false}
            title={variant === 'sidebar' && isActive ? 'Double-click to rename' : workspace.name}
            onDoubleClick={
              // Desktop rename mirrors the old chrome's affordance: the
              // ACTIVE workspace only (avoids navigate-then-edit
              // weirdness on inactive rows). Touch renames any row via
              // long-press, which never navigates.
              variant === 'sidebar' && isActive
                ? (e) => {
                    e.preventDefault();
                    setEditing({ kind: 'workspace', id: workspace.id });
                  }
                : undefined
            }
            {...pressHandlers}
            onClick={(e) => {
              // Long-press consumes the tap (rename, not toggle).
              pressHandlers.onClick(e);
              if (e.defaultPrevented) return;
              // Modified / middle click falls through to the native anchor
              // (href below) so ⌘/Ctrl-click and right-click → "open in new
              // tab" still open the whole workspace in a new browser tab.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              // Plain left-click minimizes/expands the workspace in place —
              // it does NOT navigate. You navigate by clicking a tab inside
              // it. (Collapsing collides with navigating on one click; the
              // new-browser-tab affordance is preserved via the modified
              // clicks handled above.)
              e.preventDefault();
              toggleExpanded(workspace.slug, activeWorkspaceSlug);
            }}
          >
            <span className="navtree-name-text">{workspace.name}</span>
          </Link>
        )}
        {!expanded && workspace.tab_count > 0 && (
          // Collapsed rows surface what they're hiding — a quiet tab
          // count, file-navigator style.
          <span className="navtree-ws-count" aria-hidden="true">
            {workspace.tab_count}
          </span>
        )}
        {/* D2 — the workspace row's own status, and the whole reason the
            server computes it. The per-tab marks live in TabList, which mounts
            only while this row is EXPANDED, and the default expansion is
            active-workspace-only: on a fresh profile every agent working in a
            collapsed workspace was invisible, its 5s poll stopped, and the
            live-refresh path skipped it for want of a cache entry.
            Collapsed-ONLY, for the same reason the tab-count chip is: once the
            tabs are listed they carry their own marks, and a rollup on top of
            them would just double-signal. */}
        {!expanded && <StatusMark status={workspace.status} agents={workspace.agents} />}
        <button
          type="button"
          className="navtree-close"
          onClick={(e) => void closeWorkspace(e)}
          title="Close workspace"
          aria-label={`Close workspace ${workspace.name}`}
        >
          <SvgClose size={13} />
        </button>
      </div>
      {expanded && (
        <TabList
          workspace={workspace}
          isActiveWorkspace={isActive}
          activeTabSlug={activeTabSlug}
          variant={variant}
          editing={editing}
          setEditing={setEditing}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

interface TabListProps {
  workspace: Workspace;
  isActiveWorkspace: boolean;
  activeTabSlug: string | null;
  variant: NavTreeVariant;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onNavigate?: (() => void) | undefined;
}

/**
 * Mounted only while its workspace is expanded, so useTabs polls (and
 * keeps attention dots live) for exactly the workspaces you can see.
 */
function TabList({
  workspace,
  isActiveWorkspace,
  activeTabSlug,
  variant,
  editing,
  setEditing,
  onNavigate,
}: TabListProps) {
  const navigate = useNavigate();
  const { tabs: serverTabs } = useTabs(workspace.id);
  const [creating, setCreating] = useState(false);

  // ── The living sidebar's two blocks ─────────────────────────────────────
  // The SERVER owns the order (pinned first in manual order, then unpinned
  // auto-sorted by attention → recency), so the client only has to
  // find the seam. Deriving `pinnedCount` rather than re-sorting keeps one
  // authority for ordering and means a poll can never fight a local sort.
  //
  // The single exception is the tab you're LOOKING AT: it is pinned in place
  // visually for as long as it's active (useFrozenTabOrder) and settles into
  // its sorted position when you leave. Being in a tab is itself activity —
  // it bumps `last_activity_at` on every turn — so without this the row under
  // your cursor climbs the list while you use it and drags every other row
  // with it. This moves ONE row and never writes: the server's order is
  // untouched, and every other tab keeps re-sorting live underneath.
  const activeTabId =
    (isActiveWorkspace && serverTabs.find((t) => t.slug === activeTabSlug)?.id) || null;
  const tabs = useFrozenTabOrder(serverTabs, activeTabId);
  const pinnedCount = tabs.filter((t) => t.pinned).length;

  // Pin / unpin. Optimistic only in the sense that we refetch immediately —
  // the server may also move the tab (a newly-pinned tab goes to the end of
  // the pinned block), so a local guess would flicker against the truth.
  const setTabPinned = async (tab: Tab, pinned: boolean) => {
    try {
      await api.patchTab(tab.id, { pinned });
      await refreshTabs(workspace.id);
    } catch (err) {
      console.error('pin tab failed', err);
    }
  };

  // Drag-to-reorder is PINNED-ONLY (see lib/tab-drag for why). The hook is
  // fed just the pinned ids, so an unpinned row can neither be dragged into
  // the manual block nor serve as a drop target for one — there is no
  // implicit "dropping it pins it" left. Reorder claims only the EDGE bands
  // of a row; the middle band belongs to merge-into (see TabRow), so one row
  // hosts both gestures without the drop-line and the merge ring fighting.
  const tabDnd = useListReorder(
    tabs.filter((t) => t.pinned).map((t) => t.id),
    (_ids, draggedId, targetId) => {
      const next = orderAfterPinnedDrop(tabs, draggedId, targetId);
      if (!next) return; // not a pinned→pinned drop: nothing to persist
      applyTabOrder(workspace.id, next.allIds); // move now; the refresh reconciles
      void (async () => {
        try {
          await api.reorderTabs(next.pinnedIds);
        } catch (err) {
          console.error('reorder tabs failed', err);
        }
        await refreshTabs(workspace.id);
      })();
    },
    { claimOver: (e) => !inMergeBand(e) },
  );

  // An UNPINNED row is still draggable, but the drag can only MOVE it: drop
  // it on another workspace (WorkspaceNode's group target) to re-home it.
  // It gets no reorder handlers, so no drop line ever appears inside the
  // auto-sorted block — which is honest, since any order dragged into it
  // would evaporate on the next poll.
  const [movingTabId, setMovingTabId] = useState<string | null>(null);
  const moveOnlyDnd = (id: string): DragItemProps => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setMovingTabId(id);
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers refuse to start a drag with an empty dataTransfer.
      try {
        e.dataTransfer.setData('text/plain', id);
      } catch {
        /* noop */
      }
    },
    onDragOver: () => {},
    onDragLeave: () => {},
    onDrop: () => {},
    onDragEnd: () => setMovingTabId(null),
    ...(movingTabId === id ? { 'data-dragging': 'true' as const } : {}),
  });

  // Merge a dragged tab's panes into `dest` (the row it was dropped on).
  // The source tab dissolves; if it was the one being viewed, its TabView's
  // tab.removed handler follows the panes via the follow-target hint —
  // recorded BEFORE the call so the event can never race an explicit
  // navigate (and so cross-workspace merges follow too, which a dest-list
  // lookup here could never resolve).
  const mergeTabInto = async (payload: TabDragPayload, dest: Tab) => {
    setFollowTarget(payload.tabId, workspace.slug, dest.slug);
    try {
      await api.mergeTab(payload.tabId, dest.id);
      await Promise.all([
        refreshTabs(payload.fromWorkspaceId),
        refreshTabs(workspace.id),
        refreshWorkspaces(),
      ]);
    } catch (err) {
      // The source tab survives a failed merge — retract the hint or a
      // later unrelated close of that tab would teleport to `dest`.
      clearFollowTarget(payload.tabId);
      console.error('merge tab failed', err);
    }
  };

  // Create a pane in `t` and land on it. Shared by the sheet pane list's
  // chooser and the tab context menu. Always opens the harness picker
  // (Claude / Codex / Cursor + Terminal / Web view below).
  const addPaneToTab = async (t: Tab) => {
    try {
      const created = await api.createPane(t.id, {
        append_to_layout: true,
        ...HOUSE_CHAT_PANE_CREATE,
      });
      await refreshTabs(workspace.id);
      setLastPaneId(t.id, created.id);
      window.dispatchEvent(
        new CustomEvent('muxpad:select-pane', { detail: { tabId: t.id, paneId: created.id } }),
      );
      onNavigate?.();
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspace.slug, tabSlug: t.slug },
      });
    } catch (err) {
      console.error('add pane failed', err);
    }
  };

  // Move a single pane (dragged from the tab strip) into `dest`. If it was
  // the source tab's LAST pane, that tab dissolves — the follow hint makes
  // its tab.removed redirect land on `dest` instead of the workspace root.
  const movePaneHere = async (paneId: string, sourceTabId: string | null, dest: Tab) => {
    if (sourceTabId) setFollowTarget(sourceTabId, workspace.slug, dest.slug);
    try {
      const res = await api.movePane(paneId, { toTabId: dest.id });
      // The hint only matters when the source tab dissolved (its removal is
      // what navigates). Any other outcome must retract it — see
      // clearFollowTarget.
      if (sourceTabId && !res.from_tab_removed) clearFollowTarget(sourceTabId);
      if (res.to_tab.id === res.from_tab_id) return; // no-op (already here)
      await Promise.all([
        refreshTabs(workspace.id),
        // The source tab may live in ANOTHER workspace (cross-workspace
        // moves) — refresh its tab-list cache too or it keeps referencing
        // the moved-away pane until the next poll.
        ...(res.from_workspace_id && res.from_workspace_id !== workspace.id
          ? [refreshTabs(res.from_workspace_id)]
          : []),
        refreshWorkspaces(),
      ]);
      // Undo only while the source tab still exists to receive it back.
      if (!res.from_tab_removed) {
        pushUndo({
          message: `Moved pane to “${dest.name}”`,
          run: async () => {
            try {
              await api.movePane(paneId, { toTabId: res.from_tab_id });
            } catch (err) {
              console.error('undo pane move failed', err);
            }
          },
        });
      }
    } catch (err) {
      if (sourceTabId) clearFollowTarget(sourceTabId);
      console.error('move pane failed', err);
    }
  };

  // Ctrl+1…9 quick-switch parity with the top-nav TabBar. Only the
  // sidebar wires it (the sheet is touch; TabBar owns it in top mode).
  // tabCount 0 disables the inactive instances without breaking the
  // rules of hooks.
  //
  // The number↔tab mapping is FROZEN for as long as the badges are up.
  // Before the living sidebar, tab order was the stable manual `position`,
  // so indexing the live list was safe. Now the unpinned block re-sorts on
  // attention/busy/recency and the 5s poll can re-derive it mid-keystroke —
  // so a build going busy between "I read the 3" and "I pressed Ctrl+3"
  // would land you on a different tab. Snapshotting on Ctrl-down means the
  // number you see is the number you get, every time.
  //
  // (Across separate holds the unpinned numbers still move — that's the
  // feature working. PINNING is what buys a number that means the same
  // thing tomorrow, since pinned tabs never re-sort.)
  const quickEnabled = variant === 'sidebar' && isActiveWorkspace;
  const [quickIds, setQuickIds] = useState<string[]>([]);
  // "Were the badges up as of the last render?" — read before it's written
  // below, which is exactly the question the tabCount arg needs answered.
  const quickHeld = useRef(false);
  const showQuickNumbers = useTabQuickSwitch({
    // While the badges are UP, the accepted range is the snapshot's, not the
    // live list's: a tab closed mid-hold would otherwise shrink the range and
    // make a badge you can still see stop responding, and a tab created
    // mid-hold would widen it past the snapshot — swallowing the chord from
    // the focused terminal to switch to nothing.
    tabCount: quickEnabled ? (quickHeld.current ? quickIds.length : tabs.length) : 0,
    onSwitch: (i) => {
      // Resolve against the FROZEN snapshot, then look the tab up by id —
      // never by live index. A tab deleted mid-hold simply no-ops.
      const id = quickIds[i];
      const t = id ? tabs.find((x) => x.id === id) : undefined;
      if (!t) return;
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspace.slug, tabSlug: t.slug },
      });
    },
  });
  quickHeld.current = showQuickNumbers;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tabs` is deliberately NOT a dependency — re-snapshotting while the badges are up is the exact bug this prevents.
  useEffect(() => {
    setQuickIds(showQuickNumbers ? tabs.map((t) => t.id) : []);
  }, [showQuickNumbers]);
  /** The frozen badge number for a tab (1–9), or undefined if it has none. */
  const quickNumberFor = (id: string): number | undefined => {
    const i = quickIds.indexOf(id);
    return i >= 0 && i < MAX_QUICK_SWITCH_TABS ? i + 1 : undefined;
  };

  const closeTab = async (e: React.MouseEvent, tab: Tab) => {
    e.stopPropagation();
    e.preventDefault();
    // No window.confirm — flaky in iOS PWA standalone mode, and tabs are
    // lighter than workspaces. Tap = delete (same as the old mobile menu).
    try {
      await api.deleteTab(tab.id);
      await refreshTabs(workspace.id);
      await refreshWorkspaces(); // tab_count chips on collapsed rows
    } catch (err) {
      console.error('deleteTab failed', err);
      window.alert(`Failed to close tab: ${String(err)}`);
    }
  };

  // Manual unread toggle (context menu). `want=true` flags the attention
  // dot; `want=false` clears it (same path as viewing the tab). Refresh
  // both the tab list and the workspace rollup so the dot updates at once.
  const setTabUnread = async (tab: Tab, want: boolean) => {
    try {
      await (want ? api.markTabUnread(tab.id) : api.markTabSeen(tab.id));
      await refreshTabs(workspace.id);
      await refreshWorkspaces();
    } catch (err) {
      console.error('set tab unread failed', err);
    }
  };

  const setTabIcon = async (tab: Tab, icon: string) => {
    try {
      await api.patchTab(tab.id, { icon });
      await refreshTabs(workspace.id);
    } catch (err) {
      console.error('set tab icon failed', err);
    }
  };

  // Tabs-first creation: one server call makes the tab AND its single
  // full-size pane atomically, already running the house chat.
  const createTab = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // Straight into the house chat — no "what do you want to open?" screen.
      // The alternatives live in the empty chat's own "open instead:" strip,
      // where they cost nothing until you actually want one.
      const t = await api.createTab(workspace.id, { ...HOUSE_CHAT_CREATE });
      await refreshTabs(workspace.id);
      await refreshWorkspaces();
      onNavigate?.();
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspace.slug, tabSlug: t.slug },
      });
    } catch (err) {
      console.error('createTab failed', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="navtree-tab-list">
      {tabs.map((t, i) => (
        <Fragment key={t.id}>
          {/* The seam between "you arranged these" and "these arrange
              themselves". Only drawn when BOTH blocks exist — a hairline
              above nothing (or below nothing) is noise, and a workspace
              with no pins should look exactly like it did before pinning
              existed. */}
          {/* Purely decorative: pinnedness is already announced per-row by
              the pin button's aria-pressed, so a semantic separator here
              would only add a second, redundant thing for a screen reader to
              stop on. */}
          {i === pinnedCount && pinnedCount > 0 ? (
            <div className="navtree-pin-divider" aria-hidden="true" />
          ) : null}
          <TabRow
            tab={t}
            workspace={workspace}
            isActiveTab={isActiveWorkspace && t.slug === activeTabSlug}
            quickNumber={showQuickNumbers && quickEnabled ? quickNumberFor(t.id) : undefined}
            variant={variant}
            isEditing={editing?.kind === 'tab' && editing.id === t.id}
            setEditing={setEditing}
            onNavigate={onNavigate}
            onClose={(e) => void closeTab(e, t)}
            onSetUnread={(want) => void setTabUnread(t, want)}
            onSetIcon={(icon) => void setTabIcon(t, icon)}
            onSetPinned={(want) => void setTabPinned(t, want)}
            onMergeInto={(payload) => void mergeTabInto(payload, t)}
            onAddPane={() => void addPaneToTab(t)}
            onMovePaneHere={(paneId, sourceTabId) => void movePaneHere(paneId, sourceTabId, t)}
            rowDnd={
              variant === 'sidebar' ? (t.pinned ? tabDnd(t.id) : moveOnlyDnd(t.id)) : undefined
            }
          />
        </Fragment>
      ))}
      <NewTabButton
        idleLabel={creating ? 'Creating…' : '+ New tab'}
        idleTitle="New tab"
        idleClassName="navtree-add navtree-new-tab"
        disabled={creating}
        onCreate={() => void createTab()}
      />
    </div>
  );
}

/** Best-effort pane label for the sheet's pane rows — mirrors TabView's
 *  paneLabel priority (pinned name → url host → live title → fg cmd). */
function sheetPaneLabel(p: PaneSpec, i: number): string {
  const custom = p.name?.trim();
  if (custom) return custom;
  if (p.kind === 'url' && p.url) {
    try {
      return new URL(p.url).hostname;
    } catch {
      return p.url;
    }
  }
  return p.title?.trim() || p.foreground_cmd?.trim() || `Pane ${i + 1}`;
}

/**
 * Sheet-only: a tab's pane list, expanded in place under its row — PURE
 * pane navigation (tap = open that pane). Creation lives in the row's ⋯
 * menu, the one home for tab actions on every tab regardless of pane
 * count.
 */
function SheetPaneList({
  tab,
  workspace,
  onNavigate,
  isActiveTab,
}: {
  tab: Tab;
  workspace: Workspace;
  onNavigate?: (() => void) | undefined;
  isActiveTab: boolean;
}) {
  const navigate = useNavigate();
  const [panes, setPanes] = useState<PaneSpec[] | null>(null);
  // D16: this list used to FREEZE on a failing poll — the catch kept the
  // previous panes forever with no timeout, so a persistently failing fetch
  // left working marks spinning on a snapshot that could be minutes old, and
  // the "…" loading ellipsis span forever if it never loaded at all. Keeping
  // the last good list through a BLIP is right; presenting stale state
  // indefinitely as if it were live is not. Count consecutive failures and say
  // so once we've clearly lost the server.
  const [staleAfter, setStaleAfter] = useState(0);
  useEffect(() => {
    let alive = true;
    let fails = 0;
    const load = () => {
      // Don't poll into a hidden document. Unlike the tab/workspace polls this
      // one has no visibility gate of its own, so a sheet left open in a
      // backgrounded browser tab hit /tabs/:id every 2.5s indefinitely.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        return Promise.resolve();
      return api
        .getTab(tab.id)
        .then((detail) => {
          if (!alive) return;
          fails = 0;
          setStaleAfter(0);
          setPanes(detail.panes);
        })
        .catch(() => {
          if (!alive) return;
          fails += 1;
          // Two consecutive misses (~5s) is past a blip. Below that, ride it
          // out silently rather than flashing an error at every hiccup.
          if (fails >= 2) setStaleAfter(fails);
          setPanes((prev) => prev ?? []);
        });
    };
    void load();
    // Poll while the list is open so each pane's status mark stays live (the
    // tab list has its own poll; this fetch is separate).
    const t = window.setInterval(load, 2500);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [tab.id]);

  const openPane = (paneId: string) => {
    // Persist first: a not-yet-mounted TabView reads the stored pane on
    // mount; a mounted one reacts to the event below.
    setLastPaneId(tab.id, paneId);
    window.dispatchEvent(
      new CustomEvent('muxpad:select-pane', { detail: { tabId: tab.id, paneId } }),
    );
    onNavigate?.();
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug: workspace.slug, tabSlug: tab.slug },
    });
  };

  // The pane you're currently looking at — same resolution TabView uses
  // (stored last pane, else the first). Only meaningful for the active tab.
  const activePaneId = isActiveTab ? (getLastPaneId(tab.id) ?? panes?.[0]?.id) : undefined;

  // Close a pane from the list — parity with the tab × (tap = delete, no
  // confirm). Optimistic removal; the 2.5s poll reconciles on failure.
  const closePane = async (e: React.MouseEvent, pane: PaneSpec, label: string) => {
    e.preventDefault();
    e.stopPropagation();
    const wasLast = (panes?.length ?? 0) <= 1;
    setPanes((prev) => (prev ? prev.filter((x) => x.id !== pane.id) : prev));
    try {
      await api.deletePane(pane.id);
      // Server doesn't cascade; the client does (mirrors TabView's last-pane
      // → closeTab). An emptied tab would otherwise linger with no panes.
      if (wasLast) await api.deleteTab(tab.id);
    } catch (err) {
      console.error('deletePane failed', err);
      window.alert(`Failed to close pane ${label}: ${String(err)}`);
      api
        .getTab(tab.id)
        .then((d) => setPanes(d.panes))
        .catch(() => {});
    }
  };

  return (
    <div className="navtree-pane-list">
      {staleAfter > 0 ? (
        // Say it plainly rather than let stale marks keep spinning. The list
        // below (if we ever had one) stays visible underneath — it is still the
        // best guess at the truth, it just isn't live any more.
        <div className="navtree-pane-error" role="status">
          can’t reach muxpad — retrying…
        </div>
      ) : null}
      {panes === null ? (
        <div className="navtree-pane-loading">…</div>
      ) : (
        panes.map((p, i) => {
          const label = sheetPaneLabel(p, i);
          const active = p.id === activePaneId;
          return (
            <div
              key={p.id}
              className="navtree-pane-row-wrap"
              data-active={active ? 'true' : undefined}
            >
              <button
                type="button"
                className="navtree-pane-row"
                data-active={active ? 'true' : undefined}
                data-unread={p.unread ? 'true' : undefined}
                onClick={() => openPane(p.id)}
              >
                <span className="navtree-pane-label">{label}</span>
                {/* Per-pane status, same rail, same column. The tab level only
                    aggregates; a glance at the list should say WHICH pane is
                    running (or blocked). */}
                <StatusMark status={p.status} agents={p.agents} />
              </button>
              <button
                type="button"
                className="navtree-close"
                onClick={(e) => void closePane(e, p, label)}
                title="Close pane"
                aria-label={`Close pane ${label}`}
              >
                <SvgClose size={13} />
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

interface TabRowProps {
  tab: Tab;
  workspace: Workspace;
  isActiveTab: boolean;
  /** 1–9 chip shown while Ctrl is held (sidebar quick-switch); else undefined. */
  quickNumber: number | undefined;
  variant: NavTreeVariant;
  isEditing: boolean;
  setEditing: (e: Editing) => void;
  onNavigate?: (() => void) | undefined;
  onClose: (e: React.MouseEvent) => void;
  /** Toggle the manual unread mark — true flags the dot, false clears it. */
  onSetUnread: (want: boolean) => void;
  /** Set this tab's leading icon (emoji). */
  onSetIcon: (icon: string) => void;
  /** Pin/unpin — hold this tab at the top of its workspace block in the
   *  manual order, instead of letting it be auto-sorted. */
  onSetPinned: (pinned: boolean) => void;
  /** A dragged TAB was dropped on this row's merge band — absorb its panes. */
  onMergeInto: (payload: TabDragPayload) => void;
  /** Create a pane in this tab and land on it (opens the harness picker). */
  onAddPane: () => void;
  /** A pane dragged from the strip was dropped here — move it into this tab.
   *  sourceTabId (from the drag mirror) feeds the follow-navigation hint. */
  onMovePaneHere: (paneId: string, sourceTabId: string | null) => void;
  rowDnd?: DragItemProps | undefined;
}

function TabRow({
  tab,
  workspace,
  isActiveTab,
  quickNumber,
  variant,
  isEditing,
  setEditing,
  onNavigate,
  rowDnd,
  onClose,
  onSetUnread,
  onSetIcon,
  onSetPinned,
  onMergeInto,
  onMovePaneHere,
  onAddPane,
}: TabRowProps) {
  // Right-click context menu (desktop sidebar). Anchored at the cursor.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Touch long-press opens the SAME context menu (mark unread, rename,
  // change icon, move, close) — mobile previously jumped straight to rename
  // and had no path to the other actions at all. Anchored at the touch
  // point, captured on pointerdown (the long-press hook doesn't carry
  // coordinates through to its callback).
  const touchPoint = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const { pressing, handlers: longPressHandlers } = useLongPress({
    onLongPress: () => setMenu({ x: touchPoint.current.x, y: touchPoint.current.y }),
    fireOnTimer: true, // in-page menu — see the hook's iOS note
  });
  const pressHandlers = {
    ...longPressHandlers,
    onPointerDown: (e: React.PointerEvent) => {
      touchPoint.current = { x: e.clientX, y: e.clientY };
      longPressHandlers.onPointerDown(e);
    },
  };
  // Icon picker, anchored under the clicked icon.
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  // Workspaces other than this tab's own — both the "Move to workspace…"
  // menu targets and the legal drop targets for the drag gesture. Visible
  // only: the hidden system workspace is never a move target.
  const { workspaces } = useWorkspaces();
  const otherWorkspaces = visibleWorkspaces(workspaces).filter((w) => w.id !== workspace.id);

  // Sheet-only: expand the row into its pane list (direct pane nav + the
  // mobile "New pane" home). Single-pane tabs skip all of it — tapping
  // them just opens the tab (there's nothing to pick), so no chevron.
  const paneCount = collectLayoutLeaves(tab.layout).length;
  // Auto-expand the ACTIVE multi-pane tab so its panes are visible the moment
  // the navigator opens — you land already looking at where you can go. Any tab
  // the user has since explicitly toggled keeps that state across reopens (see
  // sheetTabExpanded), instead of snapping shut every time.
  const [panesOpen, setPanesOpen] = useState(() =>
    sheetTabExpanded.has(tab.id)
      ? (sheetTabExpanded.get(tab.id) ?? false)
      : variant === 'sheet' && paneCount > 1 && isActiveTab,
  );
  // Which controls this row offers — one pure, unit-tested rule set rather
  // than variant checks scattered across the JSX (see lib/nav-row-affordances).
  const affords = tabRowAffordances({ variant, paneCount, panesOpen, isEditing });
  const sheetPicksPane = affords.tapExpandsPanes;
  const togglePanes = () =>
    setPanesOpen((o) => {
      const next = !o;
      sheetTabExpanded.set(tab.id, next);
      return next;
    });

  // "Drop INTO this tab" affordance — lit for a pane dragged from the tab
  // strip (whole row) or another tab dragged over the row's middle band
  // (merge; the edges stay with reorder via the hook's claimOver).
  const [dropInto, setDropInto] = useState(false);
  const isForeignPaneDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(PANE_DRAG_MIME) && paneDragOrigin.get()?.fromTabId !== tab.id;
  const isForeignTabDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TAB_DRAG_MIME) && tabDragOrigin.get()?.tabId !== tab.id;

  // Reuse the row's reorder dnd, but also stamp a typed payload on dragstart
  // so a workspace row can recognise this as a cross-workspace tab move.
  const baseDnd = rowDnd && !isEditing ? rowDnd : undefined;
  const tabRowDnd: Partial<DragItemProps> = baseDnd
    ? {
        ...baseDnd,
        onDragStart: (e: React.DragEvent) => {
          baseDnd.onDragStart(e);
          const payload: TabDragPayload = {
            tabId: tab.id,
            tabName: tab.name,
            fromWorkspaceId: workspace.id,
          };
          // Mirror the origin so workspace rows can gate their drop affordance
          // during dragover (when the payload itself is unreadable).
          tabDragOrigin.set(payload);
          try {
            e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify(payload));
          } catch {
            // some browsers restrict custom MIME during dragstart — the
            // context-menu path still covers the move.
          }
        },
        onDragEnd: () => {
          tabDragOrigin.set(null);
          baseDnd.onDragEnd();
        },
      }
    : {};

  // Compose drop-into on TOP of reorder: the claimed branches stopPropagation
  // so the workspace group's move-tab-here handler (an ancestor) never
  // double-handles the same drop.
  const dropDnd: Partial<DragItemProps> =
    variant === 'sidebar' && !isEditing
      ? {
          ...tabRowDnd,
          onDragOver: (e: React.DragEvent) => {
            if (isForeignPaneDrag(e) || (isForeignTabDrag(e) && inMergeBand(e))) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              if (!dropInto) setDropInto(true);
              return;
            }
            if (dropInto) setDropInto(false);
            tabRowDnd.onDragOver?.(e);
          },
          onDragLeave: (e: React.DragEvent) => {
            if (dropInto && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropInto(false);
            }
            tabRowDnd.onDragLeave?.(e);
          },
          onDrop: (e: React.DragEvent) => {
            const paneId = e.dataTransfer.getData(PANE_DRAG_MIME);
            if (paneId && paneDragOrigin.get()?.fromTabId !== tab.id) {
              e.preventDefault();
              e.stopPropagation();
              setDropInto(false);
              onMovePaneHere(paneId, paneDragOrigin.get()?.fromTabId ?? null);
              return;
            }
            const rawTab = e.dataTransfer.getData(TAB_DRAG_MIME);
            if (rawTab && dropInto) {
              e.preventDefault();
              e.stopPropagation();
              setDropInto(false);
              try {
                const payload = JSON.parse(rawTab) as TabDragPayload;
                if (payload.tabId !== tab.id) onMergeInto(payload);
              } catch {
                // malformed payload — ignore
              }
              return;
            }
            setDropInto(false);
            tabRowDnd.onDrop?.(e);
          },
        }
      : tabRowDnd;
  return (
    <>
      <div
        className="navtree-tab-row"
        data-active={isActiveTab ? 'true' : undefined}
        data-unread={tab.unread ? 'true' : undefined}
        data-pressing={pressing ? 'true' : undefined}
        data-drop-into={dropInto ? 'true' : undefined}
        {...(variant === 'sidebar' && !isEditing
          ? {
              onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY });
              },
            }
          : {})}
        {...dropDnd}
      >
        {/* Sheet: the pane disclosure LEADS the row — the same left-edge
          grammar as the workspace rows, so thumbs already know where it
          lives. Full row height; squeezing it between the name and the ×
          made every tap a coin-flip between expand/navigate/close. Only
          multi-pane tabs get it — with one pane there's nothing to pick. */}
        {affords.paneExpander ? (
          <button
            type="button"
            className="navtree-pane-expander"
            data-open={panesOpen ? 'true' : undefined}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              togglePanes();
            }}
            aria-expanded={panesOpen}
            aria-label={panesOpen ? `Hide panes of ${tab.name}` : `Show panes of ${tab.name}`}
          >
            <SvgChevronRight />
          </button>
        ) : variant === 'sheet' && !isEditing ? (
          // The expander column doubles as the tab indent — chevron-less
          // (single-pane) rows keep an identical-width spacer so every tab
          // name sits on the same grid line.
          <span className="navtree-pane-expander -spacer" aria-hidden="true" />
        ) : null}
        {isEditing ? (
          <RenameInput
            initial={tab.name}
            onCommit={async (name) => {
              setEditing(null);
              if (!name || name === tab.name) return;
              try {
                await api.patchTab(tab.id, { name });
              } catch (err) {
                console.error('rename tab failed', err);
              }
              await refreshTabs(workspace.id);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Link
            to="/w/$wsSlug/t/$tabSlug"
            params={{ wsSlug: workspace.slug, tabSlug: tab.slug }}
            className="navtree-tab-link"
            // The row owns drag-to-reorder; don't let the anchor drag its URL.
            draggable={false}
            title={variant === 'sidebar' && isActiveTab ? 'Double-click to rename' : tab.name}
            onDoubleClick={
              variant === 'sidebar' && isActiveTab
                ? (e) => {
                    e.preventDefault();
                    setEditing({ kind: 'tab', id: tab.id });
                  }
                : undefined
            }
            {...pressHandlers}
            onClick={(e) => {
              // Long-press consumes the tap (opens the menu, not navigate).
              pressHandlers.onClick(e);
              if (e.defaultPrevented) return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              // Multi-pane tab on the sheet: the tab name itself TOGGLES the
              // pane list — you pick an actual pane, never land on "whichever
              // pane happened to be active".
              if (sheetPicksPane) {
                e.preventDefault();
                togglePanes();
                return;
              }
              onNavigate?.();
            }}
          >
            {/* Leading icon — click to open the picker. A span (not a button)
              since it lives inside the anchor; stop+prevent so the click
              picks an icon instead of navigating. Mouse-only by design — the
              keyboard-accessible path is the row context menu "Change icon…". */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the context menu's "Change icon…" item */}
            <span
              className="navtree-tab-icon"
              title="Change icon"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setPicker({ x: r.left, y: r.bottom + 4 });
              }}
              onDoubleClick={(e) => {
                // Don't let a fast double-click on the icon trip the row's
                // rename-on-doubleclick.
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              {tab.icon ?? DEFAULT_TAB_ICON}
            </span>
            {quickNumber !== undefined && (
              <span className="navtree-quicknum" aria-hidden="true">
                {quickNumber}
              </span>
            )}
            <span className="navtree-name-text" title={tab.name}>
              {tab.name}
            </span>
            {/* Pane-count hint — SHEET ONLY, and only while the row is
                COLLAPSED. On mobile a one-pane tab and a five-pane tab looked
                identical yet behaved completely differently: tapping the
                former navigates into the tab, tapping the latter expands a
                pane list in place and navigates nowhere. The only thing
                distinguishing them was a 10px chevron at the far-left edge,
                opposite the name you actually read.
                This is deliberately NOT a new indicator: it is the very same
                `.navtree-ws-count` chip a COLLAPSED WORKSPACE row already
                uses, and it already means exactly "this row is hiding N
                children, open it to see them". Same mark, same meaning, one
                level down — so the row now explains its own tap behavior.
                Collapsed-only for the same reason the workspace chip is:
                once the panes are listed, the count is right there. */}
            {affords.paneCountChip ? (
              <span className="navtree-ws-count navtree-pane-count" aria-hidden="true">
                {paneCount}
              </span>
            ) : null}
          </Link>
        )}
        {/* The status rail. OUTSIDE the link on purpose: inside, it trailed an
            ellipsizable name, so its x differed on every row and there was no
            vertical line to scan. Out here it sits in a fixed 16px column at a
            constant x, with only the (zero-width-at-rest) pin and × to its
            right. Shown on the ACTIVE row too — agent panes work quietly for
            minutes on their chat face, and a glance should always answer "is
            anything still running here?" */}
        {!isEditing && <StatusMark status={tab.status} agents={tab.agents} />}
        {/* Pin affordance — DESKTOP ONLY. It rides the close ×'s reveal
            machinery (zero-width until the row is hovered/focused), and a
            pinned tab keeps it lit so the pin doubles as the "this is pinned"
            marker. It is deliberately NOT rendered on the sheet: a second
            always-on 32px hit square next to the × crowded the row, was
            undiscoverable at 16% opacity, and sat exactly where a thumb lands
            — so a tap meant to open the row silently toggled pinning, and a
            long-press meant for the menu hit a button with no press handlers.
            Touch gets the ⋯ button below instead, which is a real tap target. */}
        {affords.pinButton ? (
          <button
            type="button"
            className={`navtree-close navtree-pin${tab.pinned ? ' is-pinned' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onSetPinned(!tab.pinned);
            }}
            title={tab.pinned ? 'Unpin tab' : 'Pin tab to the top'}
            aria-label={tab.pinned ? `Unpin tab ${tab.name}` : `Pin tab ${tab.name}`}
            aria-pressed={tab.pinned === true}
          >
            <SvgPin size={12} filled={tab.pinned === true} />
          </button>
        ) : null}
        {/* Tab actions — SHEET ONLY. Every tab action (pin, mark unread,
            rename, icon, new pane, move, close) used to be reachable on touch
            ONLY by long-pressing the row, and that gesture is not dependable
            here: the rows live in a momentum-scrolling container
            (.navtree-scroll: overflow-y auto + -webkit-overflow-scrolling
            touch), and iOS hands the touch to the scroll recognizer, which
            surfaces to the page as pointercancel and kills the hold. A plain
            tap on a real button has none of that fragility. Long-press still
            works where it works; it is no longer the only way in. */}
        {affords.moreButton ? (
          <button
            type="button"
            className="navtree-close navtree-more"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              // Anchor under the button so the menu opens where you tapped.
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.right, y: r.bottom + 4 });
            }}
            title="Tab actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            aria-label={`Actions for tab ${tab.name}`}
          >
            <SvgMore size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className="navtree-close"
          onClick={onClose}
          title="Close tab"
          aria-label={`Close tab ${tab.name}`}
        >
          <SvgClose size={13} />
        </button>
        {menu && (
          <NavContextMenu
            x={menu.x}
            y={menu.y}
            onDismiss={() => setMenu(null)}
            items={[
              // Leads the list: on touch this menu (reached by the row's ⋯
              // button) is the ONLY route to pin/unpin — the pin button is
              // desktop-only. See lib/nav-row-affordances.
              tab.pinned
                ? { label: 'Unpin', onSelect: () => onSetPinned(false) }
                : { label: 'Pin to top', onSelect: () => onSetPinned(true) },
              tab.unread
                ? { label: 'Mark as read', onSelect: () => onSetUnread(false) }
                : { label: 'Mark as unread', onSelect: () => onSetUnread(true) },
              {
                label: 'Change icon…',
                onSelect: () => setPicker({ x: menu.x, y: menu.y }),
              },
              { label: 'Rename', onSelect: () => setEditing({ kind: 'tab', id: tab.id }) },
              { label: 'New pane', onSelect: () => onAddPane() },
              // "Move to workspace ▸" with the workspaces in a hover flyout, so
              // the main menu stays short. Omitted entirely when there's nowhere
              // to move to. (Dragging the tab onto a workspace row also works.)
              ...(otherWorkspaces.length > 0
                ? [
                    {
                      label: 'Move to workspace',
                      submenu: otherWorkspaces.map((w) => ({
                        label: w.name,
                        onSelect: () =>
                          void moveTabToWorkspace({
                            tabId: tab.id,
                            tabName: tab.name,
                            fromWorkspaceId: workspace.id,
                            toWorkspaceId: w.id,
                            toWorkspaceName: w.name,
                          }),
                      })),
                    },
                  ]
                : []),
              {
                label: 'Close tab',
                danger: true,
                // onClose expects a MouseEvent for stopPropagation; the menu
                // already dismissed, so a lightweight stub is enough.
                onSelect: () =>
                  onClose({ stopPropagation() {}, preventDefault() {} } as React.MouseEvent),
              },
            ]}
          />
        )}
        {picker && (
          <IconPicker
            x={picker.x}
            y={picker.y}
            onPick={(icon) => {
              setPicker(null);
              onSetIcon(icon);
            }}
            onDismiss={() => setPicker(null)}
          />
        )}
      </div>
      {variant === 'sheet' && sheetPicksPane && panesOpen ? (
        <SheetPaneList
          tab={tab}
          workspace={workspace}
          onNavigate={onNavigate}
          isActiveTab={isActiveTab}
        />
      ) : null}
    </>
  );
}

/** One row in a NavContextMenu. With `submenu`, the row opens a flyout of
 *  child rows on hover instead of acting on click. */
interface MenuItem {
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  submenu?: { label: string; onSelect: () => void }[];
}

/**
 * Cursor-anchored context menu for a nav row (desktop right-click), used by
 * both tab and workspace rows. A full-viewport backdrop catches the
 * outside-click / right-click-elsewhere dismissal; Escape also closes. Kept
 * inside NavTree since it's the only consumer and shares its chrome tokens.
 */
function NavContextMenu({
  x,
  y,
  items,
  onDismiss,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onDismiss: () => void;
}) {
  const [openSub, setOpenSub] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Backdrop mousedown already covers outside-click; the hook adds Escape
  // and keeps this menu on the ONE shared dismissal implementation.
  useDismissable(true, menuRef, onDismiss);
  // Clamp so the menu never spills past the viewport edge (approx size —
  // exact enough to keep all items reachable near the bottom/right).
  const MENU_W = 200;
  const MENU_H = 44 + items.length * 34;
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));
  // Flyout side: open to the left when the menu sits in the right half of the
  // viewport, so the submenu doesn't run off-screen.
  const flyoutLeft = left > window.innerWidth / 2;
  return (
    <div
      className="navtree-menu-backdrop"
      onMouseDown={onDismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        onDismiss();
      }}
    >
      <div
        ref={menuRef}
        className="navtree-menu"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
        role="menu"
      >
        {items.map((it) =>
          it.submenu ? (
            <div
              key={it.label}
              className="navtree-menu-sub"
              onMouseEnter={() => setOpenSub(it.label)}
              onMouseLeave={() => setOpenSub(null)}
            >
              <button
                type="button"
                className="navtree-menu-item navtree-menu-item-parent"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub === it.label}
                onClick={() => setOpenSub((cur) => (cur === it.label ? null : it.label))}
              >
                <span>{it.label}</span>
                <span className="navtree-menu-caret" aria-hidden="true">
                  ›
                </span>
              </button>
              {openSub === it.label && (
                <div className={`navtree-submenu${flyoutLeft ? ' -left' : ''}`} role="menu">
                  {it.submenu.map((sub) => (
                    <button
                      key={sub.label}
                      type="button"
                      className="navtree-menu-item"
                      role="menuitem"
                      onClick={() => {
                        onDismiss();
                        sub.onSelect();
                      }}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              key={it.label}
              type="button"
              className={it.danger ? 'navtree-menu-item -danger' : 'navtree-menu-item'}
              role="menuitem"
              onClick={() => {
                onDismiss();
                it.onSelect?.();
              }}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Anchor-positioned emoji picker (full searchable emoji-mart keyboard).
 * Same backdrop dismissal contract as NavContextMenu (outside-click /
 * right-click / Escape). Picking an emoji calls onPick and closes.
 */
function IconPicker({
  x,
  y,
  onPick,
  onDismiss,
}: {
  x: number;
  y: number;
  onPick: (icon: string) => void;
  onDismiss: () => void;
}) {
  const pickerRef = useRef<HTMLDivElement>(null);
  useDismissable(true, pickerRef, onDismiss);
  // emoji-mart's default picker is ~352×435; clamp so it stays on-screen.
  const W = 360;
  const H = 440;
  const left = Math.max(4, Math.min(x, window.innerWidth - W - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - H - 4));
  return (
    <div
      className="navtree-menu-backdrop"
      onMouseDown={onDismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        onDismiss();
      }}
    >
      <div
        ref={pickerRef}
        className="navtree-emoji-popover"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Suspense fallback={<div className="navtree-emoji-loading">Loading…</div>}>
          <EmojiMartPicker theme={pickerTheme()} onPick={onPick} />
        </Suspense>
      </div>
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="navtree-rename"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(draft.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

/**
 * Pin glyph — a classic push-pin, outlined when the tab is unpinned (an
 * offer) and filled when pinned (a state). Same silhouette either way, so
 * toggling reads as one control changing rather than two different icons.
 */
function SvgPin({ size = 12, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M9.5 1.8 14.2 6.5l-1.6.5a2 2 0 0 0-1 .6l-1.9 2.2.6 1.3-1 1L4 7.7l1-1 1.3.6 2.2-1.9a2 2 0 0 0 .6-1l.4-1.6ZM6.9 9.1 3.2 12.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={filled ? 'currentColor' : 'none'}
        fillOpacity={filled ? 0.35 : 0}
      />
    </svg>
  );
}

/** Horizontal ellipsis — the universal "more actions here" mark. Used on the
 *  mobile sheet, where the row's actions can't hide behind a hover or a
 *  gesture and need a control you can simply see and tap. */
function SvgMore({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="12.5" cy="8" r="1.35" />
    </svg>
  );
}

function SvgChevronRight() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M3 2 L7 5 L3 8"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
