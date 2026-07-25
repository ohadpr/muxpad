import {
  DEFAULT_TAB_ICON,
  type PaneSpec,
  type Tab,
  type Workspace,
  collectLayoutLeaves,
} from '@muxpad/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { createDragOrigin } from '../lib/drag-origin';
import { clearFollowTarget, setFollowTarget } from '../lib/follow-tab';
import { getLastPaneId, setLastPaneId } from '../lib/last-visited';
import { useDismissable } from '../lib/use-dismissable';
import { pushUndo } from '../lib/move-undo-store';
import { isExpanded, toggleExpanded, useNavExpansion } from '../lib/nav-expansion';
import { PANE_DRAG_MIME, paneDragOrigin } from '../lib/pane-drag';
import { reorderByDrop } from '../lib/reorder';
import { applyTabOrder, refreshTabs, useTabs } from '../tabs';
import { useLongPress } from '../use-long-press';
import { MAX_QUICK_SWITCH_TABS, useTabQuickSwitch } from '../use-tab-quickswitch';
import { applyWorkspaceOrder, refreshWorkspaces, useWorkspaces } from '../workspaces';
import { PENDING_AGENT_STARTUP } from '../lib/agent-backend';
import { NewTabChooser } from './NewTabChooser';
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
  persist: (ids: string[]) => void,
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
        if (next !== orderedIds) persist(next);
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
  const { workspaces } = useWorkspaces();
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
        {...(rowDnd && !isEditing ? rowDnd : {})}
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
            {/* Rollup dot only when collapsed — expanded rows show the
                per-tab dots, which say *which* tab wants you, so the
                workspace-level dot would just double-signal. Mirrors the
                tab-count chip below, which is likewise collapsed-only. */}
            {!expanded && workspace.attention && (
              <span className="badge-dot -inline" aria-label="needs attention" />
            )}
          </Link>
        )}
        {!expanded && workspace.tab_count > 0 && (
          // Collapsed rows surface what they're hiding — a quiet tab
          // count, file-navigator style.
          <span className="navtree-ws-count" aria-hidden="true">
            {workspace.tab_count}
          </span>
        )}
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
  const { tabs } = useTabs(workspace.id);
  const [creating, setCreating] = useState(false);

  // Drag-to-reorder tabs within this workspace (desktop sidebar). Reorder
  // claims only the EDGE bands of a row — the middle band belongs to
  // merge-into (see TabRow), so one row hosts both gestures without the
  // drop-line and the merge ring fighting.
  const tabDnd = useListReorder(
    tabs.map((t) => t.id),
    (ids) => {
      applyTabOrder(workspace.id, ids); // move immediately; refresh below reconciles
      void (async () => {
        try {
          await api.reorderTabs(ids);
        } catch (err) {
          console.error('reorder tabs failed', err);
        }
        await refreshTabs(workspace.id);
      })();
    },
    { claimOver: (e) => !inMergeBand(e) },
  );

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
        startup_cmd: PENDING_AGENT_STARTUP,
        face: 'chat',
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
  const quickEnabled = variant === 'sidebar' && isActiveWorkspace;
  const showQuickNumbers = useTabQuickSwitch({
    tabCount: quickEnabled ? tabs.length : 0,
    onSwitch: (i) => {
      const t = tabs[i];
      if (!t) return;
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspace.slug, tabSlug: t.slug },
      });
    },
  });

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
  // full-size pane atomically. Always lands on the harness picker.
  const createTab = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const t = await api.createTab(workspace.id, {
        bootstrap: 'agent',
        backend: 'pick',
      });
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
        <TabRow
          key={t.id}
          tab={t}
          workspace={workspace}
          isActiveTab={isActiveWorkspace && t.slug === activeTabSlug}
          quickNumber={
            showQuickNumbers && quickEnabled && i < MAX_QUICK_SWITCH_TABS ? i + 1 : undefined
          }
          variant={variant}
          isEditing={editing?.kind === 'tab' && editing.id === t.id}
          setEditing={setEditing}
          onNavigate={onNavigate}
          onClose={(e) => void closeTab(e, t)}
          onSetUnread={(want) => void setTabUnread(t, want)}
          onSetIcon={(icon) => void setTabIcon(t, icon)}
          onMergeInto={(payload) => void mergeTabInto(payload, t)}
          onAddPane={() => void addPaneToTab(t)}
          onMovePaneHere={(paneId, sourceTabId) => void movePaneHere(paneId, sourceTabId, t)}
          rowDnd={variant === 'sidebar' ? tabDnd(t.id) : undefined}
        />
      ))}
      <NewTabChooser
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
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getTab(tab.id)
        .then((detail) => {
          if (alive) setPanes(detail.panes);
        })
        .catch(() => {
          // Keep the current list on a transient poll failure; only show empty
          // if we never loaded.
          if (alive) setPanes((prev) => prev ?? []);
        });
    load();
    // Poll while the list is open so each pane's busy/attention indicator
    // stays live (the tab list has its own poll; this fetch is separate).
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
                {/* Per-pane status, same priority as the tab row: WORKING
                    (spinner) → WANTS YOU (dot) → nothing. Tab-level only
                    aggregates; a glance at the list should say which is running. */}
                {p.busy ? (
                  <span className="navtree-busy" aria-hidden="true" title="Working…">
                    <SvgSpinner />
                  </span>
                ) : p.attention ? (
                  <span className="badge-dot -inline" aria-label="needs attention" />
                ) : null}
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
  // menu targets and the legal drop targets for the drag gesture.
  const { workspaces } = useWorkspaces();
  const otherWorkspaces = workspaces.filter((w) => w.id !== workspace.id);

  // Sheet-only: expand the row into its pane list (direct pane nav + the
  // mobile "New pane" home). Single-pane tabs skip all of it — tapping
  // them just opens the tab (there's nothing to pick), so no chevron.
  const paneCount = collectLayoutLeaves(tab.layout).length;
  const sheetPicksPane = variant === 'sheet' && paneCount > 1;
  // Auto-expand the ACTIVE multi-pane tab so its panes are visible the moment
  // the navigator opens — you land already looking at where you can go. Any tab
  // the user has since explicitly toggled keeps that state across reopens (see
  // sheetTabExpanded), instead of snapping shut every time.
  const [panesOpen, setPanesOpen] = useState(() =>
    sheetTabExpanded.has(tab.id)
      ? (sheetTabExpanded.get(tab.id) ?? false)
      : sheetPicksPane && isActiveTab,
  );
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
      {sheetPicksPane && !isEditing ? (
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
          {/* One status slot per row — never two glyphs competing. The states
              are really a progression: a tab is WORKING (spinner), then maybe
              DONE & WANTING YOU (dot), then idle. So show by priority: spinner
              while busy, else the dot if it wants you, else nothing. The
              spinner shows on the ACTIVE tab too — agent panes work quietly
              for minutes on their chat face, and even in a terminal a glance
              at the sidebar should answer "is anything still running here?"
              (the dot still self-hides on the active tab via markSeen). */}
          {tab.busy ? (
            // Decorative: aria-hidden so this fast-toggling glyph doesn't churn
            // the link's accessible name ("Home busy" → "Home" → …). title is
            // the mouse affordance.
            <span className="navtree-busy" aria-hidden="true" title="Working…">
              <SvgSpinner />
            </span>
          ) : tab.attention ? (
            <span className="badge-dot -inline" aria-label="needs attention" />
          ) : null}
        </Link>
      )}
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
 * Busy spinner — a partial ring in `currentColor`, rotated by CSS (.navtree-busy).
 * The wrapper span sets the color (a muted accent that rhymes with the attention
 * dot but stays quieter) and respects prefers-reduced-motion (see NavTree.css).
 */
function SvgSpinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M8 2 a6 6 0 0 1 6 6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
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
