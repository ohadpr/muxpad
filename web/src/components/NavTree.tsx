import {
  type PaneSpec,
  type PaneStatus,
  type Tab,
  type Workspace,
  collectLayoutLeaves,
  fallbackTabIcon,
} from '@muxpad/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { HOUSE_CHAT_CREATE, HOUSE_CHAT_PANE_CREATE } from '../lib/agent-backend';
import { openCommandPalette, paletteChordLabel } from '../lib/command-palette';
import { createDragOrigin } from '../lib/drag-origin';
import { clearFollowTarget, setFollowTarget } from '../lib/follow-tab';
import { getLastPaneId, setLastPaneId } from '../lib/last-visited';
import { pushUndo } from '../lib/move-undo-store';
import { isExpanded, toggleExpanded, useNavExpansion } from '../lib/nav-expansion';
import { tabRowAffordances } from '../lib/nav-row-affordances';
import { nextCronLabel, railCronLabel } from '../lib/next-cron-label';
import { noticeFromError } from '../lib/notice-store';
import { dropFromWorkingSet, useWorkingSet } from '../working-set';

import { recallOpenSubChats, rememberOpenSubChats } from '../lib/rail-folds';
import { reorderByDrop } from '../lib/reorder';
import { orderAfterPinnedDrop } from '../lib/tab-drag';
import { useFrozenTabOrder } from '../lib/tab-freeze';
import { tabRowActions } from '../lib/tab-row-actions';
import { useAllChats } from '../lib/use-all-chats';
import { useArmed } from '../lib/use-armed';
import { useDismissable } from '../lib/use-dismissable';
import { applyTabOrder, insertTabRow, refreshTabs, useTabs } from '../tabs';
import { useLongPress } from '../use-long-press';
import {
  applyWorkspaceOrder,
  refreshWorkspaces,
  useWorkspaces,
  visibleWorkspaces,
} from '../workspaces';
import { ChatChip, chatTooltip, isChatDone, isChatRetired } from './ChatChip';
import { NewTabButton } from './NewTabButton';
import { StateChip } from './StateChip';
import { SwipeRow } from './SwipeRow';
import { SvgClose } from './icons';
import './NavTree.css';
// The flat 'recent' view's own rules. A separate sheet because it is a distinct surface with its own budget (the
// workspace label's max width, the rail's view switch), and NavTree.css is
// already the longest stylesheet here. It adds no geometry — the row is still
// the row, pinned by NavTree.spacing.test.ts — so nothing in the two can drift.

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
 * The navigator — ONE entry point, TWO deliberately different surfaces.
 *
 *   variant="sidebar" — the desktop left rail (SidebarTree below). A dense
 *     file navigator: collapsible workspace groups, indented tab rows carrying
 *     a headline, a schedule and a state word, hover-revealed pin/close,
 *     double-click rename, drag-to-reorder.
 *   variant="sheet"   — the mobile drop-down panel (SheetRail below). NOT the
 *     same tree at thumb height: a flat, one-line-per-chat rail whose only
 *     permanent mark is a dot on the chats that are waiting on you.
 *
 * ─── Why these two forked, on purpose ────────────────────────────────────
 * They shared a component and a stylesheet for a long time, and the sheet
 * inherited every channel the rail had room for. A shipped sheet row carried
 * twelve: emoji, name, headline, state bar, state tint, state dot, state word,
 * unread weight, pin glyph, pane count, cron time, chevron. Twelve is busy at
 * any weight in any palette — the fix is not weight or palette, it is deletion,
 * and what a 390px thumb surface can afford to delete is not what a 280px
 * pointer surface can. So the sheet's row shape, its spacing scale and its
 * state encoding are its own, and the desktop rail below is untouched.
 *
 * The sheet's whole rule is in SheetRail's header. The short version: five
 * states collapse to one bit, the headline leaves the list, pinning is order
 * rather than a glyph, and nothing lives in the scroller that is not a chat.
 */
export function NavTree({ activeWorkspaceSlug, activeTabSlug, variant, onNavigate }: NavTreeProps) {
  if (variant === 'sheet') {
    return (
      <SheetRail
        activeWorkspaceSlug={activeWorkspaceSlug}
        activeTabSlug={activeTabSlug}
        {...(onNavigate ? { onNavigate } : {})}
      />
    );
  }
  return (
    <SidebarTree
      activeWorkspaceSlug={activeWorkspaceSlug}
      activeTabSlug={activeTabSlug}
      {...(onNavigate ? { onNavigate } : {})}
    />
  );
}

/**
 * The DESKTOP rail. Hierarchy is carried by STRUCTURE (disclosure + indent)
 * and by two channels that never share an encoding — a solid accent block for
 * "you are here", a left bar + faint tint + word for "what this chat is doing"
 * (see StateChip.tsx) — not by type-size escalation.
 *
 * Every workspace is collapsible, including the active one. Expansion state
 * persists across sessions (lib/nav-expansion.ts); untouched workspaces
 * default to "expanded iff active", so the dominant flow — switching tabs
 * inside the current workspace — is always one click.
 */
/**
 * THE WORKING-SET STRIP.
 *
 * The chats you are moving between, in slots that do not move. All of the
 * reasoning — why not MRU, why six, why eight hours — is in
 * shared/src/working-set.ts, because that is where the algorithm is and a
 * decision explained beside its implementation is one that survives.
 *
 * Renders NOTHING when empty, including the heading. A section that says
 * "WORKING ON" above no rows is a promise the rail is not keeping, and on a
 * fresh install or after a long break that is the normal state.
 *
 * The rows are the ORDINARY rows — same component, same icon, same status
 * column, same family tint. A second visual language for the same object is
 * how a sidebar stops being scannable, and the chat appearing twice is correct:
 * the strip is a shortcut, not a move. Its own workspace must not start lying
 * about what it contains.
 */
function WorkingSetStrip({
  activeTabSlug,
  onNavigate,
  touch,
}: {
  activeTabSlug: string | null;
  onNavigate?: (() => void) | undefined;
  /** The sheet. No hover to reveal a control and no Control key to press. */
  touch?: boolean | undefined;
}) {
  const rows = useWorkingSet();
  const navigate = useNavigate();

  // ⌃1…⌃6, and NOT ⌘ — Chrome binds ⌘1-9 to its own tab switcher, and a
  // shortcut that fights the browser is a shortcut nobody can use. Control is
  // free on both platforms here.
  //
  // The slots' stability is the whole reason a numbered shortcut is worth
  // having: a number pointing at a list that renumbers itself is worse than no
  // number at all, because you learn it and it lies.
  useEffect(() => {
    if (touch) return; // no keyboard to bind, and two listeners would double-fire
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > rows.length) return;
      const hit = rows[n - 1];
      if (!hit) return;
      e.preventDefault();
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: hit.workspace.slug, tabSlug: hit.tab.slug },
      });
      onNavigate?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, navigate, onNavigate, touch]);

  if (rows.length === 0) return null;
  return (
    <div className="navtree-workingset" aria-label="Working on">
      <div className="navtree-workingset-head" aria-hidden="true">
        Working on
      </div>
      {rows.map(({ tab, workspace }, i) => (
        <WorkingSetRow
          key={tab.id}
          tab={tab}
          workspace={workspace}
          slot={i + 1}
          active={tab.slug === activeTabSlug}
          {...(touch ? { touch: true } : {})}
          {...(onNavigate ? { onNavigate } : {})}
        />
      ))}
    </div>
  );
}

/** One slot. The `×` means "not now" — it frees the slot and nothing else. */
function WorkingSetRow({
  tab,
  workspace,
  slot,
  active,
  onNavigate,
  touch,
}: {
  tab: Tab;
  workspace: { slug: string; name: string };
  slot: number;
  active: boolean;
  onNavigate?: (() => void) | undefined;
  touch?: boolean | undefined;
}) {
  return (
    <div
      className="navtree-tab-row navtree-ws-slot"
      data-active={active ? 'true' : undefined}
      data-touch={touch ? 'true' : undefined}
    >
      <span className="chatchip navtree-tab-chip" data-density="row" data-shape="tile">
        <b className="chatchip-glyph">{tab.icon ?? fallbackTabIcon(tab.id)}</b>
      </span>
      <Link
        to="/w/$wsSlug/t/$tabSlug"
        params={{ wsSlug: workspace.slug, tabSlug: tab.slug }}
        className="navtree-tab-link"
        draggable={false}
        title={`${tab.name} · ${workspace.name}`}
        onClick={() => onNavigate?.()}
      >
        <span className="navtree-tab-titleline">
          <span className="navtree-name-text" dir="auto">
            {tab.name}
          </span>
        </span>
      </Link>
      {/* NO CONTROLS ON TOUCH, which is the rule every other row here already
          follows (tabRowAffordances): a phone has no hover to reveal one and
          no Control key to label. The slot still decays on its own and is
          still evictable from the desktop, so nothing is unreachable — the
          strip's job on a phone is one tap to the chat. */}
      <span className="navtree-tab-rail">
        {touch ? null : <kbd className="navtree-slot-key">{`⌃${slot}`}</kbd>}
        <button
          type="button"
          className="navtree-close navtree-slot-drop"
          title="Not now — free this slot"
          aria-label={`Remove ${tab.name} from Working on`}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            void dropFromWorkingSet(tab.id);
          }}
        >
          ×
        </button>
      </span>
      <RowMark status={tab.status} />
    </div>
  );
}

function SidebarTree({
  activeWorkspaceSlug,
  activeTabSlug,
  onNavigate,
}: Omit<NavTreeProps, 'variant'>) {
  const variant = 'sidebar' as const;
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
      // The first tab is the HOUSE CHAT — identical to what "+ New tab" above
      // creates, so the two `+` buttons in this same tree can no longer
      // disagree about what a new thing is.
      const w = await api.createWorkspace();
      const t = await api.createTab(w.id, { ...HOUSE_CHAT_CREATE });
      // THIS await STAYS, unlike the one createHouseTab dropped. The route we
      // are about to navigate to resolves `wsSlug` out of the workspaces cache,
      // and a workspace created this instant is in no cache anywhere — there is
      // no `insertTabRow` equivalent to lean on, so the list has to land first.
      // It is ~30ms against two creates that precede it, and the seconds this
      // path used to cost were never here: they were the pty spawn inside the
      // second create (EAGER_SPAWN_WAIT_MS).
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
      {/* SEARCH IS THE PALETTE. This was an inline field that swapped the
          tree for its own result list — the same engine as ⌘K, in a second
          surface with its own query state, keyboard contract and focus rules.
          One search is enough; this is the door to it, and it says which key
          opens it so the button teaches the chord. */}
      <button type="button" className="navtree-search" onClick={openCommandPalette}>
        <SvgSearchGlyph size={14} />
        <span className="navtree-search-label">Search chats</span>
        <kbd className="navtree-search-kbd">{paletteChordLabel()}</kbd>
      </button>
      {/* ─── THE WORKING SET ──────────────────────────────────────────────
          Above the scroller, not inside it, and that is the point: a strip you
          have to scroll to is a strip you will search for, which is the thing
          it exists to end. It is six rows at most — see shared/working-set.ts
          for the simulation behind the number. */}
      <WorkingSetStrip activeTabSlug={activeTabSlug} {...(onNavigate ? { onNavigate } : {})} />
      <div className="navtree-scroll">
        {/* NO CREATE CONTROL HERE, and none in the list either. It is on each
            WORKSPACE HEADER — see WorkspaceNode. That is the row the action is
            about, so the button needs no label saying where it creates and
            costs the list no row of its own.

            Its history, because this is the third arrangement: it began as a
            "+ New tab" row at the BOTTOM of each workspace's list (scrolled out
            of reach in a workspace with twenty chats), became one button at the
            top of the rail with a workspace picker (read as bolted on, and
            picking a workspace did not reliably land you in the chat), then a
            row at the TOP of each list (fine, but still a row — and the list is
            for chats). The header had been the right place the whole time. */}
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
        {/* The one create action that is still a ROW, and it has to be: a new
            WORKSPACE belongs to no workspace, so there is no header to hang it
            on. It sits under the tree, at the workspace indent, in the same
            action language the headers' `+` speaks. */}
        <button
          type="button"
          className="navtree-add navtree-new-workspace"
          onClick={() => void createWorkspace()}
          disabled={creatingWs}
        >
          {creatingWs ? 'Creating…' : '+ New workspace'}
        </button>
        {/* Hosted lives BELOW the tree, past a hairline, because it is not part
            of it: apps and artifacts belong to no workspace and occupy no tab —
            that is the whole point. Rendered in both variants, so the mobile
            sheet reaches it too. */}
        <div className="navtree-foot">
          <Link
            className="navtree-foot-link"
            to="/hosted"
            activeProps={{ 'data-active': 'true' }}
            onClick={() => onNavigate?.()}
          >
            <SvgHosted />
            <span className="navtree-name-text">Hosted</span>
          </Link>
        </div>
      </div>
    </nav>
  );
}

/** Stacked layers — "things I have put somewhere and can point a browser at".
 *  Same 1.5px lucide-ish geometry as the rest of the nav's glyphs. */
function SvgHosted() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 2 8l10 5 10-5-10-5z" />
      <path d="M2 16l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

/** Make a new Chat in `workspace` and go there. Shared by the sheet's bar
 *  "+" and the desktop rail's "+ New tab" so the two cannot disagree about
 *  what a new chat is. */
