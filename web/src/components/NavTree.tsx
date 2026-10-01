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
import { createDragOrigin } from '../lib/drag-origin';
import { clearFollowTarget, setFollowTarget } from '../lib/follow-tab';
import { getLastPaneId, setLastPaneId } from '../lib/last-visited';
import { pushUndo } from '../lib/move-undo-store';
import { isExpanded, toggleExpanded, useNavExpansion } from '../lib/nav-expansion';
import { tabRowAffordances } from '../lib/nav-row-affordances';
import { nextCronLabel, railCronLabel } from '../lib/next-cron-label';

import { reorderByDrop } from '../lib/reorder';
import { orderAfterPinnedDrop } from '../lib/tab-drag';
import { useFrozenTabOrder } from '../lib/tab-freeze';
import { tabRowActions } from '../lib/tab-row-actions';
import { useAllChats } from '../lib/use-all-chats';
import { useDismissable } from '../lib/use-dismissable';
import { applyTabOrder, insertTabRow, refreshTabs, useTabs } from '../tabs';
import { useLongPress } from '../use-long-press';
import { MAX_QUICK_SWITCH_TABS, useTabQuickSwitch } from '../use-tab-quickswitch';
import {
  applyWorkspaceOrder,
  refreshWorkspaces,
  useWorkspaces,
  visibleWorkspaces,
} from '../workspaces';
import { ChatChip, chatTooltip, isChatDone, isChatRetired } from './ChatChip';
import { NavSearch } from './NavSearch';
import { NewTabButton } from './NewTabButton';
import { StateChip } from './StateChip';
import { SwipeRow } from './SwipeRow';
import { SvgClose } from './icons';
import './NavTree.css';
// The flat 'recent' view's own rules. A separate sheet for the same reason
// NavSearch.css is one: it is a distinct surface with its own budget (the
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
 *     double-click rename, Ctrl+1…9 quick-switch, drag-to-reorder.
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
      {/* The box owns `.navtree-scroll` (it swaps the tree for its results
          while it has a query), so it renders a fragment and the scroller
          stays a direct flex child of this nav. */}
      <NavSearch variant={variant} onNavigate={onNavigate}>
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
      </NavSearch>
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
 * workspace", Hosted, and closing a workspace); the magnifier REPLACES the bar
 * with the search field, so the resting rail is one bar and a column of chats,
 * never two bars.
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
  // The magnifier's state. Opening it hides the bar — the search field takes
  // the bar's place rather than stacking under it, so the rail is never two
  // rows of chrome deep.
  const [searching, setSearching] = useState(false);
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
      {/* THE bar. One row, three controls, and it is the only chrome above the
          list. Hidden entirely while searching, so the field can take its
          place instead of pushing the chats one row further down. */}
      {searching ? null : (
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
          <button
            type="button"
            className="navtree-bar-icon"
            onClick={() => setSearching(true)}
            aria-label="Search"
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
      )}
      {/* The box owns `.navtree-scroll`, so the scroller stays a direct flex
          child of this nav. `box` is what the magnifier toggles: with it false
          NavSearch renders no field at all and simply hosts the list. */}
      <NavSearch
        variant="sheet"
        box={searching}
        onDismissBox={() => setSearching(false)}
        onNavigate={onNavigate}
      >
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
      </NavSearch>
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
    // No window.confirm: it is unreliable in an iOS PWA in standalone mode
    // (silently a no-op), which is exactly where this row lives.
    try {
      await api.deleteWorkspace(w.id);
      await refreshWorkspaces();
    } catch (err) {
      console.error('deleteWorkspace failed', err);
      window.alert(`Failed to close workspace: ${String(err)}`);
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
      <button
        type="button"
        className="navtree-close"
        onClick={onClose}
        title="Close workspace"
        aria-label={`Close workspace ${workspace.name}`}
      >
        <SvgClose size={13} />
      </button>
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
        {!isEditing && (
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
            <button
              type="button"
              className="navtree-close"
              onClick={(e) => void closeWorkspace(e)}
              title="Close workspace"
              aria-label={`Close workspace ${workspace.name}`}
            >
              <SvgClose size={13} />
            </button>
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
  // auto-sorted by attention → recency), so the client only has to
  // find the seam. Deriving `pinnedCount` rather than re-sorting keeps one
  // authority for ordering and means a poll can never fight a local sort.
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
  const pinnedCount = grouped.livePinned;
  // COLLAPSED by default. A chat crossing into done should be something you
  // notice leaving the live list, not something that re-opens a drawer of
  // fourteen finished chats under it.
  const [doneOpen, setDoneOpen] = useState(false);

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
  // Numbered in the order they are DRAWN, and only the rows that are actually
  // drawn: the top-level live chats. A number that addressed a row folded away
  // inside the done group would be a badge you cannot see attached to a chat
  // you did not ask for.
  const quickEnabled = variant === 'sidebar' && isActiveWorkspace;
  const quickTargets = liveGroups.map((g) => g.chat);
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
    tabCount: quickEnabled ? (quickHeld.current ? quickIds.length : quickTargets.length) : 0,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `quickTargets` is deliberately NOT a dependency — re-snapshotting while the badges are up is the exact bug this prevents.
  useEffect(() => {
    setQuickIds(showQuickNumbers ? quickTargets.map((t) => t.id) : []);
  }, [showQuickNumbers]);
  /** The frozen badge number for a tab (1–9), or undefined if it has none. */
  const quickNumberFor = (id: string): number | undefined => {
    const i = quickIds.indexOf(id);
    return i >= 0 && i < MAX_QUICK_SWITCH_TABS ? i + 1 : undefined;
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
  const renderRow = (t: Tab, parent?: Tab) => (
    <TabRow
      key={t.id}
      tab={t}
      // The whole reason `renderGroup` knows the parent. Forwarding it was
      // missed, and because every OTHER prop here is spelled out explicitly
      // there was nothing to notice: `TabRow.parent` was simply `undefined` on
      // every row ever rendered, so `data-child` was never emitted, every child
      // drew a tile, and the child dot, the indent and the shared name x were
      // all dead in the product while their CSS and their grouping rule were
      // both correct. Pinned by NavTree.rows.test.tsx.
      {...(parent ? { parent } : {})}
      workspace={workspace}
      isActiveTab={isActiveWorkspace && t.slug === activeTabSlug}
      quickNumber={showQuickNumbers && quickEnabled ? quickNumberFor(t.id) : undefined}
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
  const renderGroup = (g: ChatGroup) => (
    <Fragment key={`${g.chat.id}${g.contextOnly ? ':retired' : ''}`}>
      {g.contextOnly ? (
        /* The parent is LIVE and has a row of its own above. This is a label
           saying whose sub-chats these were — not a link, not a chip, no state
           mark. Rendering a real row here would put two clickable copies of one
           chat in the list, one of which would go on lighting up as it worked. */
        <div className="navtree-done-parent" aria-hidden="true">
          {g.chat.name}
        </div>
      ) : (
        renderRow(g.chat)
      )}
      {g.children.map((k) => renderRow(k, g.chat))}
    </Fragment>
  );

  return (
    <div className="navtree-tab-list">
      {liveGroups.map((g, i) => (
        <Fragment key={g.chat.id}>
          {/* The seam between "you arranged these" and "these arrange
              themselves". Only drawn when BOTH blocks exist — a hairline
              above nothing (or below nothing) is noise, and a workspace
              with no pins should look exactly like it did before pinning
              existed. */}
          {/* Purely decorative: pinnedness is already announced per-row by
              the pin button's aria-pressed, so a semantic separator here
              would only add a second, redundant thing for a screen reader to
              stop on.
              SHEET: not drawn at all. Pinning there is ORDER — being at the
              top IS the signal — and a hairline is one more mark in a list
              whose whole point is that it has almost none. */}
          {!sheet && i === pinnedCount && pinnedCount > 0 ? (
            <div className="navtree-pin-divider" aria-hidden="true" />
          ) : null}
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
      {doneGroups.length > 0 ? (
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
          {doneOpen ? doneGroups.map(renderGroup) : null}
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
  /** 1–9 chip shown while Ctrl is held (sidebar quick-switch); else undefined. */
  quickNumber: number | undefined;
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
  /**
   * This group is in the DONE list only to say whose retired sub-chats these
   * are. `chat` itself is live and has its own row up in the list above, so it
   * is drawn here as a quiet label rather than as a second, clickable copy of
   * a row that already exists.
   */
  contextOnly?: boolean;
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
 *   3. A SUB-CHAT RETIRES ON ITS OWN, on delivery — it has no clock and it does
 *      not read its parent's. The moment its work finishes it leaves the live
 *      list, because its result has already come back to the parent as a card.
 *      This is what keeps a workspace that spawned forty agents from showing
 *      forty rows: they are gone as they report, and their cards remain.
 *
 *      So a live parent contributes to BOTH lists — its still-working children
 *      nested under it up top, its delivered ones down in the done group under
 *      a `contextOnly` label. A done parent takes its whole family with it;
 *      children of a chat that has itself left the live list have no business
 *      staying in it.
 *
 * Order is the server's throughout — pinned block first, then the auto-sorted
 * one. `livePinned` is the seam between them, recomputed over the live tops
 * only, so the pin divider cannot be stranded below a row that decayed away.
 *
 * It takes no `now`, and that is the point: nothing in here is time-dependent
 * any more. `done` is read off the row and `spawned_by` is a pointer, so this
 * function cannot disagree with the server about what has expired.
 */
export function groupChats(tabs: Tab[]): {
  live: ChatGroup[];
  done: ChatGroup[];
  livePinned: number;
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
  for (const chat of tops) {
    const children = childrenOf.get(chat.id) ?? [];
    if (isChatDone(chat)) {
      // The parent has left the live list; the whole family goes with it.
      done.push({ chat, children });
      continue;
    }
    const working = children.filter((k) => !isChatRetired(k));
    const delivered = children.filter((k) => isChatRetired(k));
    live.push({ chat, children: working });
    // Delivered sub-chats keep their parent's name over them so you can see
    // whose work they were — but the parent is drawn as a label, not as a
    // second copy of a row that is still live above.
    if (delivered.length > 0) done.push({ chat, children: delivered, contextOnly: true });
  }
  return { live, done, livePinned: live.filter((g) => g.chat.pinned).length };
}

/**
 * How many CHATS the done group holds — the number in its header.
 *
 * Groups would be the wrong unit in both directions at once: a `contextOnly`
 * group's parent is a label for a chat that is still live above (so counting it
 * over-counts), while its retired sub-chats are real done chats (so counting
 * the group as one under-counts). With forty delivered agents under one parent
 * the two errors compound into "1 done" over a drawer of forty.
 *
 * The header's number has to be what you will find when you open it.
 */
export function doneChatCount(groups: readonly ChatGroup[]): number {
  return groups.reduce((n, g) => n + g.children.length + (g.contextOnly ? 0 : 1), 0);
}

/**
 * THE state slot — one 10px mark, one place, every state.
 *
 * This replaces the rail's three-way encoding (a 3px bar on the row's left
 * edge, a faint tint across the whole row, and a worded chip on the right).
 * All three are gone from the chat rows, and they were removed deliberately
 * rather than lost: next to a chip that says how much life a chat has left by
 * quietly filling with colour, a tinted row and a mono `READY` badge were
 * shouting. Two channels competing for "look here" is one channel.
 *
 * What is left is the smallest thing that can still say it, in the slot at the
 * row's right edge that every row shares:
 *
 *   working  a 10px turning ring — still the rail's ONE moving thing, and
 *            still the whole basis of "a still rail means nothing is running"
 *   blocked  a 10px filled dot, red. It wants you NOW.
 *   ready    a 10px filled dot, green. Finished, waiting for you.
 *   dead     a 10px filled dot, grey — findable, but not shouting: a dead
 *            runner needs nothing until you decide it does
 *   idle     NOTHING, and no element at all, so the cell takes no width and
 *            declines its gutter. Most rows are this one.
 *
 * Only `working` and `idle` come from the prototype, whose toy data had no
 * `blocked` and no `dead`. Rendering those two as nothing would have deleted
 * the rail's most consequential signal, so they take the same mark in the same
 * slot, separated by hue — which is what the rule ("every state is the SAME
 * mark in the same place") actually asks for.
 *
 * Rendered OUTSIDE the row's link, like every other state mark in this tree:
 * a label inside a control joins that control's accessible name, and the name
 * would then change under the user every time an agent started or stopped.
 */
function RowMark({ status }: { status: PaneStatus | undefined }) {
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
      className="navtree-mark"
      data-state={s}
      title={MARK_TITLES[s]}
      {...(announced
        ? { role: 'img' as const, 'aria-label': MARK_TITLES[s] }
        : { 'aria-hidden': 'true' as const })}
    />
  );
}

const MARK_TITLES: Record<Exclude<PaneStatus, 'idle'>, string> = {
  blocked: 'Waiting on you',
  working: 'Working…',
  ready: 'Ready for you',
  dead: 'Agent exited',
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

function TabRow({
  tab,
  parent,
  workspace,
  isActiveTab,
  workspaceLabel,
  quickNumber,
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
    { label: 'Delete permanently…', danger: true, onSelect: () => onDelete() },
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
      // No `data-state` here, and that is the design rather than an omission:
      // the left bar and the row tint in StateChip.css are keyed off it, and
      // the mobile rail has neither. Its state is one bit, drawn by the
      // trailing mark below and by the name's own weight.
      data-unread={tab.unread ? 'true' : undefined}
      data-pressing={pressing ? 'true' : undefined}
    >
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
      (workspaceLabel || affords.paneExpander || (tab.status && tab.status !== 'idle')) ? (
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
          ) : null}
          {/* Outside the link, as everywhere else: its visually-hidden state
              text would otherwise join the link's ACCESSIBLE NAME and rename
              the control every time an agent started or stopped. */}
          <StateChip status={tab.status} mode="mark" className="navtree-rail-mark" />
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
            {quickNumber !== undefined && (
              <span className="navtree-quicknum" aria-hidden="true">
                {quickNumber}
              </span>
            )}
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
          {tab.crons ? <CronMark tab={tab} /> : null}
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
          {affords.closeButton ? (
            <button
              type="button"
              className="navtree-close navtree-archive"
              onClick={onArchive}
              title="Archive — moves to done, a message brings it back"
              aria-label={`Archive chat ${tab.name}`}
            >
              <SvgArchive size={13} />
            </button>
          ) : null}
        </span>
      ) : null}
      {/* The state mark — the LAST track, so nothing in front of it can push
            it off the row's right edge. Rendered on the ACTIVE row too, and
            deliberately: agent panes work quietly for minutes on their chat
            face, and the one chat whose progress you are actually waiting on
            must not be the single row that goes dark. */}
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
 * ARCHIVE — an arrow going down into a tray. The row's one-click action.
 *
 * Deliberately NOT a × and deliberately not the filing-box glyph (a lid over a
 * body): at 13px the box's lid and body collapse into two stacked bars and it
 * reads as a hamburger. The arrow carries the verb — something moves, and it
 * moves DOWN and out of the way, which is what the done group is.
 */
function SvgArchive({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* The stroke down, and the head. */}
      <path d="M8 2.5v6.5" />
      <path d="M5.25 6.5 8 9.25 10.75 6.5" />
      {/* The tray it lands in — open at the top, so the arrow goes INTO it. */}
      <path d="M3 11.25v1.25a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.25" />
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

function SvgSearchGlyph() {
  return (
    <svg
      width="19"
      height="19"
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

function SvgPlus() {
  return (
    <svg
      width="19"
      height="19"
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