async function createHouseTab(
  workspace: Workspace,
  navigate: ReturnType<typeof useNavigate>,
  onNavigate?: (() => void) | undefined,
): Promise<void> {
  // Tabs-first creation: one server call makes the tab AND its single
  // full-size pane atomically, already running in Chat mode. No "what do you
  // want to open?" screen — the alternatives live in the empty chat's own
  // "open instead:" strip, where they cost nothing until you want one.
  const t = await api.createTab(workspace.id, { ...HOUSE_CHAT_CREATE });
  // ─── ONE ROUND TRIP, THEN GO ───────────────────────────────────────────────
  // This used to `await refreshTabs()` and `await refreshWorkspaces()` here,
  // and only then navigate — so the sidebar's button sat in `Creating…` for
  // the create PLUS two more round trips, and the user watched a disabled
  // button instead of the thing they made. Both of those refreshes are already
  // fired by main.tsx's `tab.added` handler, from the event the server emits
  // during this very create; awaiting our own duplicates only moved the wait
  // in front of the navigation.
  //
  // The create itself is now the only thing on the path, and the server no
  // longer holds it open for the pty spawn (see EAGER_SPAWN_WAIT_MS). What the
  // user waits for is one POST.
  //
  // The tab we just got back is spliced into the cache BEFORE navigating,
  // because TabView resolves this slug through `freshTabs` and a
  // still-fresh pre-create list would answer "tab not found" and bounce out of
  // the new chat. See insertTabRow.
  insertTabRow(workspace.id, t);
  onNavigate?.();
  void navigate({
    to: '/w/$wsSlug/t/$tabSlug',
    params: { wsSlug: workspace.slug, tabSlug: t.slug },
  });
  // Reconciliation, off the critical path. The `tab.added` push normally gets
  // here first and makes these no-ops; they are the fallback for a socket that
  // is down, where otherwise the workspace rollup (tab_count, the corpus) would
  // lag until the 5s poll. Deliberately not awaited and deliberately last: the
  // user is already looking at the new chat.
  void refreshTabs(workspace.id);
  void refreshWorkspaces();
}

/**
 * The MOBILE RAIL — a flat list of chats, and one bar above it.
 *
 * ─── The rule, in one paragraph ──────────────────────────────────────────
 * Five states collapse to ONE BIT: wants-you, or not. Only `blocked` earns a
 * permanent mark (a dot). `working` keeps only the spinner, because it is
 * transient by definition. `ready` is carried by the name's WEIGHT, a channel
 * the row already has. `dead` gets nothing. There are no row tints, no left
 * state bars, no word chips and no marks at all on an idle row — a mark on
 * every row is not a signal. The headline leaves the list (it is what made
 * every row two lines, and it already exists in search results and in the
 * chat). Pinning is ORDER, not a glyph. The emoji stays, because it is the
 * fastest recognition token in the list — faster than reading a Hebrew name —
 * but it loses the plate behind it. Most rows are therefore an emoji and a
 * name and nothing else, and the two or three that want you are the only other
 * ink on screen.
 *
 * ─── Nothing lives in the scroller that is not a chat ────────────────────
 * That is the structural half, and it is what this component exists to do.
 * The workspace header and the search field used to be rows in the list; both
 * are now controls in the ONE bar above it. So is "+ New chat". The workspace
 * button swaps the list for a workspace picker (which also owns "+ New
 * workspace", Hosted, and closing a workspace); the magnifier opens the ⌘K
 * palette, so the resting rail is one bar and a column of chats.
 *
 * ─── Order is frozen while this is open ──────────────────────────────────
 * With the marks gone, the rail's information lives almost entirely in order —
 * and order is server-computed and re-derived every 5s. See lib/sheet-order:
 * the list snapshots its order on open and holds it until close, while every
 * row's live status keeps updating in place.
 */
function SheetRail({
  activeWorkspaceSlug,
  activeTabSlug,
  onNavigate,
}: Omit<NavTreeProps, 'variant'>) {
  const navigate = useNavigate();
  const { workspaces: allWorkspaces } = useWorkspaces();
  const workspaces = visibleWorkspaces(allWorkspaces);
  const [editing, setEditing] = useState<Editing>(null);
  /**
   * Which surface the scroller is showing. `null` — the chats — is the resting
   * state and by far the common one; the picker is a detour you come straight
   * back from. ONE list answers two questions:
   *   'switch'  the bar's `Name ⌄` — show me THAT workspace's chats.
   *   'create'  the bar's "+", in the flat view only — put the new chat THERE.
   */
  const [picking, setPicking] = useState<'switch' | null>(null);
  const [busy, setBusy] = useState(false);
  // Which workspace's chats are listed. Follows the URL, until you pick
  // another one from the bar — looking at another workspace's chats must not
  // require navigating into it first. A picked workspace that then disappears
  // falls back to the active one via the lookup below.
  // Same store the rail uses, so a workspace you opened on one surface is
  // open on the other.
  const expansion = useNavExpansion();
  const [picked, setPicked] = useState<string | null>(null);
  const shown =
    workspaces.find((w) => w.slug === (picked ?? activeWorkspaceSlug)) ??
    workspaces.find((w) => w.slug === activeWorkspaceSlug) ??
    workspaces[0];

  // The bar says which workspace you are looking at, and that is also where its
  // "+" creates — one answer, already on screen, so the button never has to ask.
  const barLabel = shown?.name ?? 'Workspaces';
  const newChatIn = shown;

  const newChat = async (target: Workspace) => {
    if (busy) return;
    setBusy(true);
    try {
      await createHouseTab(target, navigate, onNavigate);
      setPicking(null);
    } catch (err) {
      console.error('createTab failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav className="navtree" data-variant="sheet" aria-label="Chats">
      {/* THE bar. One row, and it is the only chrome above the list. */}
      <div className="navtree-bar">
        {/* A LABEL, not a control. The bar used to open a workspace PICKER,
              because the sheet showed one workspace at a time and getting to
              another meant choosing it first. The list below now holds every
              workspace, so there is nothing left to pick — and a button that
              swapped the whole list for a different list was the thing that
              made this surface feel like clicking in and out of a folder. */}
        <span className="navtree-bar-wsname" dir="auto">
          Chats
        </span>
        {/* The palette, not a field of our own — and on a phone this is the
              ONLY way to it, since there is no ⌘K. The sheet steps aside first:
              a result navigates, and a sheet left open over the chat you just
              picked is one more tap to get rid of. */}
        <button
          type="button"
          className="navtree-bar-icon"
          onClick={() => {
            onNavigate?.();
            openCommandPalette();
          }}
          aria-label="Search chats"
        >
          <SvgSearchGlyph />
        </button>
        {/* NO "+" HERE EITHER. It created in "the workspace the bar names",
              and the bar no longer names one — every workspace is on screen,
              and each header carries its own, exactly as on the rail. A single
              bar button would have had to pick one of them on your behalf,
              which is the guess this navigator keeps being redesigned to
              avoid. */}
      </div>
      {/* ─── THE WORKING SET, ON THE PHONE TOO ─────────────────────────────
          Above the scroller, same as the rail. The cost of hunting for a chat
          is HIGHER here, not lower — the list is the whole screen and there is
          no ⌘K chord on a thumb — so leaving it off the surface that needs it
          most was simply a miss. */}
      <WorkingSetStrip
        activeTabSlug={activeTabSlug}
        touch={true}
        {...(onNavigate ? { onNavigate } : {})}
      />
      <div className="navtree-scroll">
        {/* EVERY WORKSPACE, like the desktop rail. The sheet used to render one
            workspace's TabList and reach the others through a picker that
            replaced the whole list — so moving between them was a mode change,
            and you had to remember which one you were in. Reported as clicking
            in and out of the workspace name.
            Same WorkspaceNode the rail uses, so the two surfaces cannot drift
            about what a workspace row is, what collapses, or where the done
            drawer lives. Collapsed-by-default keeps the scroller short: only
            the workspace you are in is open (isExpanded). */}
        {workspaces.map((w) => (
          <WorkspaceNode
            key={w.id}
            workspace={w}
            isActive={w.slug === activeWorkspaceSlug}
            expanded={isExpanded(expansion, w.slug, activeWorkspaceSlug)}
            activeWorkspaceSlug={activeWorkspaceSlug}
            activeTabSlug={activeTabSlug}
            variant="sheet"
            editing={editing}
            setEditing={setEditing}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}

/**
 * THE WORKSPACE PICKER — one list, two questions, both surfaces.
 *
 * It began as the sheet's: what the bar's `Name ⌄` button swaps the chat list
 * for, holding everything that used to be a workspace-level row IN the chat
 * list — switching, renaming (long-press), closing, "+ New workspace", and the
 * Hosted destination. Rows speak the rail's own language — 44px, full-bleed
 * selection, one trailing mark carrying the workspace's rolled-up state — so
 * the surface reads as the same list showing a different thing, not as a
 * second kind of navigator.
 *
 * ONE question now, and one only: show me THAT workspace's chats. It briefly
 * answered a second — "put the new chat THERE", for a top create button that had
 * no workspace on screen to create in — and that button is gone: creating is on
 * each workspace's own header row, where the destination is the thing you
 * clicked. A picker is the right shape for a question whose answer you have to
 * choose; it was always the wrong shape for one already on screen.
 *
 * Gone with it: the "Recent" row at the head, which was the mobile half of the
 * flat cross-workspace view. That view is removed entirely — see NavTree's
 * header.
 *
 * The one row both keep is "+ New workspace": "somewhere new" is a legitimate
 * answer to "where", and it already makes the workspace AND its house chat in
 * one go — which is precisely what picking an existing one does.
 */
function WorkspacePickList({
  workspaces,
  shownId,
  editing,
  setEditing,
  onPick,
  onNavigate,
}: {
  workspaces: Workspace[];
  /** The row drawn as current — the workspace whose chats are on screen. */
  shownId: string | null;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onPick: (w: Workspace) => void;
  onNavigate?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const createWorkspace = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // Bootstrap workspace + first Chat in one go so you land somewhere
      // usable — identical to what the bar's "+" makes inside a workspace.
      const w = await api.createWorkspace();
      await createHouseTab(w, navigate, onNavigate);
    } catch (err) {
      console.error('createWorkspace failed', err);
    } finally {
      setCreating(false);
    }
  };

  const closeWorkspace = async (e: React.MouseEvent, w: Workspace) => {
    e.stopPropagation();
    e.preventDefault();
    // The confirmation is the × itself (ArmedClose), not a dialog: this row
    // lives on the sheet, where `window.confirm` is silently a no-op — which
    // is why a thumb used to be able to delete a workspace in one tap.
    try {
      await api.deleteWorkspace(w.id);
      await refreshWorkspaces();
    } catch (err) {
      console.error('deleteWorkspace failed', err);
      noticeFromError(`Couldn't close "${w.name}".`, err);
    }
  };

  return (
    // No focus trap and no tabIndex: this is a column of buttons in the
    // document flow, so Tab walks into it and Tab walks back out. It used to
    // catch Escape too, for the create surface — a detour you could cancel back
    // to the chats. The switch surface has no "before" to go back to (picking a
    // workspace IS the navigation), and it is the only surface left.
    <div className="navtree-tab-list">
      {workspaces.map((w) => (
        <WorkspacePickRow
          key={w.id}
          workspace={w}
          choosing={false}
          isShown={w.id === shownId}
          isEditing={editing?.kind === 'workspace' && editing.id === w.id}
          setEditing={setEditing}
          onPick={() => onPick(w)}
          onClose={(e) => void closeWorkspace(e, w)}
        />
      ))}
      <button
        type="button"
        className="navtree-add navtree-new-workspace"
        onClick={() => void createWorkspace()}
        disabled={creating}
      >
        {creating ? 'Creating…' : '+ New workspace'}
      </button>
      {/* Hosted is deliberately NOT a workspace row: apps and artifacts belong
          to no workspace and occupy no tab. It sits past a hairline, at the
          foot of the one surface that lists destinations — never in the chat
          list, which contains chats and nothing else.
      */}
      {
        <div className="navtree-foot">
          <Link
            className="navtree-foot-link"
            to="/hosted"
            activeProps={{ 'data-active': 'true' }}
            onClick={() => onNavigate?.()}
          >
            <SvgHosted />
            <span className="navtree-name-text">Hosted</span>
          </Link>
        </div>
      }
    </div>
  );
}

function WorkspacePickRow({
  workspace,
  choosing,
  isShown,
  isEditing,
  setEditing,
  onPick,
  onClose,
}: {
  workspace: Workspace;
  /** Answering "where does the new chat go" rather than "show me that
   *  workspace". Strips the row to a destination — no ×, no long-press
   *  rename, no state mark; see the list's header for why each one goes. */
  choosing: boolean;
  isShown: boolean;
  isEditing: boolean;
  setEditing: (e: Editing) => void;
  onPick: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  // Long-press renames, exactly as it did on the row this replaces.
  const { pressing, handlers } = useLongPress({
    onLongPress: () => setEditing({ kind: 'workspace', id: workspace.id }),
    fireOnTimer: true,
  });
  if (isEditing) {
    return (
      <div className="navtree-wspick-row">
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
      </div>
    );
  }
  if (choosing) {
    return (
      <div className="navtree-wspick-row" data-active={isShown ? 'true' : undefined}>
        <button type="button" className="navtree-wspick-name" onClick={onPick}>
          <span className="navtree-name-text" dir="auto">
            {workspace.name}
          </span>
        </button>
        {/* The default is NAMED, not merely tinted. The band alone is the same
            mark this list's other purpose uses for "you are here", and here it
            has to survive being read at a glance, before a click. */}
        {isShown ? <span className="navtree-wspick-note">default</span> : null}
      </div>
    );
  }
  return (
    <div
      className="navtree-wspick-row"
      data-active={isShown ? 'true' : undefined}
      data-pressing={pressing ? 'true' : undefined}
    >
      <button
        type="button"
        className="navtree-wspick-name"
        {...handlers}
        onClick={(e) => {
          handlers.onClick(e);
          if (e.defaultPrevented) return; // long-press consumed the tap
          onPick();
        }}
      >
        <span className="navtree-name-text" dir="auto">
          {workspace.name}
        </span>
      </button>
      {/* The same one-bit mark the chat rows use, rolled up by the server. A
          workspace you are not looking at is exactly the case that mark is
          for. */}
      <StateChip status={workspace.status} mode="mark" className="navtree-rail-mark" />
      <ArmedClose
        onConfirm={onClose}
        title="Close workspace"
        armedTitle="Tap again — this kills every tab and pane in it"
        label={`Close workspace ${workspace.name}`}
        armedLabel={`Tap again to close ${workspace.name} and all its tabs`}
      />
    </div>
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

  // Reorder dnd for the header row — dropped while renaming (an input owns the
  // row then, and dragging text inside it must not start a row drag).
  const wsRowDnd = rowDnd && !isEditing ? rowDnd : undefined;

  /**
   * "+ New chat", ON THE HEADER. The destination is the row the button is drawn
   * on, so there is nothing to ask and nothing to label.
   */
  // The sheet's "⋯" menu, anchored under the button that opened it.
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const createHere = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    try {
      // Creating in a COLLAPSED workspace opens it: you are about to be taken
      // to the new chat, and coming back to a workspace still folded shut over
      // the thing you just made is the one outcome nobody wants.
      if (!expanded) toggleExpanded(workspace.slug, activeWorkspaceSlug);
      await createHouseTab(workspace, navigate, onNavigate);
    } catch (err) {
      console.error('createTab failed', err);
    } finally {
      setCreating(false);
    }
  };

  // NO PANE DROPS. The header used to accept a pane dragged off the tab strip
  // and turn it into a new tab here. It is gone with the rest of the
  // drag-a-thing-into-a-thing family: the gesture had no visible target
  // vocabulary (a workspace header means "this group", not "extract that pane
  // into a fresh tab inside it") and the same move is a context-menu item that
  // says what it does. The ONE drop this tree still takes is a TAB, below.
  const closeWorkspace = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    // NO CONFIRMATION HERE ANY MORE, and that is not the same as no
    // confirmation: closing cascade-kills every tab and pane, so both callers
    // ask first — the × arms in place (ArmedClose) and the menu row arms in
    // place (MenuItem.confirm). It moved out of this function because the two
    // surfaces could not share a `window.confirm`: it is a silent no-op in the
    // iOS PWA, so the sheet had to skip it entirely and the one surface where
    // a thumb can hit × by accident was the one with no guard at all.
    try {
      await api.deleteWorkspace(workspace.id);
      await refreshWorkspaces();
      if (isActive) {
        onNavigate?.();
        void navigate({ to: '/' });
      }
    } catch (err) {
      console.error('deleteWorkspace failed', err);
      noticeFromError(`Couldn't close "${workspace.name}".`, err);
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
        // No `data-state`, for the same reason the chat rows below dropped it
        // (see RowMark): it is what painted the left bar and the row tint, and
        // both are gone from the desktop rail. A workspace header that washed
        // amber while its chats did not would be the loudest thing in a rail
        // whose chats now whisper.
        data-unread={workspace.unread ? 'true' : undefined}
        data-pressing={pressing ? 'true' : undefined}
        data-tab-drop={tabDropOver ? 'true' : undefined}
        {...wsRowDnd}
        // Pane drops are layered ON TOP of workspace-reorder dnd: a pane drag
        // is claimed here and goes no further, anything else falls through to
        // the reorder handlers spread above (hence the explicit chaining —
        // these props would otherwise just replace them).
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
        {/* Everything from here down stands down while the row is being
            renamed — the same rule TabRow follows. The editing template is two
            tracks wide, so a chip or a button left rendered resolves into an
            IMPLICIT column and takes the width the input needs (measured: a
            22px rename box). */}
        {!isEditing && !expanded && workspace.tab_count > 0 && (
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
        {/* THE SHEET'S PAIR: "+" and "⋯", nothing else. Three controls at a
            real 44px touch target would take 132px of a phone-width row, and
            the desktop's 20px squares are too small for a thumb AND put the
            "+" 6px from the × that deletes the workspace. So the row keeps the
            action you take all day, and the rare ones — settings, rename, and
            the destructive close — go one tap deeper, where close is a labelled
            red row rather than a glyph beside "+". */}
        {!isEditing && variant === 'sheet' && (
          <span className="navtree-tab-controls">
            <button
              type="button"
              className="navtree-close navtree-ws-add"
              onClick={(e) => void createHere(e)}
              disabled={creating}
              aria-label={`New chat in ${workspace.name}`}
            >
              <SvgPlus size={15} />
            </button>
            <button
              type="button"
              className="navtree-close navtree-ws-more"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setMoreAt({ x: r.right, y: r.bottom });
              }}
              aria-label={`More for ${workspace.name}`}
              aria-haspopup="menu"
              aria-expanded={moreAt !== null}
            >
              <SvgMore />
            </button>
          </span>
        )}
        {!isEditing && variant === 'sidebar' && (
          <span className="navtree-tab-controls">
            {/* ALWAYS VISIBLE, unlike the × beside it. The two are opposites:
                one makes a thing and one destroys a workspace and everything in
                it, and a destructive control that is only there when you are
                already pointing at the row is exactly right. Reported twice
                about the old top button — "it's hard to see" — so this one does
                not hide, it just sits at the weight of the rest of the row's
                chrome and comes up on hover. */}
            <button
              type="button"
              className="navtree-close navtree-ws-add"
              onClick={(e) => void createHere(e)}
              disabled={creating}
              title={`New chat in ${workspace.name}`}
              aria-label={`New chat in ${workspace.name}`}
            >
              <SvgPlus />
            </button>
            <ArmedClose
              onConfirm={(e) => void closeWorkspace(e)}
              title="Close workspace"
              armedTitle={`Click again — ${workspace.tab_count} ${
                workspace.tab_count === 1 ? 'tab' : 'tabs'
              } and their panes will be killed`}
              label={`Close workspace ${workspace.name}`}
              armedLabel={`Click again to close ${workspace.name} and all its tabs`}
            />
          </span>
        )}
        {/* LAST cell, always — same rule as the tab rows.
            An EXPANDED workspace says nothing here: its tabs carry their own
            state and a rollup on top of them would double-signal. It still
            renders an `idle` chip rather than nothing, so the cell exists in
            the grid either way. */}
        {/* Same 10px mark, same slot, one track back from the chat rows' —
            a collapsed workspace speaks for the chats it is hiding, and an
            expanded one has nothing to add over the rows now visible below. */}
        {!isEditing && <RowMark status={expanded ? 'idle' : workspace.status} />}
      </div>
      {moreAt && (
        <NavContextMenu
          x={moreAt.x}
          y={moreAt.y}
          touch={true}
          alignEnd={true}
          onDismiss={() => setMoreAt(null)}
          items={[
            {
              label: 'Rename',
              onSelect: () => setEditing({ kind: 'workspace', id: workspace.id }),
            },
            // LAST, and red: the one item here that cannot be taken back.
            {
              label: 'Close workspace',
              danger: true,
              confirm: 'Tap again to close it and all its tabs',
              onSelect: () => void closeWorkspace(),
            },
          ]}
        />
      )}
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
 *
 * EXPORTED for one reason, and it is the same reason `groupChats` is: what this
 * renders decides what you can SEE. `groupChats` is the grouping rule and is
 * unit-tested; this is the HANDOFF from that rule to the rows, and the handoff
 * is where the child's dot and indent went missing for three reviews — a bug
 * invisible to both a grouping test and a stylesheet test, because each was
 * right about its own half. See NavTree.rows.test.tsx.
 */
export function TabList({
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
  // Archive / delete / unread / icon / pin, shared verbatim with the flat
  // 'recent' list (lib/tab-row-actions) so the two lists cannot drift about
  // what a write is or which caches it has to refresh.
  const actions = tabRowActions(workspace);

  // ── The living sidebar's two blocks ─────────────────────────────────────
  // The SERVER owns the order (pinned first in manual order, then unpinned
  // auto-sorted by attention → recency) and the client never re-sorts, so a
  // poll can never fight a local sort. It no longer has to find the SEAM
  // either: the pinned block had a divider drawn at `livePinned`, and the mark
  // moved onto the rows themselves (--nt-pinned-ink), so the index went with
  // the element.
  //
  // The single exception is the tab you're LOOKING AT: it holds the best
  // position it has reached for as long as it's active (useFrozenTabOrder) and
  // settles into its sorted place when you leave. Being in a tab is itself
  // activity, so without this the row under your cursor gets shoved about by
  // every other chat that goes busy. It moves ONE row and never writes.
  //
  // ─── THE SHEET USED TO FREEZE THE WHOLE LIST ───────────────────────────────
  // For as long as it was open, on the reasoning that the sheet's rows carry
  // almost no marks any more — so order is most of what the list says, and a
  // quiet list that reshuffles under a thumb loses the row you were reaching
  // for. The premise is true. The conclusion does not follow: it argues for the
  // order being RIGHT, and freezing whatever was cached when the sheet opened
  // is how it ends up wrong.
  //
  // Which is what was reported — "if I go to mobile the sort order of the tabs
  // is not right, this thing doesn't auto update". On a phone the document is
  // hidden most of the time, so the 5s poll is stopped and the cache can be
  // minutes old; the sheet then snapshotted THAT and held it for the whole
  // visit, so a correction arriving a second after you opened it could never
  // land. The list was not slow. It was frozen at the wrong moment.
  //
  // And the cost the freeze was buying is smaller here than it looks: the sheet
  // is open for a few seconds at a time, so the window in which a reshuffle
  // could steal a tap is narrow — while being stale lasts the entire visit.
  //
  // So both surfaces now run the same rule, which is also one fewer place for
  // "what order is this list in" to be decided. lib/sheet-order is deleted.
  const sheet = variant === 'sheet';
  const activeTabId =
    (isActiveWorkspace && serverTabs.find((t) => t.slug === activeTabSlug)?.id) || null;
  const tabs = useFrozenTabOrder(serverTabs, activeTabId);

  // ── The live list, the done group, and the nesting ──────────────────────
  // groupChats is pure and unit-tested (NavTree.chats.test.tsx) — it decides
  // what is a child, what has decayed out of the live list, and where the pin
  // seam falls once the decayed rows are gone.
  //
  // BOTH VARIANTS GROUP. The sheet used to map every chat to `{children: []}`
  // and drop `done` entirely, on the reasoning that "the mobile rail is one
  // flat line per chat by design". The consequence, reported from the phone:
  // a spawned sub-chat came out as a TOP-LEVEL row sorted by recency, which
  // put it ABOVE its own parent with a full tile and no mark — and every
  // retired agent and every decayed chat stayed in the live list forever,
  // because the one surface that files them away was switched off on the one
  // device this user actually reads the list on.
  //
  // The hierarchy is not a desktop ornament; it is what keeps the list short.
  // A flat line per chat is a statement about the ROW's density — no headline,
  // no pane count, no tint — and it survives intact: a child is still one
  // line, it just knows whose line it is under.
  const grouped = groupChats(tabs);
  const liveGroups = grouped.live;
  const doneGroups = grouped.done;
  const doneCount = doneChatCount(doneGroups);
  const subGroups = grouped.doneSubs;
  const subCount = subGroups.reduce((n, g) => n + g.children.length, 0);
  // COLLAPSED by default. A chat crossing into done should be something you
  // notice leaving the live list, not something that re-opens a drawer of
  // fourteen finished chats under it.
  const [doneOpen, setDoneOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  // Which parents' sub-chats are open — REMEMBERED, because collapsing by
  // default is only tolerable if opening sticks across the remounts a sidebar
  // sees all day (see lib/rail-folds). Read once, lazily: localStorage in a
  // render body would run on every keystroke in the rename field.
  const [openSubs, setOpenSubs] = useState<Set<string>>(() => recallOpenSubChats());
  // RE-READ, don't edit the snapshot. Every expanded workspace mounts its own
  // TabList, and the sheet mounts another beside the rail — each one read the
  // store at ITS mount and then wrote back its whole copy, so opening a group
  // in one list silently erased the groups opened in a list that mounted
  // earlier. (Open P in workspace A, then Q in B: the store ends up {Q}, and P
  // is shut on the next reload.) The store is the shared state; the component
  // holds a view of it.
  const toggleSubs = (tabId: string) => {
    setOpenSubs(() => {
      const next = recallOpenSubChats();
      if (!next.delete(tabId)) next.add(tabId);
      rememberOpenSubChats(next);
      return next;
    });
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
    // No `claimOver` any more. It existed to leave the row's MIDDLE band free
    // for merge-into-this-tab, so reorder only claimed the edges. With merging
    // gone the whole row is a reorder target, which is also what it looks like.
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

  /**
   * The event is OPTIONAL because three surfaces archive and only one of them
   * has a click to stop: the desktop ×, the long-press menu, and the sheet's
   * swipe tray. The menu used to hand in a hand-made `{stopPropagation(){}}`
   * cast to a MouseEvent to satisfy the signature, which is a note saying the
   * signature was wrong.
   */
  const archiveTab = async (e: React.MouseEvent | undefined, tab: Tab) => {
    e?.stopPropagation();
    e?.preventDefault();
    await actions.archive(tab);
  };

  /** One chat's row. `parent` is set for the chats spawned under it: it is what
   *  switches the row's mark from a tile to a dot in its parent's chip column,
   *  and what puts the one indent step on the row. Nothing about a clock — a
   *  sub-chat has none, and the row reads its own. */
  const renderRow = (
    t: Tab,
    parent?: Tab,
    group?: SubsGroup,
    childLast?: boolean,
    family?: boolean,
  ) => (
    <TabRow
      key={t.id}
      tab={t}
      // THE GROUP CONTROL, on the row rather than under it. See SubsPill.
      {...(group ? { group } : {})}
      // WHICH CHILD ENDS THE RUN, from the only place that knows without
      // guessing. The trunk used to find it in CSS —
      // `[data-child]:has(+ [data-child])` — which is a claim about DOM
      // ADJACENCY, and on the sheet it is false: every row there is wrapped in
      // a `.swiperow`, so no two child rows are ever siblings. The rule never
      // matched, every child's trunk stopped at its own middle, and the group
      // drew N separate brackets instead of one line. It had been that way
      // since the trunk landed and was simply too faint to see until the ink
      // went up. React knows the index; CSS was being asked to infer it.
      {...(childLast ? { childLast: true } : {})}
      // The whole reason `renderGroup` knows the parent. Forwarding it was
      // missed, and because every OTHER prop here is spelled out explicitly
      // there was nothing to notice: `TabRow.parent` was simply `undefined` on
      // every row ever rendered, so `data-child` was never emitted, every child
      // drew a tile, and the child dot, the indent and the shared name x were
      // all dead in the product while their CSS and their grouping rule were
      // both correct. Pinned by NavTree.rows.test.tsx.
      {...(parent ? { parent } : {})}
      // THE FAMILY READS AS ONE BLOCK. Reported: "you stand on a chat that has
      // sub-chats, then the sub-chats don't get a semi-selected background".
      // They are the same piece of work and looked like strangers who happen
      // to be adjacent. Set in both directions — stand on a child and the
      // parent takes it too, so you can always see what a worker belongs to.
      {...(family ? { family: true } : {})}
      workspace={workspace}
      isActiveTab={isActiveWorkspace && t.slug === activeTabSlug}
      variant={variant}
      isEditing={editing?.kind === 'tab' && editing.id === t.id}
      setEditing={setEditing}
      onNavigate={onNavigate}
      onArchive={(e) => void archiveTab(e, t)}
      onDelete={() => void actions.remove(t)}
      onSetUnread={(want) => actions.setUnread(t, want)}
      onSetIcon={(icon) => void actions.setIcon(t, icon)}
      onSetPinned={(want) => void actions.setPinned(t, want)}
      onAddPane={() => void addPaneToTab(t)}
      // A CHILD is not draggable: its place in the list is its parent, not an
      // order you arranged, so there is nothing for a drop to mean.
      rowDnd={
        variant === 'sidebar' && !parent ? (t.pinned ? tabDnd(t.id) : moveOnlyDnd(t.id)) : undefined
      }
    />
  );
  /**
   * ─── SUB-CHATS ARE COLLAPSED, AND THE COLLAPSE CARRIES THEIR STATE ────────
   *
   * A fan-out is the normal shape of work here — this install has a chat with
   * 65 children — and every one of them was a row. The rail is a list of
   * CONVERSATIONS; a worker is a thing one of those conversations is doing,
   * and forty of them in the list is the list not working.
   *
   * Shut by default, and the chip under the parent says what is inside
   * ("6 · 2 running · 1 needs you"). Two things make that safe rather than a
   * hiding place:
   *
   *   · the parent's own mark wears the loudest state in the family while shut
   *     (`subsStatus`), so a blocked worker still reaches the glance; and
   *   · opening STICKS (`rail-folds`), so the chat you are actually sitting
   *     with is not re-collapsed by the next tab switch.
   *
   * The disclosure is drawn only where there is something to disclose. In the
   * done drawer's sub-chat section the children are ALREADY behind two
   * disclosures and the parent is a label, not a row — a third caret there
   * would be a caret on a caret, so `contextOnly` keeps the flat rendering.
   */
  const renderGroup = (g: ChatGroup) => {
    // OPEN WHEREVER YOU ARE. A shut group that contains the chat you are
    // looking at would leave the rail with no selected row anywhere — tap a
    // spawn card in the parent, or @-jump to a worker, and the sidebar shows
    // nothing highlighted. On the phone, where the sheet IS the navigation,
    // that is "where am I?" with no answer. Not persisted: it is a fact about
    // where you are, not a disclosure you opened, so leaving the chat
    // re-shuts the group.
    const holdsActive = isActiveWorkspace && g.children.some((k) => k.slug === activeTabSlug);
    // ── THE WHOLE FAMILY, IN BOTH DIRECTIONS ────────────────────────────────
    // `holdsActive` is only half of it: it asks whether a CHILD is the row you
    // are on. Standing on the PARENT puts you in the same family, and the
    // first pass of this missed it by asking each row about its own parent
    // instead of asking the group once — so a sibling of the active child
    // compared `signal archive` against the active slug, which is the child's,
    // and every row came back false. One question, asked of the group.
    const familyHoldsActive = holdsActive || (isActiveWorkspace && g.chat.slug === activeTabSlug);
    const open = openSubs.has(g.chat.id) || holdsActive;
    const foldable = !g.contextOnly && g.children.length > 0;
    return (
      <Fragment key={`${g.chat.id}${g.contextOnly ? ':subs' : ''}`}>
        {g.contextOnly ? (
          /* A LABEL, not a row. The parent may be live with a row of its own
             above, or done with one beside these — either way a second clickable
             copy of it here would be a chat appearing twice in one list, and the
             live one would go on lighting up as it worked. */
          <div className="navtree-done-parent" aria-hidden="true">
            {g.chat.name}
          </div>
        ) : (
          renderRow(
            g.chat,
            undefined,
            foldable
              ? {
                  ...subChatCounts(g.children),
                  open,
                  // OPEN OR SHUT. The pill is the one object on this row that
                  // is about the WORKERS, and a pill that goes quiet when you
                  // expand the group leaves the row saying only what the
                  // PARENT is doing — which is how a chat with two running
                  // sub-agents under it came to wear a green tick and nothing
                  // else. Reported from a screenshot: "there's a green
                  // checkmark but two sub-agents are working."
                  //
                  // The two facts are different and both are true: the tick is
                  // the parent's unread reply, the pill is the family's work.
                  // They get one object each and neither has to be silenced.
                  status: subsStatus(g.children),
                  title: subChatChipTitle(g.children),
                  parentName: g.chat.name,
                  onToggle: () => toggleSubs(g.chat.id),
                }
              : undefined,
            undefined,
            // The family holds the row you are standing on, and THIS IS NOT
            // THAT ROW. Without the second half the parent tinted itself while
            // you were standing on it, and the tint won against the selection
            // — the row you were in came out fainter than the ones beside it.
            // See the data-family note in NavTree.css.
            familyHoldsActive && g.chat.slug !== activeTabSlug,
          )
        )}
        {/* NO ROW OF ITS OWN ANY MORE. The disclosure, the count, the agent
            glyph and the breakdown used to sit on a line under the parent —
            four small things costing a whole row of a 240px rail, and a 40px
            band on the phone, for a group that was usually one or two
            children. "It feels like we're just wasting space now."
            They are one pill at the end of the PARENT's row now (SubsPill),
            which also lets the rollup state and the count stop being two
            drawings of one fact. */}
        {!foldable || open
          ? g.children.map((k, i) =>
              renderRow(
                k,
                g.chat,
                undefined,
                i === g.children.length - 1,
                familyHoldsActive && k.slug !== activeTabSlug,
              ),
            )
          : null}
      </Fragment>
    );
  };

  return (
    <div className="navtree-tab-list">
      {liveGroups.map((g, i) => (
        <Fragment key={g.chat.id}>
          {/* NOTHING BETWEEN THE BLOCKS. A seam here was drawn as a rule
              (flush, then inset, then a 40px stub), then as pure air, then as
              a `height: 0` div that rendered nothing — an element kept alive
              by edits each taking one more thing away from it. Then the mark
              went onto the NAME as a hue and lost to unread; then back here as
              a gap the renderer had to flag, because the row above the seam is
              usually a pinned chat's SUB-CHAT and no selector can see that it
              belongs to the block above.
              It is on the ROWS now, as an edge (--accent, 2px) that selection
              does not paint over and unread cannot overrule — which is what a
              seam could never do anyway: it said "something changes here" from
              between two blocks, legible only to someone who already knew the
              list was sorted. */}
          {renderGroup(g)}
        </Fragment>
      ))}
      {/* ─── The done group ────────────────────────────────────────────────
          Chats whose clock ran out. They LEFT the live list; they were not
          deleted, and nothing here deletes them — sending one a message
          restarts its clock and it walks straight back up into the list above.
          Shaped like the workspace header one step quieter: a section head,
          not a third kind of label, and no count badge (the number is the
          label). */}
      {doneGroups.length > 0 || subCount > 0 ? (
        <>
          <button
            type="button"
            className="navtree-done-head"
            onClick={() => setDoneOpen((o) => !o)}
            aria-expanded={doneOpen}
          >
            <SvgCaret open={doneOpen} />
            {doneCount} done
          </button>
          {doneOpen ? doneGroups.map((g) => renderGroup(g)) : null}
          {/* ─── AND THE AGENTS' WORK, one level further in ──────────────────
              Delivered sub-chats were IN the list above and filled it with
              machine-named work nobody recognised: on this install, 104 of them
              against 28 chats actually abandoned, so the thing the drawer is
              for was buried under the thing it is not. Reported as the archive
              filling with unfamiliar stuff.
              They are not deleted from it — that fixed the noise by removing
              the only place they could be found. They are one disclosure
              further in, and NEVER at the top: this sits below the chats you
              archived yourself, costs one line when shut, and is shut by
              default even when the drawer above it is open. Two clicks to a
              place you only go when you are looking for it. */}
          {doneOpen && subCount > 0 ? (
            <>
              <button
                type="button"
                className="navtree-done-head -subs"
                onClick={() => setSubsOpen((o) => !o)}
                aria-expanded={subsOpen}
              >
                <SvgCaret open={subsOpen} />
                {subCount} sub-agent{subCount === 1 ? '' : 's'}
              </button>
              {subsOpen ? subGroups.map((g) => renderGroup(g)) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

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
      noticeFromError(`Couldn't close the pane ${label}.`, err);
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
        // biome-ignore lint/a11y/useSemanticElements: <output> is for a form's computed result; this is a transient connectivity notice, which is what role="status" is for.
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
              data-state={p.status ?? 'idle'}
            >
              <button
                type="button"
                className="navtree-pane-row"
                data-active={active ? 'true' : undefined}
                data-unread={p.unread ? 'true' : undefined}
                onClick={() => openPane(p.id)}
              >
                <span className="navtree-pane-label">{label}</span>
              </button>
              {/* Per-pane state, in the same language as the tabs above. The
                  tab level only aggregates; a glance at the list should say
                  WHICH pane is running (or blocked).
                  OUTSIDE the button, exactly as the tab rows keep it outside
                  their link: the chip carries visually-hidden state text, and
                  inside the button that text joins the button's ACCESSIBLE
                  NAME — so a screen-reader user would hear the name change
                  ("claude · api refactor" → "…, Ready for you") every time the
                  agent started or stopped. As a sibling it is still read, just
                  not as part of the control's name. */}
              <StateChip status={p.status} />
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
  /** The chat that spawned this one, when it is a child. Supplies the clock
   *  they share, and switches the row's leading mark from tile to dot. */
  parent?: Tab | undefined;
  /** This row belongs to the same parent/child family as the active row. */
  family?: boolean | undefined;
  /**
   * This is the LAST child in its parent's run, so its trunk segment stops at
   * the elbow instead of carrying on into whatever follows.
   *
   * A prop rather than a CSS sibling test, because the sibling test was a
   * claim about DOM adjacency that the mobile sheet makes false — see
   * `renderRow`.
   */
  childLast?: boolean | undefined;
  /** This chat has sub-chats: the row carries their count, their rolled-up
   *  state and their disclosure, as one pill. See SubsPill. */
  group?: SubsGroup | undefined;
  /**
   * The state mark to draw INSTEAD of this tab's own.
   *
   * Set on a parent whose sub-chats are collapsed, where it carries the
   * loudest state among its children (see `subsStatus`). Absent everywhere else,
   * and absent means "draw your own" — an override that defaulted to the
   * rolled-up value would make every row's mark depend on a list the row
   * cannot see.
   */

  workspace: Workspace;
  isActiveTab: boolean;
  /**
   * The workspace's name, drawn as a quiet trailing label — set ONLY by the
   * flat 'recent' list, and there only on a row that leaves the workspace the
   * surface is naming or shares its name with another workspace's row in the
   * same list (`needsWorkspaceLabel`).
   *
   * Absent is the overwhelmingly common case and means "say nothing": in the
   * grouped view the workspace is a header above the row, and in the flat view
   * most rows are in the workspace you are already in and uniquely named. It is
   * a WIDTH decision as much as a noise one — on the sheet the label can take
   * up to 84px of a 336px name cell, which is affordable only while the rows
   * that do not need it are not charged for it.
   */
  workspaceLabel?: string | undefined;
  variant: NavTreeVariant;
  isEditing: boolean;
  setEditing: (e: Editing) => void;
  onNavigate?: (() => void) | undefined;
  /** Retire to the done group. The row's ×, and reversible. */
  onArchive: (e?: React.MouseEvent) => void;
  /** Permanent. Context menu only — never a one-click affordance on the row. */
  onDelete: () => void;
  /** Toggle the manual unread mark — true flags the dot, false clears it. */
  onSetUnread: (want: boolean) => void;
  /** Set this tab's leading icon (emoji). */
  onSetIcon: (icon: string) => void;
  /** Pin/unpin — hold this tab at the top of its workspace block in the
   *  manual order, instead of letting it be auto-sorted. */
  onSetPinned: (pinned: boolean) => void;
  onAddPane: () => void;
  /** A dragged TAB was dropped on this row's merge band — absorb its panes. */
  /** Create a pane in this tab and land on it (opens the harness picker). */
  /** A pane dragged from the strip was dropped here — move it into this tab.
   *  sourceTabId (from the drag mirror) feeds the follow-navigation hint. */
  rowDnd?: DragItemProps | undefined;
}

/** A top-level chat and the chats spawned under it, in the server's order. */
export interface ChatGroup {
  chat: Tab;
  children: Tab[];
  /** The parent is a LABEL here, not a row — see `doneSubs`. */
  contextOnly?: boolean;
  /**
   * This group is in the DONE list only to say whose retired sub-chats these
   * are. `chat` itself is live and has its own row up in the list above, so it
   * is drawn here as a quiet label rather than as a second, clickable copy of
   * a row that already exists.
   */
}

/**
 * The sidebar's two lists, and the parent→child nesting inside them.
 *
 * Pure, and exported for its test: this is the rule that decides what you can
 * SEE, so it is the one piece of this file that must not be checked by eye.
 *
 * Three things it settles:
 *
 *   1. A chat with a `spawned_by` that resolves IN THIS LIST is a child. It
 *      renders under its parent and never also as a top-level row.
 *   2. A `spawned_by` that does NOT resolve — the parent lives in another
 *      workspace, or was closed — makes the chat a TOP-level row rather than
 *      an orphan that vanishes. A chat is never invisible because of a dangling
 *      pointer.
 *   THE AGENT INSTRUCTIONS DESCRIBE THIS RULE IN PROSE. muxpad tells every
 *   agent, in server/src/agent-instructions.ts ("Delegating work"), where a
 *   sub-agent becomes visible to the user — because agents are asked "where
 *   did it go?" and answer from that document. It said "its own row" for weeks
 *   after this function stopped giving it one, and users went looking for a
 *   row, a card and a transcript that were not there. If you change what this
 *   returns, change that paragraph in the same commit.
 *
 *   3. A SUB-CHAT RETIRES ON ITS OWN, on delivery — it has no clock and it does
 *      not read its parent's. The moment its work finishes it leaves the live
 *      list, because its result has already come back to the parent as a card.
 *      This is what keeps a workspace that spawned forty agents from showing
 *      forty rows: they are gone as they report, and their cards remain.
 *
 *      And once retired it is not shown AT ALL: the done drawer holds
 *      top-level chats only. A live parent nests its still-working children
 *      under it up top and contributes nothing to the drawer; a done parent
 *      goes in alone. The forty that reported are reachable where you would
 *      look for them — the cards in the parent's conversation — and by `@`.
 *
 * Order is the server's throughout — pinned block first, then the auto-sorted
 * one. It used to also return `livePinned`, the index the pin divider was drawn
 * at; the divider is gone (a pinned chat's NAME carries the mark now) and the
 * count went with it rather than being left for a future caller to rediscover.
 *
 * It takes no `now`, and that is the point: nothing in here is time-dependent
 * any more. `done` is read off the row and `spawned_by` is a pointer, so this
 * function cannot disagree with the server about what has expired.
 */
export function groupChats(tabs: Tab[]): {
  live: ChatGroup[];
  done: ChatGroup[];
  /**
   * Delivered sub-chats, grouped under the chat that spawned them, for the
   * drawer's own second disclosure.
   *
   * SEPARATE FROM `done`, which is the whole point. They were in it, and the
   * drawer filled with machine-named work nobody recognised — 104 of them
   * against 28 chats actually abandoned, so the thing the drawer is FOR was
   * buried under the thing it is not. They were then dropped entirely, which
   * fixed the noise by removing the only place they could be found.
   *
   * This is the third answer: still in the drawer, never at the top of it, and
   * behind a disclosure of their own. Shut, they cost one line.
   */
  doneSubs: ChatGroup[];
} {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  /**
   * The TOP-LEVEL ancestor of a chat — walk `spawned_by` up until it runs out.
   *
   * It used to be one hop: a chat's group was keyed on its immediate parent, and
   * only the tops were ever read back out. So a GRANDCHILD — a chat spawned by a
   * chat that was itself spawned — went into `childrenOf[itsParent.id]`, which
   * no loop below ever reads, and it appeared in NEITHER list. Not mis-nested:
   * gone from the sidebar, and uncounted by the done header.
   *
   * That was survivable while the sheet rendered a flat list, because a
   * grandchild still reached the DOM as a top-level row. Turning grouping on for
   * both surfaces made it a disappearance on the phone — which is the device the
   * grouping was turned on for. A chain of handoffs is exactly a chain of
   * grandchildren, so this is the common case on this branch, not a corner.
   *
   * Resolving to the ROOT rather than rendering a second indent level is
   * deliberate: the design is ONE level — a child's mark sits in its parent's
   * mark column and every child name lands on one shared x, and neither survives
   * arbitrary depth. So the tree is FLATTENED to one level rather than truncated
   * at one level. Everything a chat spawned, however deep, is listed under it.
   *
   * Cycle-safe, and the degradation is chosen rather than incidental: an A→B→A
   * `spawned_by` loop has NO top in it, so returning the nearest ancestor would
   * make every member a child of another member and leave `tops` empty — the
   * whole cycle would vanish, which is the bug this function was just fixed for,
   * wearing a different hat. On a cycle the chat is its OWN root, so the members
   * come out as plain top-level rows. Unnested, but every one of them on screen.
   * This should be impossible; a function that decides whether a row renders at
   * all is not the place to find out that it wasn't.
   */
  const rootOf = (t: Tab): Tab => {
    let cur = t;
    const seen = new Set<string>([t.id]);
    for (;;) {
      const parentId = cur.spawned_by ?? null;
      if (parentId === null || parentId === cur.id) return cur;
      if (seen.has(parentId)) return t;
      const parent = byId.get(parentId);
      if (!parent) return cur; // a dangling `spawned_by` promotes — see below
      seen.add(parentId);
      cur = parent;
    }
  };
  const childrenOf = new Map<string, Tab[]>();
  const tops: Tab[] = [];
  for (const t of tabs) {
    // A chat whose `spawned_by` does not resolve in THIS list is a top-level row
    // (it is in another workspace, or gone) — a dot with no parent above it
    // belongs to nothing. `rootOf` returning the chat itself is that same rule.
    const root = rootOf(t);
    if (root.id === t.id) {
      tops.push(t);
      continue;
    }
    const siblings = childrenOf.get(root.id);
    if (siblings) siblings.push(t);
    else childrenOf.set(root.id, [t]);
  }
  const live: ChatGroup[] = [];
  const done: ChatGroup[] = [];
  const doneSubs: ChatGroup[] = [];
  for (const chat of tops) {
    const children = childrenOf.get(chat.id) ?? [];
    // Delivered children go to the drawer's sub-chat section WHATEVER their
    // parent is doing — it may be live above, or done beside them. The group
    // carries the parent only to name whose work this was; `contextOnly` marks
    // it as a label rather than a row, because the parent is not the thing
    // being listed here and may already have a real row elsewhere.
    const delivered = children.filter((k) => isChatRetired(k));
    if (delivered.length > 0) doneSubs.push({ chat, children: delivered, contextOnly: true });
    // THE DONE DRAWER HOLDS TOP-LEVEL CHATS ONLY. A sub-chat retires the moment
    // it delivers, so with forty spawned agents the drawer was forty rows of
    // finished errands under a label, and the chats you actually abandoned were
    // somewhere underneath them. Nothing is lost by dropping them: the result
    // already came back to the parent as a card in its conversation, which is
    // where you would look for it, and `@` still finds the chat by name.
    //
    // `contextOnly` groups are built above, for the drawer's own sub-chat
    // disclosure — not for this list. Nothing here lists a sub-chat.
    if (isChatDone(chat)) {
      done.push({ chat, children: [] });
      // …BUT A CHILD THAT IS STILL WORKING OUTLIVES IT, as a top-level row.
      // Dropping the whole family was right for the DELIVERED ones and wrong
      // for this case: a sub-chat that has not reported yet is live work, and
      // sending it down with its parent while also emptying the drawer left it
      // rendering NOWHERE — gone from the rail with a turn still running.
      //
      // This is rule 2 above arriving from a second direction. A chat whose
      // `spawned_by` does not resolve is promoted rather than orphaned, for the
      // stated reason that a chat is never invisible because of a pointer; a
      // parent that has retired out from under a running child is the same
      // situation with the pointer still intact.
      //
      // Position is safe: a pinned chat never decays, so a done parent is never
      // in the pinned block, and a row promoted at its place therefore always
      // lands after the pinned rows.
      for (const kid of children) if (!isChatRetired(kid)) live.push({ chat: kid, children: [] });
      continue;
    }
    live.push({ chat, children: children.filter((k) => !isChatRetired(k)) });
  }
  return { live, done, doneSubs };
}

/**
 * The same chip, with the noun the visible line cannot afford — the hover and
 * the accessible name. One function so the two can never disagree about the
 * counts, which is the only thing a reader is cross-checking between them.
 */
export function subChatChipTitle(children: readonly Tab[]): string {
  const { total, parts } = subChatCounts(children);
  const noun = `${total} sub-agent${total === 1 ? '' : 's'}`;
  return parts.length === 0 ? noun : `${noun} (${parts.join(' · ')})`;
}

/**
 * THE STATE A COLLAPSED GROUP SHOWS — the parent's own, or its loudest child's.
 *
 * Collapsing sub-chats hides rows that were carrying the rail's two most
 * consequential signals: a worker that is BLOCKED on a question, and a worker
 * that has finished and is waiting. Hiding those behind a caret would make the
 * collapse a regression rather than a tidy-up — the whole value of the rail is
 * that a glance down it is true.
 *
 * So a collapsed parent wears the loudest state in its family, its own
 * included. Precedence, loudest first:
 *
 *   blocked  somebody is waiting on a human. Nothing outranks it.
 *   working  a turn is running. ABOVE `ready` deliberately: "a still rail
 *            means nothing is running" is a property of the whole rail, and a
 *            collapsed group with a working child inside it must not be still.
 *   ready    finished, waiting for you.
 *   dead     findable, not shouting.
 *   idle     nothing, and no element — see RowMark.
 *
 * Expanded, the parent goes back to its OWN state and the children carry
 * theirs, because then they have rows to carry it on.
 */
const STATUS_RANK: Record<PaneStatus, number> = {
  blocked: 4,
  working: 3,
  ready: 2,
  dead: 1,
  idle: 0,
};

/**
 * THE LOUDEST STATE AMONG THE CHILDREN — and ONLY the children.
 *
 * It used to take the parent's own state too (`rollupStatus(own, children)`),
 * which was right while this fed the parent ROW's mark: that mark is about the
 * row, and a collapsed group had no other way to surface a blocked worker.
 *
 * The pill is not the row. It counts sub-chats, it names sub-chats in its
 * title, and it opens sub-chats — so a hue taken from the PARENT makes one
 * object say two things about two different subjects. Measured on the live
 * rail at 03:48, with one worker finished and this chat mid-turn:
 *
 *   data-state="working"   title="1 sub-chat (1 ready)"
 *
 * The dot said the parent was working, the words said the child was ready, and
 * a reader has no way to know which half is about what. The parent's own state
 * goes back to the row's own mark, where it has always belonged; this answers
 * only "what are the workers doing".
 */
export function subsStatus(children: readonly Tab[]): PaneStatus | undefined {
  let loudest: PaneStatus = 'idle';
  for (const k of children) {
    const s = k.status ?? 'idle';
    if (STATUS_RANK[s] > STATUS_RANK[loudest]) loudest = s;
  }
  return loudest === 'idle' ? undefined : loudest;
}

/**
 * WHAT THE COLLAPSED CHIP SAYS.
 *
 * A bare count ("6") is the thing a caret already implies and answers the
 * wrong question: nobody collapses six workers and then wonders how many there
 * were, they wonder whether any of them needs them. So the chip carries the
 * STATES, in the same words the rest of the product uses — "needs you" is the
 * mark's own title (MARK_TITLES.blocked), not a new vocabulary for the rail.
 *
 * Only non-zero states appear, loudest first, and a family where nothing is
 * happening says so in the shortest possible form: "6 sub-chats". The count
 * leads whenever there IS state to report, because then it is the denominator
 * of what follows — "6 · 2 running · 1 needs you" reads as a fraction of a
 * known whole, which "2 running · 1 needs you" does not.
 */
export function subChatCounts(children: readonly Tab[]): { total: number; parts: string[] } {
  const n = children.length;
  let working = 0;
  let blocked = 0;
  let ready = 0;
  let dead = 0;
  for (const k of children) {
    const s = k.status ?? 'idle';
    if (s === 'working') working++;
    else if (s === 'blocked') blocked++;
    else if (s === 'ready') ready++;
    else if (s === 'dead') dead++;
  }
  const parts: string[] = [];
  if (blocked > 0) parts.push(`${blocked} needs you`);
  if (working > 0) parts.push(`${working} running`);
  if (ready > 0) parts.push(`${ready} ready`);
  // Last, and counted: a worker whose runner exited is quiet, not absent, and
  // "6 sub-chats" over three dead ones is the shut group telling a lie by
  // omission. It is the rail's quietest state and it is the last word here.
  if (dead > 0) parts.push(`${dead} dead`);
  if (parts.length === 0) return { total: n, parts: [] };
  // ─── THE NUMBERS MUST ADD UP ─────────────────────────────────────────────
  // Reported, with a screenshot: "no working indicator but if only 6 are ready
  // then what are the other 3 doing?" — against a chip reading "9 · 6 ready".
  // Measured live at the time: 10 children, 1 running, 6 ready, three with no
  // word anywhere.
  //
  // Listing only the loud states left the reader doing subtraction and getting
  // no answer, which is worse than saying nothing: the total promises an
  // account of everyone and the segments deliver part of one. An idle worker
  // is a real and common state — it finished its turn and has not been
  // retired — and NOTHING is exactly what the reader wants to be told about
  // it. So the remainder is named rather than left to arithmetic, and the
  // segments now sum to the total by construction.
  const idle = n - blocked - working - ready - dead;
  if (idle > 0) parts.push(`${idle} idle`);
  // …AND SOMETHING HAS TO SAY WHAT THEY ARE. A bare `9` is a number with no
  // noun, on a row whose own name is somewhere above it.
  //
  // THE WORD DOES NOT FIT, and this was measured rather than guessed:
  // "11 sub-chats · 1 running · 7 ready · 3 idle" is 228px of text in the
  // 204px the rail gives this line, so the ellipsis eats the tail — which is
  // the `3 idle` that was just added to make the numbers add up. A label that
  // truncates exactly the part that closes the arithmetic is worse than the
  // bare number it replaced.
  //
  // So the noun is the AGENT GLYPH, in the markup (see renderGroup): the
  // product's existing mark for "an agent did this", worth ~16px against the
  // word's ~62px, and it sits where the eye already is. The full words are not
  // lost — they are the chip's `title` and its accessible name, which is where
  // a reader who is unsure will look and where a screen reader reads from.
  return { total: n, parts };
}

/**
 * THE TOTAL IS THE SUBJECT, NOT A FOURTH STATISTIC.
 *
 * "10 · 1 running · 6 ready · 3 idle" puts the total in the same series as the
 * things it is the sum of, with the same separator between them — so the eye
 * reads four statistics and has to work out that the first one is different in
 * kind. Reported exactly that way: "the 10 looks like it's another stat but
 * it's actually the total".
 *
 * Parentheses say "this is a breakdown of the number before it" with no
 * convention to learn, and cost ~10px of a line that measured 170px in 193px.
 * The renderer adds weight on top (see `.navtree-subs-total`); this function is
 * the one that decides the WORDS, and it is also what the hover title reads, so
 * the two cannot drift.
 */
export function subChatChip(children: readonly Tab[]): string {
  const { total, parts } = subChatCounts(children);
  if (parts.length === 0) return `${total} sub-agent${total === 1 ? '' : 's'}`;
  return `${total} (${parts.join(' · ')})`;
}

/**
 * How many CHATS the done group holds — the number in its header.
 *
 * One per group now that the drawer holds top-level chats only and every group
 * in it is childless. It is still a function rather than `.length` at the call
 * site because the invariant it encodes is the one that matters: the header's
 * number has to be what you will find when you open it.
 */
export function doneChatCount(groups: readonly ChatGroup[]): number {
  return groups.reduce((n, g) => n + g.children.length + (g.contextOnly ? 0 : 1), 0);
}

/** This row's own state, separate from the child-count pill. Idle renders
 * nothing; running is the only animated mark. Settled states have distinct
 * shapes (unread ✓, needs input !, stopped ×), so color is not the legend.
 * Keep this outside the chat link so status updates do not rename that link. */
function RowMark({ status, className }: { status: PaneStatus | undefined; className?: string }) {
  const s = status ?? 'idle';
  // A genuinely absent element, not an empty one: the grid's last track is
  // `auto`, so nothing here means no width and no gutter for the majority of
  // rows, and the name gets it instead.
  if (s === 'idle') return null;
  // `working` is aria-hidden for the same reason it is everywhere else: it
  // toggles at whatever rate the agent does, and announcing it churns.
  const announced = s !== 'working';
  return (
    <span
      className={`navtree-mark${className ? ` ${className}` : ''}`}
      data-state={s}
      title={MARK_TITLES[s]}
      {...(announced
        ? { role: 'img' as const, 'aria-label': MARK_TITLES[s] }
        : { 'aria-hidden': 'true' as const })}
    >
      {s === 'ready' ? '✓' : s === 'blocked' ? '!' : s === 'dead' ? '×' : null}
    </span>
  );
}

const MARK_TITLES: Record<Exclude<PaneStatus, 'idle'>, string> = {
  blocked: 'This chat needs your input',
  working: 'This chat is running',
  ready: 'Unread reply in this chat',
  dead: 'This chat’s agent stopped',
};

/**
 * "This chat runs on a schedule, and next at —." The nav row's META column.
 *
 * NOT a status. The state channel (StateChip) holds exactly one transient,
 * mutually-exclusive state, and it is scanned down the rows' left edge —
 * putting a standing PROPERTY of the chat in it would both break that scan and
 * lose to `working` the moment the cron actually fired, which is precisely
 * when you'd want to know a schedule exists. It gets its own column instead,
 * between the name and the state chip.
 *
 * It used to be a bare ⏱ beside the name, which said a schedule EXISTS but
 * never when — so the one thing you actually want from a rail glance ("does
 * anything run before I go out?") still cost a hover. The answer was a clock
 * plus a monospace time, in three shapes: `07:00`, `Sun 09:00`, `12 Sep`.
 *
 * It is now the clock plus a time TODAY ONLY, and the glyph alone otherwise —
 * see `railCronLabel`. The glance question is a question about today, and the
 * nine-character shape was a third of the rail's width on rows whose names were
 * already ellipsising. The tooltip carries every other case in full.
 *
 * The server folds `crons` + `next_cron` into the tab row (decorateTab), so
 * this costs no request — and no per-row query on the server either.
 */
function CronMark({ tab }: { tab: Tab }) {
  const next = tab.next_cron;
  const count = tab.crons ?? 0;
  const label = next ? railCronLabel(next.next_due_at) : null;
  // The tooltip is where the cases the row declines to spell out still live, so
  // it carries the FULL label as well as the absolute date — a row showing a
  // bare glyph has to be able to answer "when, then?" without opening the chat.
  const title = next
    ? `${next.name} · next ${nextCronLabel(next.next_due_at)} (${new Date(
        next.next_due_at,
      ).toLocaleString()})${count > 1 ? ` (+${count - 1} more)` : ''}`
    : `${count} scheduled job${count === 1 ? '' : 's'}`;
  return (
    <span className="navtree-cron" title={title} aria-label={title}>
      {/* Set BACK from the time (opacity + a 5px gap) so the eye lands on the
          digits, which are the information; the glyph only says what kind of
          number it is. */}
      <span className="navtree-cron-glyph" aria-hidden="true">
        ◷
      </span>
      {/* Wrapped, so the row can drop the TIME on hover and keep the GLYPH.
          The glyph is the part that says a schedule exists at all, and losing
          it while you point at the row meant the one row you were looking at
          was the one row that stopped saying so. It is 11px; the buttons have
          the space. Hovering the glyph itself still opens this span's title,
          which is where the full answer lives. */}
      {label ? <span className="navtree-cron-time">{label}</span> : null}
    </span>
  );
}

/**
 * PANES — a split, drawn. One box divided, which is what a pane layout is and
 * what the rail already shows when you open it. Deliberately NOT the agent
 * glyph the sub-chat pill wears: the two pills are the same object and the
 * glyph is the only thing saying which hierarchy you are about to open.
 */
function SvgPanesGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1.3"
        y="2.3"
        width="11.4"
        height="9.4"
        rx="1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M7 2.8v8.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * THE GROUP CONTROL, as the parent row receives it.
 *
 * `status` is present only while the group is SHUT: that is when the pill is
 * speaking for children you cannot see. Open, they draw their own marks and
 * the pill goes quiet — the same rule `rollupStatus` already had, moved from a
 * separate 10px mark onto the one object.
 */
export interface SubsGroup {
  total: number;
  /** The breakdown, already worded: `['2 running', '1 ready']`. */
  parts: string[];
  open: boolean;
  status?: PaneStatus | undefined;
  /** The full sentence, for the title and the accessible name. */
  title: string;
  parentName: string;
  onToggle: () => void;
}

/** Count hidden workers in plain language. No idle symbol or agent glyph:
 * closed groups say what their children are doing; open groups only count
 * them because each visible child already carries its own state. */
function SubsPill({ group }: { group: SubsGroup }) {
  const { total, parts, open, status, title, parentName, onToggle } = group;
  const hue = status ?? 'idle';
  const wording = (text: string) =>
    text.replace(/\bready\b/g, 'unread').replace(/\bdead\b/g, 'stopped');
  // ── THE LABEL IS THE COUNT, AND THE COUNT IS ALL ──────────────────────────
  //
  // It used to be a sentence: "1 running", "2 · 1 unread". Measured on a 272px
  // row that pill was 91px — a THIRD of the row — and the name it was crowding
  // got 55. Reported as "all these '1 running', '2 · 1 unread' statuses are
  // odd" and "chat names can get tiny".
  //
  // The sentence was answering a question nobody asks a sidebar. What you want
  // from a rail is "is there anything under here, and is any of it still
  // going" — which is a number and a colour, both of which this object already
  // had. The words were a third encoding of the same two facts.
  //
  // They are not lost: `title` and the accessible name still carry the whole
  // breakdown, which is where a sentence belongs. (Reviewed against Slack,
  // Linear, VS Code, Mail, GitHub, Discord and Notion — none of them spells a
  // state out on a list row; every one of them uses a count badge plus a
  // disclosure, with the words on hover.)
  const label = String(total);
  const description = wording(title);
  return (
    <button
      type="button"
      className="navtree-row-pill navtree-subs-pill"
      data-state={hue}
      data-open={open ? 'true' : undefined}
      onClick={(e) => {
        // The row behind it navigates. A disclosure that also opened the chat
        // would make the one control on this row do two things.
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      aria-expanded={open}
      title={description}
      aria-label={`${open ? 'Hide' : 'Show'} ${description} of ${parentName}`}
    >
      <span className="navtree-row-pill-n">{label}</span>
      <SvgCaret open={open} />
    </button>
  );
}

/** The row's one control: three dots, the universal "more actions". */
function SvgRowMenu() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <circle cx="3.2" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="12.8" cy="8" r="1.35" />
    </svg>
  );
}

function TabRow({
  tab,
  parent,
  family,
  childLast,
  group,
  workspace,
  isActiveTab,
  workspaceLabel,
  variant,
  isEditing,
  setEditing,
  onNavigate,
  rowDnd,
  onArchive,
  onDelete,
  onSetUnread,
  onSetIcon,
  onSetPinned,
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
  // COLLAPSED by default, always. The sheet used to auto-expand the active
  // multi-pane tab and to remember every toggle across reopens, so opening the
  // navigator could greet you with one chat's children instead of a list of
  // chats. The rail's job is the list; a pane list is a detour you ask for.
  const [panesOpen, setPanesOpen] = useState(false);
  // Which controls this row offers — one pure, unit-tested rule set rather
  // than variant checks scattered across the JSX (see lib/nav-row-affordances).
  const affords = tabRowAffordances({ variant, paneCount, isEditing });
  const sheet = variant === 'sheet';
  const togglePanes = () => setPanesOpen((o) => !o);

  // ─── A TAB ROW IS A DRAG SOURCE, AND NOTHING LANDS ON IT ─────────────────
  // It used to accept two drops: a PANE dragged off the tab strip (which became
  // a pane in this tab) and another TAB dropped on its middle band (which MERGED
  // the two chats, dissolving one). Both are gone.
  //
  // They were removable because they were unaskable-for. A merge is destructive
  // and irreversible from the sidebar — one of the two chats stops existing —
  // and it was armed by the middle third of a row that otherwise means reorder,
  // so the difference between "put this above that" and "destroy one of these"
  // was twenty pixels of vertical aim. Nothing on screen said which band you
  // were in until the drop had happened.
  //
  // What survives is the one drag with an obvious meaning and an obvious target:
  // a tab onto a WORKSPACE. See WorkspaceNode's group handlers.

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

  // No composition left to do: reorder is the only gesture a row takes part in.
  const dropDnd: Partial<DragItemProps> = tabRowDnd;

  /** The row's full action set. On TOUCH this menu (reached by a long press)
   *  is the only route to rename and to "New pane"; pin, mark-unread and close
   *  also live in the swipe tray. */
  const menuItems = (at: { x: number; y: number }): MenuItem[] => [
    tab.pinned
      ? { label: 'Unpin', onSelect: () => onSetPinned(false) }
      : { label: 'Pin to top', onSelect: () => onSetPinned(true) },
    tab.unread
      ? { label: 'Mark as read', onSelect: () => onSetUnread(false) }
      : { label: 'Mark as unread', onSelect: () => onSetUnread(true) },
    { label: 'Change icon…', onSelect: () => setPicker({ x: at.x, y: at.y }) },
    { label: 'Rename', onSelect: () => setEditing({ kind: 'tab', id: tab.id }) },
    // "New pane" only for a tab that takes panes (terminals, web views, an
    // empty tab). A chat's second pane was never a second chat — no parent, no
    // clock, no card — and on touch this menu is the only route to it, so
    // leaving it here would leave the whole affordance alive on mobile.
    // `takes_panes` is the SERVER's answer (decorateTab), because this row does
    // not know its own panes; absent — an older server — reads as "show it".
    ...(tab.takes_panes === false ? [] : [{ label: 'New pane', onSelect: () => onAddPane() }]),
    // "Move to workspace ▸" with the workspaces in a hover flyout, so the main
    // menu stays short. Omitted entirely when there's nowhere to move to.
    // (Dragging the tab onto a workspace row also works, on desktop.)
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
    // Archive is here TOO, not only on the ×: the menu is the one surface that
    // touch can reach (long press), and it is where a user goes looking for
    // "what can I do to this row". Not danger-styled — it undoes with a message.
    // onArchive expects a MouseEvent for stopPropagation; the menu has already
    // dismissed, so a lightweight stub is enough.
    {
      label: 'Archive',
      onSelect: () => onArchive({ stopPropagation() {}, preventDefault() {} } as React.MouseEvent),
    },
    // PERMANENT, and this menu is the only way to reach it. It used to be the
    // row's ×, one click from every row in the rail — which is exactly why the
    // rail never got tidied. Its own confirm lives in the handler.
    {
      label: 'Delete permanently…',
      danger: true,
      confirm: 'Click again — this cannot be undone',
      onSelect: () => onDelete(),
    },
  ];

  /** Clicking the leading cell opens the icon picker under it. Both surfaces'
   *  cells do this and it is the only thing either does. */
  const openPicker = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPicker({ x: r.left, y: r.bottom + 4 });
  };
  /** Don't let a fast double-click on the mark trip the row's
   *  rename-on-doubleclick. */
  const swallowDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  /**
   * The DESKTOP rail's leading cell — the chip, which is the clock.
   *
   * It keeps the one job the emoji cell it replaced had: clicking it opens the
   * icon picker. A span rather than a button so the row can still be dragged by
   * it, and mouse-only by design — the keyboard path is the context menu's
   * "Change icon…", exactly as before.
   *
   * For a CHILD row this same component draws a 6px dot instead of a tile, in a
   * box the width of the tile. That is what puts a child's mark in the very
   * same column its parent's chip occupies, and every child name in the tree on
   * one shared x — before this they were words floating at an arbitrary indent,
   * which is the thing the indent was hiding.
   */
  const chipCell = (
    <ChatChip
      density="row"
      chat={{ ...tab, icon: tab.icon ?? fallbackTabIcon(tab.id) }}
      // The shape is told, not inferred. A chat whose `spawned_by` dangles is
      // a TOP-level row in this list (see groupChats), and it must draw a tile
      // like one — a dot with no parent row above it belongs to nothing.
      shape={parent ? 'dot' : 'tile'}
      className="navtree-tab-chip"
      title="Change icon"
      onClick={openPicker}
      onDoubleClick={swallowDoubleClick}
    />
  );
  /**
   * The SHEET's leading cell — THE SAME CHIP, in this surface's own box.
   *
   * It was a bare emoji, and the two surfaces were one drawing apart: the sheet
   * deleted the desktop's plate on purpose (a plate on every row is a mark on
   * every row, which is the rule this rail is built on), so the phone drew the
   * glyph on the row's own ground while the rail drew it in a tile. A2 deletes
   * that tile on the desktop too — a `tile` now IS a glyph on the row's own
   * ground — so the difference the fork existed to protect is gone, and keeping
   * it would only mean the phone never gets the clock. It never had one: a
   * top-level chat one day from leaving the live list looked exactly like one
   * talked to a minute ago, on the one device this list is actually read on.
   *
   * The CELL is unchanged — same class, so the sheet's own geometry still owns
   * it: a fixed 20px box at 14px from the edge, lifted 1px optically, with no
   * plate behind it (NavTree.css). The chip is sized BY that cell rather than
   * bringing its 24px box along, which is what keeps every name on this list
   * starting at 42px. A CHILD still gets the 6px dot — a sub-chat has no clock,
   * and nothing here changes that.
   */
  const sheetLeadCell = parent ? (
    <ChatChip density="row" chat={tab} shape="dot" className="navtree-rail-dot" title={tab.name} />
  ) : (
    <ChatChip
      density="row"
      // No stored icon yet — a stable, per-tab stand-in rather than one shared
      // default, so a list of not-yet-labelled rows is still scannable by shape.
      // Derived from the id, never persisted.
      chat={{ ...tab, icon: tab.icon ?? fallbackTabIcon(tab.id) }}
      shape="tile"
      className="navtree-tab-icon"
      title="Change icon"
      onClick={openPicker}
      onDoubleClick={swallowDoubleClick}
    />
  );
  /** Name · headline · where the clock stands. The one-line row's whole
   *  second line, moved to where it costs nothing until you ask for it.
   *  Read off the tab's OWN row: the server already publishes a child's
   *  effective (parent's) clock there, so there is no parent to consult. */
  const rowTitle = chatTooltip(tab);
  const renameInput = (
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
  );
  const overlays = (
    <>
      {menu && (
        <NavContextMenu
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          items={menuItems(menu)}
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
    </>
  );

  // ─── The MOBILE row ────────────────────────────────────────────────────
  //
  // One flex line, 44px — exactly the touch floor, no more. Emoji, name, and
  // (only if there is something to say) a trailing mark. No headline, no
  // schedule, no state word, no pane count, no state bar, no tint, no
  // permanent per-row control: pin, mark-unread and close are one left swipe
  // away, and rename is a long press.
  //
  // ─── The bidi fix, which is the whole reason this row is a flex line ────
  // Every name carries dir="auto", and it must: that attribute is the only
  // thing that gets the glyph ORDER inside a Hebrew name right, and the only
  // thing that puts its ellipsis at the name's own logical end (the visual
  // LEFT) when it is too long for the row.
  //
  // But `dir` also sets the CSS `direction`, and `direction` is what
  // `text-align`'s initial `start` resolves against. Give that name a box with
  // SLACK in it — `flex: 1`, or a grid track — and a five-character Hebrew
  // name settles against the box's TRAILING edge, a quarter of a metre of
  // screen from the emoji it belongs to. Measured on the shipped sheet: the
  // first glyphs of sixteen names were spread over 280px of a 390px rail, so
  // there was no column for the eye to run down.
  //
  // The fix is NOT the obvious one, and that was established by measuring:
  // `unicode-bidi: plaintext` + `text-align: start` does NOT pin it in Chrome
  // (`start` resolves against the plaintext-derived direction, not the
  // `direction` property), and the two mechanisms that DO pin it both force
  // the box to `direction: ltr` — which fixes alignment and moves a long
  // Hebrew name's ellipsis to the wrong end.
  //
  // So: keep dir="auto", and take the box's ABILITY to misplace it away. The
  // name is `flex: 0 1 auto` (NavTree.css), so its box is the width of its own
  // text and there is no slack for alignment to spend; the trailing marks push
  // themselves to the row's end with `margin-inline-start: auto` on THEM. That
  // margin must never live on the name: `margin-inline-end: auto` on a name
  // whose dir="auto" resolved to rtl maps to margin-LEFT and re-creates the
  // original bug wearing a logical property.
  //
  // The name's box therefore stops at its text, which would leave most of the
  // row untappable — so the link is STRETCHED over the whole row by a
  // pseudo-element (NavTree.css), and the icon and the trailing controls are
  // lifted above it. The hit target is the row; the BOX is the text.
  const sheetRow = (
    <div
      className="navtree-tab-row"
      data-active={isActiveTab ? 'true' : undefined}
      // The sheet's half of the nesting. It was missing here while the desktop
      // row had it, so even once the grouping reached this surface a child
      // would have rendered as an ordinary line — indistinguishable from the
      // chat that spawned it, sitting directly beneath it.
      data-child={parent ? 'true' : undefined}
      data-family={family ? 'true' : undefined}
      // THE LAST ONE STOPS THE TRUNK. See renderRow for why this is an
      // attribute and not a CSS sibling test — on THIS surface the sibling
      // test could never have worked.
      data-child-last={childLast ? 'true' : undefined}
      // PINNED, the same way the desktop row says it — and missing here for
      // the same reason `data-child` above was: a mark gets designed on one
      // surface and the other is left behind. Reported as "mobile sidebar
      // render doesn't include many recent changes to desktop, for example I
      // don't see pinned chat indicators".
      //
      // It matters MORE here than on desktop, not less: the sidebar also says
      // pinned with a hover-revealed pin button, and the sheet deliberately
      // has no permanent per-row controls at all (nav-row-affordances.ts), so
      // without this nothing on a touch row says it. Position cannot: the pin
      // divider was deleted when the edge was introduced.
      data-pinned={tab.pinned ? 'true' : undefined}
      // No `data-state` here, and that is the design rather than an omission:
      // the left bar and the row tint in StateChip.css are keyed off it, and
      // the mobile rail has neither. Its state is one bit, drawn by the
      // trailing mark below and by the name's own weight.
      data-unread={tab.unread ? 'true' : undefined}
      data-pressing={pressing ? 'true' : undefined}
    >
      {/* THE PINNED MARK, same channel as the desktop row's: a 2px accent bar
          on the leading rim, which nothing else on this surface paints in. The
          sheet needs it MORE than the sidebar does — the sidebar also shows
          pinned through its hover-revealed pin button, and a touch row has no
          permanent controls at all by design. */}
      {tab.pinned && <span className="navtree-pin-edge" aria-hidden="true" />}
      {sheetLeadCell}
      {isEditing ? (
        renameInput
      ) : (
        <Link
          to="/w/$wsSlug/t/$tabSlug"
          params={{ wsSlug: workspace.slug, tabSlug: tab.slug }}
          className="navtree-tab-link"
          draggable={false}
          title={tab.name}
          {...pressHandlers}
          onClick={(e) => {
            // Long-press consumes the tap (opens the menu, not navigate).
            pressHandlers.onClick(e);
            if (e.defaultPrevented) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            onNavigate?.();
          }}
        >
          <span className="navtree-name-text" dir="auto">
            {tab.name}
          </span>
        </Link>
      )}
      {/* THE trailing group, and it renders only when it has something in it —
          an idle single-pane row has no element here at all. One wrapper
          rather than an auto margin per mark: two auto margins on one flex
          line share the free space between them and the marks drift apart. */}
      {!isEditing &&
      (workspaceLabel || affords.paneExpander || group || (tab.status && tab.status !== 'idle')) ? (
        <span className="navtree-rail-tail">
          {/* WHERE THIS ROW GOES, when it is not where you already are. It sits
              INSIDE the trailing group rather than after the name, which is
              what makes it safe on a 390px row: the group is pushed to the
              row's end by one auto margin, so the label eats into the name's
              box from the right and the name ellipsises to fit — instead of the
              label being pushed off the row by a long name. And it stays ahead
              of the state mark, so the mark keeps its column.
              `dir="auto"` like every other name on this surface; aria-hidden
              because the row's accessible name is the chat, and a workspace
              read out on every second row is noise a screen reader cannot
              skip. */}
          {workspaceLabel ? (
            <span className="navtree-rail-ws" dir="auto" aria-hidden="true">
              {workspaceLabel}
            </span>
          ) : null}
          {/* ─── THE SAME OBJECT, A DIFFERENT NOUN ────────────────────────
              This expands a chat into its own PANES; the pill beside it on
              another row expands a chat into its SUB-CHATS. Two hierarchies —
              panes inside a chat, chats under a chat — and they were both bare
              carets until the sub-chat one became a counted, state-coloured
              pill. That left this as the odd one out, which read as a bug:
              "the chat named Main has a caret which you click and you see
              three things under it but it's rendered differently, what's going
              on?"
              Same shape and same grammar now, so the rail has one kind of
              disclosure; a different GLYPH and no state hue, because it is a
              different thing and panes have no rollup to report. The count is
              the gain: how many are under there, before you tap. */}
          {affords.paneExpander ? (
            <button
              type="button"
              className="navtree-row-pill navtree-pane-pill"
              data-open={panesOpen ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                togglePanes();
              }}
              aria-expanded={panesOpen}
              aria-label={
                panesOpen
                  ? `Hide ${paneCount} panes of ${tab.name}`
                  : `Show ${paneCount} panes of ${tab.name}`
              }
              title={`${paneCount} panes`}
            >
              <span className="navtree-row-pill-glyph" aria-hidden="true">
                <SvgPanesGlyph />
              </span>
              <span className="navtree-row-pill-n">{paneCount}</span>
              <SvgCaret open={panesOpen} />
            </button>
          ) : null}
          {/* The same plain-language child count on desktop and mobile. */}
          {group ? <SubsPill group={group} /> : null}
          {/* Outside the link, as everywhere else: its visually-hidden state
              text would otherwise join the link's ACCESSIBLE NAME and rename
              the control every time an agent started or stopped.
              ALWAYS DRAWN — see the desktop row for why suppressing it beside
              a pill made one object speak for two subjects. */}
          <RowMark status={tab.status} className="navtree-rail-mark" />
        </span>
      ) : null}
      {overlays}
    </div>
  );

  if (sheet) {
    return (
      <>
        {/* The swipe shell wraps every row: pin, mark-unread and archive live
            UNDER it, and they are the sheet's only per-row actions. Not while
            EDITING — a rename input you can swipe out from under is a way to
            lose what you typed.

            IT ARCHIVES NOW, matching the desktop ×. It used to delete, which
            cost three deliberate acts to tidy one row: the swipe, an armed
            "Sure?" inside SwipeRow, and a window.confirm inside deleteTab. The
            label and the confirm were the reason not to repoint it before —
            a button saying Close that asks twice and then does something
            reversible would be worse than a truthful one — so they went with
            it. Delete is still reachable, from the long-press menu, where the
            rare and irreversible thing belongs. */}
        {isEditing ? (
          sheetRow
        ) : (
          <SwipeRow
            id={tab.id}
            label={`chat ${tab.name}`}
            pinned={tab.pinned === true}
            unread={tab.unread === true}
            onPin={() => onSetPinned(!tab.pinned)}
            onSetUnread={onSetUnread}
            onArchive={onArchive}
          >
            {sheetRow}
          </SwipeRow>
        )}
        {panesOpen ? (
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

  // ─── The DESKTOP row ───────────────────────────────────────────────────
  const row = (
    <div
      className="navtree-tab-row"
      data-active={isActiveTab ? 'true' : undefined}
      // NO `data-state`, and its absence is the mechanism rather than an
      // oversight: the 3px left bar and the row tint in StateChip.css are both
      // keyed off that attribute, so not writing it is what removes them. Both
      // went deliberately — see RowMark. The row's state is now told exactly
      // once, by the 10px mark at its right edge.
      data-child={parent ? 'true' : undefined}
      data-family={family ? 'true' : undefined}
      data-child-last={childLast ? 'true' : undefined}
      // Pinned is a 2px accent EDGE on the row's leading rim — see NavTree.css.
      // Off the ink entirely, because the name's colour already says
      // read-vs-unread: a hue there was a second meaning on one channel, and it
      // lost, so a pinned row going unread dropped its mark exactly when it
      // became interesting.
      data-pinned={tab.pinned ? 'true' : undefined}
      data-unread={tab.unread ? 'true' : undefined}
      data-pressing={pressing ? 'true' : undefined}
      {...(!isEditing
        ? {
            onContextMenu: (e: React.MouseEvent) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            },
          }
        : {})}
      {...dropDnd}
    >
      {/* Leading mark — its OWN grid cell, not the first inline-flex child of
            the link. The row is a strict four-track grid
            (mark | name | meta | status), and the only way every status mark
            lands on one vertical line is if nothing in front of it is free to
            size itself. This cell is also the column a CHILD row's dot sits
            in, which is what gives the children one shared x. */}
      {chipCell}
      {isEditing ? (
        renameInput
      ) : (
        <Link
          to="/w/$wsSlug/t/$tabSlug"
          params={{ wsSlug: workspace.slug, tabSlug: tab.slug }}
          className="navtree-tab-link"
          // The row owns drag-to-reorder; don't let the anchor drag its URL.
          draggable={false}
          title={isActiveTab ? 'Double-click to rename' : rowTitle}
          onDoubleClick={
            isActiveTab
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
            onNavigate?.();
          }}
        >
          {/* Line one: the name, and the chip that qualifies it. */}
          <span className="navtree-tab-titleline">
            {/* dir="auto" on the TEXT, never on the row — see
                .navtree-name-text in NavTree.css for why alignment stays
                pinned left while direction follows the string.
                No `title` of its own any more: it would shadow the row's
                composed tooltip on exactly the part of the row you hover, and
                that tooltip already opens with the full name. */}
            <span className="navtree-name-text" dir="auto">
              {tab.name}
            </span>
          </span>
          {/* THE ROW IS ONE LINE — name only.
                The machine-written headline that used to sit here as line two
                is NOT deleted: it moved into the row's `title` (see `rowTitle`
                above) and it is shown in the `@` picker, which is where you are
                actually choosing between chats. On the rail it was a second
                line of dim text on every row that had one, and it made the list
                a paragraph to read rather than a column to scan — the rows
                changed height between one-line and two-line neighbours, so
                there was no rhythm to run an eye down. One line, one height,
                one glance; the sentence is a hover away. */}
        </Link>
      )}
      {/* ─── THE FUNNEL, AS A REAL ELEMENT ──────────────────────────────────
          The two concave fillets that flare the pane's surface into the active
          row. They lived in `::after` — and so does the tree elbow on a
          SUB-CHAT row, at higher specificity. An active sub-chat therefore got
          one box carrying half of each rule: the elbow's `left`/`top`/`width`
          over the fillet's `right`, `bottom: -18px` and radial gradients,
          which painted the blob hanging below and left of the row.
          Reported as "the active chat rounded indicator thing is bust".

          A row has two pseudo-elements and three decorations wanting them —
          `::before` is the state track and the child's trunk, `::after` is the
          elbow. The third one gets a node of its own rather than a fourth
          qualifier in a cascade that has already produced this bug twice (see
          the fillet comment in NavTree.css for the first). It renders only on
          the row you are in. */}
      {isActiveTab && variant === 'sidebar' && (
        <span className="navtree-tab-funnel" aria-hidden="true" />
      )}
      {/* THE PINNED EDGE, and it is a node for the SAME reason the funnel is:
          both pseudos of a tab row are spoken for — `::before` is StateChip's
          state track, `::after` is the sub-chat elbow — and styling either one
          from here has produced the same bug twice. Ownership, not geometry.
          It is a mark on the row's rim rather than an ink on its name because
          the name's colour already carries read-vs-unread; see NavTree.css. */}
      {tab.pinned && variant === 'sidebar' && (
        <span className="navtree-pin-edge" aria-hidden="true" />
      )}
      {/* ─── THE TRAILING RAIL — ONE CELL, ONE COLUMN ──────────────────────
          Everything a row says on its right, in one flex box, right-aligned,
          in a fixed order. It used to be TWO grid tracks — hover controls in
          one, the schedule in another — which meant the pin and the clock could
          not land on the same x no matter what: different tracks, different
          edges. Reported as horizontal "balagan", and it is exactly that: a pin
          at 550 and a clock at 597 down the same list.

          ORDER, left to right, never varies:
            workspace label · schedule · pin · archive
          Each is absent when it does not apply, and the box is right-aligned,
          so whatever a row does show ends flush against the state mark's track.
          Two rows showing different things still agree about where the rail
          begins on the right.

          WHY THE PIN AND THE ARCHIVE SIT TOGETHER NOW: they are both buttons on
          the same row, and the only thing that ever separated them was which
          grid track they happened to be in. What distinguishes them is not
          position but PERSISTENCE — a pin is a state you set and keeps its
          width always; an archive is a control you reach for and has none until
          you do. That rule is in the CSS, where it belongs, instead of being
          smuggled in as a layout fact.

          Touch renders no buttons: the sheet's pin, mark-unread and close live
          under the row, behind a left swipe. */}
      {!isEditing ? (
        <span className="navtree-tab-rail">
          {workspaceLabel ? (
            <span className="navtree-tab-ws" dir="auto" aria-hidden="true">
              {workspaceLabel}
            </span>
          ) : null}
          {/* THE SCHEDULE YIELDS. A chat with live workers has something more
              urgent to say than when its cron next fires, and both will not
              fit beside a name on a 240px row — measured, the name drops to
              55px and `Orbit Builder` truncates. The time is still on the
              row's own title. Only on a row that HAS sub-chats: a chat
              without them keeps its `◷ 09:00` exactly as before. */}
          {tab.crons && !group ? <CronMark tab={tab} /> : null}
          {/* ONE control, and it opens the menu that already had everything.
              See TabRowAffordances.menuButton for the measurement that
              collapsed the pin and the archive into it. Keyboard reaches it by
              tab — the rail reveals on :has(:focus-visible) — and touch never
              renders it, using long-press instead. */}
          {affords.menuButton ? (
            <button
              type="button"
              className="navtree-close navtree-rowmenu"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ x: r.right, y: r.bottom });
              }}
              title="Chat actions"
              aria-label={`Actions for ${tab.name}`}
              aria-haspopup="menu"
            >
              <SvgRowMenu />
            </button>
          ) : null}
          {group ? <SubsPill group={group} /> : null}
        </span>
      ) : null}
      {/* The state mark — the LAST track, so nothing in front of it can push
            it off the row's right edge. Rendered on the ACTIVE row too, and
            deliberately: agent panes work quietly for minutes on their chat
            face, and the one chat whose progress you are actually waiting on
            must not be the single row that goes dark.
            IT IS ALWAYS THIS ROW'S OWN STATE, and it is always drawn. It was
            suppressed while a shut group's pill was present, back when the
            pill carried `rollupStatus` — the parent's state folded together
            with its children's. That made one object speak for two subjects
            and produced a pill whose dot said `working` (the parent) beside a
            title saying `1 ready` (the child). The pill answers for the
            workers now; this answers for the chat, and the two no longer
            overlap. */}
      {!isEditing && <RowMark status={tab.status} />}
      {overlays}
    </div>
  );

  // Desktop renders the row bare and keeps its hover-revealed controls — a
  // mouse has hover, so there is nothing to fix there and a gesture would only
  // be in the way.
  return row;
}

/**
 * A × that ASKS, in place.
 *
 * Closing a workspace cascade-kills every tab and pane under it, so it cannot
 * be a single click on a 20px glyph that sits two pixels from "new chat". It
 * used to be guarded by `window.confirm`, which bought the guarantee on
 * desktop and NOTHING on the sheet — the dialog is a silent no-op in an
 * installed iOS PWA, so the surface driven by a thumb was the unguarded one.
 *
 * So the question lives in the button: one click arms it (red, and the
 * tooltip/label say what the next click does), the second click acts. It
 * disarms on a timer, on leaving the row, and on blur — a button left armed
 * behind you is the trap this is supposed to prevent.
 *
 * Same shape as the sheet's swipe tray, which has always armed its destructive
 * action rather than opening anything.
 */
function ArmedClose({
  title,
  armedTitle,
  label,
  armedLabel,
  onConfirm,
}: {
  title: string;
  armedTitle: string;
  label: string;
  armedLabel: string;
  onConfirm: (e: React.MouseEvent) => void;
}) {
  const { armed, press, disarm } = useArmed();
  return (
    <button
      type="button"
      className={`navtree-close${armed ? ' -armed' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (press()) onConfirm(e);
      }}
      onMouseLeave={disarm}
      onBlur={disarm}
      title={armed ? armedTitle : title}
      aria-label={armed ? armedLabel : label}
      aria-pressed={armed}
    >
      <SvgClose size={13} />
    </button>
  );
}

/**
 * Portal target for the row overlays.
 *
 * The menu and the icon picker are viewport-positioned (`position: fixed`),
 * and they are rendered as children of a nav ROW. On the sheet that row is
 * wrapped in a SwipeRow whose face always carries a `transform` — a
 * transformed element becomes the containing block for its fixed descendants,
 * and the swipe shell's `overflow: hidden` then clips them to one 46px row.
 * Measured: `fixed; inset: 0` resolved to the row's own box. Portalling to
 * <body> puts them back in the viewport's coordinate space, which is what
 * their arithmetic above already assumes.
 */
function Overlay({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

/** One row in a NavContextMenu. With `submenu`, the row opens a flyout of
 *  child rows on hover instead of acting on click. With `confirm`, the row
 *  ARMS on first click and acts on the second — see NavContextMenu. */
interface MenuItem {
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  /** The armed label — what the row says once it is one click from doing
   *  something irreversible. Replaces `window.confirm`, which took the whole
   *  window for a decision about a 20px row, could not be styled, and is a
   *  silent no-op in the iOS PWA (which is why the sheet's destructive rows
   *  had no confirmation AT ALL). State in the row that asked means the two
   *  surfaces can finally behave the same way. */
  confirm?: string;
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
  touch = false,
  alignEnd = false,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onDismiss: () => void;
  /** Thumb-sized rows (44px) — for a menu opened by a tap on the sheet. */
  touch?: boolean;
  /** `x` is the menu's RIGHT edge rather than its left: it opens from a
   *  button at the end of a row and must not run off the screen's edge. */
  alignEnd?: boolean;
}) {
  const [openSub, setOpenSub] = useState<string | null>(null);
  // At most one row is armed, and arming one disarms the other: two live
  // "click again" rows in a six-row menu is a trap, not a safeguard.
  const [armed, setArmed] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Backdrop mousedown already covers outside-click; the hook adds Escape
  // and keeps this menu on the ONE shared dismissal implementation.
  useDismissable(true, menuRef, onDismiss);
  // Clamp so the menu never spills past the viewport edge (approx size —
  // exact enough to keep all items reachable near the bottom/right).
  const MENU_W = 200;
  const MENU_H = 44 + items.length * (touch ? 44 : 34);
  const left = Math.max(4, Math.min(alignEnd ? x - MENU_W : x, window.innerWidth - MENU_W - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));
  // Flyout side: open to the left when the menu sits in the right half of the
  // viewport, so the submenu doesn't run off-screen.
  const flyoutLeft = left > window.innerWidth / 2;
  return (
    <Overlay>
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
          className={touch ? 'navtree-menu -touch' : 'navtree-menu'}
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
                className={`navtree-menu-item${it.danger ? ' -danger' : ''}${
                  armed === it.label ? ' -armed' : ''
                }`}
                role="menuitem"
                // The armed row is the menu's current question, so it says so
                // for a screen reader too — otherwise the second click is an
                // unannounced change of meaning.
                {...(it.confirm ? { 'aria-pressed': armed === it.label } : {})}
                onClick={() => {
                  // FIRST click on a confirming row arms it and keeps the menu
                  // open. Nothing has happened yet, and the row now says what
                  // the second click will do.
                  if (it.confirm && armed !== it.label) {
                    setArmed(it.label);
                    return;
                  }
                  onDismiss();
                  it.onSelect?.();
                }}
                // Moving to ANOTHER row disarms: a menu you have moved on in
                // is a menu you are no longer answering.
                onMouseEnter={() => {
                  if (armed && armed !== it.label) setArmed(null);
                }}
              >
                {armed === it.label ? (it.confirm ?? it.label) : it.label}
              </button>
            ),
          )}
        </div>
      </div>
    </Overlay>
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
    <Overlay>
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
    </Overlay>
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

/**
 * ARCHIVE — a box with a lid. Reported: "the archive icon can easily be clicked
 * thinking it's the pin."
 *
 * The previous glyph was an arrow going down into a tray, and the note here
 * argued against the box because "at 13px the lid and body collapse into two
 * stacked bars and it reads as a hamburger". That was true of THAT box: two
 * outlined bars of equal weight, at 13px. The fix is not to avoid the shape,
 * it is to draw it so the two parts cannot read as equals — a FILLED lid sitting
 * on an outlined body, with a handle notch in the middle. Filled-on-outline is
 * legible at this size in a way outline-on-outline is not.
 *
 * And the shape has to be maximally unlike a PIN, because that is the actual
 * complaint: the pin is a thin diagonal needle, so the archive is a wide
 * horizontal solid. Two marks that differ in weight, axis and silhouette do not
 * get confused for each other at a glance — which the old pair, both thin
 * strokes of the same colour two pixels apart, demonstrably did.
 */
function SvgArchive({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* The LID: solid, full width, unmistakably the heavy part. */}
      <rect x="1.75" y="2.75" width="12.5" height="3.25" rx="1" fill="currentColor" stroke="none" />
      {/* The BODY: outlined, narrower, clearly hanging under the lid. */}
      <path d="M3 6.75v5.5a1.25 1.25 0 0 0 1.25 1.25h7.5A1.25 1.25 0 0 0 13 12.25v-5.5" />
      {/* The HANDLE: the detail that stops the two edges reading as bars. */}
      <path d="M6.5 9.25h3" />
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

/* ─── The sheet bar's three glyphs ───────────────────────────────────────
   Same 1.8px lucide-ish geometry as the rest of the nav's icons, so the bar
   reads as one set rather than three borrowed marks. */

function SvgCaret({ open }: { open: boolean }) {
  return (
    <svg
      className="navtree-bar-caret"
      data-open={open ? 'true' : undefined}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SvgSearchGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

function SvgPlus({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** "More" — three dots on one line, at the sheet's 15px glyph size. Filled
 *  dots rather than a stroke, so they hold their weight next to the "+". */
function SvgMore() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.8" cy="8" r="1.3" />
    </svg>
  );
}
