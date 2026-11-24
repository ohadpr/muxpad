import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useAppTheme } from '../lib/app-theme';
import { currentWorkspaceSlug } from '../lib/chat-sections';
import { isEmbedded, shellChrome } from '../lib/embed';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { isChatListPath, rendersAppBody, usesChatList } from '../lib/mobile-nav';
import { keepsShell } from '../lib/shell-routes';
import { SIDENAV_MIN_WIDTH, updateSettings, useSettings } from '../settings';
import { useMediaQuery } from '../use-media-query';
import { useWindowAttention } from '../use-window-attention';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { Brand } from './Brand';
import { CommandPalette } from './CommandPalette';
import { DestinationRail } from './DestinationRail';
import { MobileChatHeader, MobileChatList, useBackToList } from './MobileNav';
import { MoveUndoToast } from './MoveUndoToast';
import { NavTree, RailSearchButton } from './NavTree';
import { NoticeToast } from './NoticeToast';
import { SettingsMenu } from './SettingsMenu';
import { UpdateBanner } from './UpdateBanner';
import { WorkspaceShell } from './WorkspaceLayout';

const REPO_URL = 'https://github.com/ohadpr/muxpad';

/**
 * Persistent application chrome. Popout routes are mounted outside this layout.
 *
 * Desktop, inside a workspace: a persistent left NavTree sidebar is the only
 * navigator; it absorbs the top bar entirely (brand at its head, build +
 * settings at its foot). Mobile navigates in two levels instead (see
 * lib/mobile-nav): the full-screen list at `/chats` is the root, and a chat
 * is the second level, whose top bar is its header — back, state, name. The
 * workspace picker ('/') has no workspace to host a sidebar, so it keeps a
 * slim brand + build + settings top bar.
 */
export function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wsSlugMatch = pathname.match(/^\/w\/([^/]+)/);
  const wsSlug = wsSlugMatch?.[1] ?? null;
  const tabMatch = pathname.match(/^\/w\/[^/]+\/t\/([^/]+)/);
  const activeTabSlug = tabMatch?.[1] ? decodeURIComponent(tabMatch[1]) : null;
  const { workspaces } = useWorkspaces();
  // Favicon is driven by the cross-workspace rollup, not by the current
  // workspace's tab list, so a browser tab parked on Workspace A still
  // shows the bell when Workspace B has activity.
  //
  // VISIBLE workspaces only. The hidden apps container holds long-lived server
  // panes, and a server that writes a BEL byte (a build tool's "done" chime,
  // an ANSI-heavy log) would otherwise pin the alert favicon permanently —
  // with no surface in which to clear it, since clearing needs a tab the
  // navigator can reach. An alert you cannot dismiss is worse than no alert.
  useWindowAttention(visibleWorkspaces(workspaces));
  // A chat may carry its own theme (see lib/chat-theme): the whole window
  // follows the tab you are in, and falls back to the device's default for a
  // chat that has no opinion.
  // ONE THEME, FOR THE INSTALL. It arrives with `/api/boot` (before the
  // bundle has parsed, so the first paint is already right) and this keeps the
  // window in step with every other one afterwards. It takes no argument now:
  // it used to be the active chat's slug, because the chat you were standing
  // in owned the theme.
  useAppTheme();
  const activeWorkspace = wsSlug ? workspaces.find((w) => w.slug === wsSlug) : null;
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const settings = useSettings();
  // Desktop always uses the persistent left sidebar; mobile never can — and
  // an EMBED never does. Inside somebody else's app the surrounding product
  // is the navigation; a second sidebar in a 600px iframe would be muxpad's
  // whole cockpit competing with the app that framed it. See lib/embed.
  const embedded = isEmbedded();
  /**
   * A DESTINATION THAT BELONGS TO NO WORKSPACE BUT IS STILL INSIDE THE APP.
   *
   * Artifacts and Apps. `inWorkspace` below decides whether the top bar is
   * absorbed into the rail, and these want the same answer a chat gets: the
   * rail has the brand and the settings, so a second top bar would be a strip
   * of duplicated chrome above a page that already has a header.
   */
  const shellRoute = keepsShell(pathname);
  const chrome = shellChrome({ isMobile, inWorkspace: !!wsSlug || shellRoute, embedded });
  const sidebarMode = chrome.sidebar;
  const sidenavRef = useRef<HTMLDivElement>(null);
  const [visitedWsSlugs, setVisitedWsSlugs] = useState<Set<string>>(() => new Set());
  /**
   * WHICH WORKSPACE THE RAIL SHOULD LOOK LIKE on a destination route.
   *
   * The tree takes an active slug and uses it for two things — which group is
   * expanded, and which row wears "you are here". Standing on Artifacts you
   * are in NEITHER, and the honest rendering of that is the workspace you
   * came FROM with no row selected: you have opened a destination, not left
   * your work.
   *
   * Last visited, falling back to the first visible workspace for a cold open
   * straight to `/artifacts` (a bookmark, a published link's sibling tab).
   */
  // The workspace you were last IN — not the last one first visited, which is
  // what `[...visitedWsSlugs].at(-1)` was: a Set keeps first-insertion order,
  // so going back to an earlier workspace never moved it to the end. It feeds
  // the rail's "which group is open, which row is marked" on a destination
  // route, which should be the workspace you were actually just in.
  const [lastSeenWs, setLastSeenWs] = useState<string | null>(null);
  const currentWs = currentWorkspaceSlug(wsSlug, lastSeenWs, visibleWorkspaces(workspaces));
  const lastWsSlug = currentWs ?? '';
  useEffect(() => {
    if (wsSlug) setLastSeenWs(wsSlug);
  }, [wsSlug]);
  useEffect(() => {
    if (!wsSlug) return;
    setVisitedWsSlugs((prev) => {
      if (prev.has(wsSlug)) return prev;
      const next = new Set(prev);
      next.add(wsSlug);
      return next;
    });
  }, [wsSlug]);

  // Sidebar mode absorbs the whole top bar while inside a workspace:
  // brand moves to the sidebar's head, build + settings to its foot.
  // The bar still renders on the workspace picker ('/'), where there is
  // no sidebar to host them.

  // ── THE PHONE'S LIST ──────────────────────────────────────────────────
  // Mounted on its first visit and KEPT while you are in a chat, the same
  // treatment the workspace hosts get — see MobileNav. `chatList` is false on
  // desktop and in an embed, where `/chats` is not a destination at all (its
  // route bounces to `/`).
  const chatList = usesChatList({ isMobile, embedded });
  const onChatList = chatList && isChatListPath(pathname);
  // ONE row of chrome on the phone's list: its own bar (title, search,
  // settings) is the top bar there, so this one does not render at all.
  const showTopBar = chrome.topBar && !onChatList;
  const [listVisited, setListVisited] = useState(false);
  // The chat you came FROM, so the list marks where you were — the same honest
  // rendering the rail gives a destination route (see lastWsSlug).
  const [lastTabSlug, setLastTabSlug] = useState<string | null>(null);
  useEffect(() => {
    if (activeTabSlug) setLastTabSlug(activeTabSlug);
  }, [activeTabSlug]);
  useEffect(() => {
    if (onChatList) setListVisited(true);
  }, [onChatList]);
  // The second level is every mobile page that is not the root.
  const onRoot = onChatList || pathname === '/';
  const backToList = useBackToList();
  // The pages hidden while a destination that is not a workspace is showing.
  const hostsHidden = shellRoute || onChatList;

  return (
    <div className="app-layout" data-embed={embedded ? 'true' : undefined}>
      {/* Mounted once, above everything, and deliberately OUTSIDE the
          workspace/sidebar branches below: ⌘K has to work on the workspace
          picker and on mobile too, which is exactly where the rail's own
          search field is not on screen to be focused. */}
      <CommandPalette />
      {showTopBar && (
        <header className="ws-tabbar">
          {chatList && !onRoot ? (
            // THE SECOND LEVEL'S HEADER, in place of the brand: back to the
            // list, the chat's state, its name. Not a second row — a phone's
            // vertical space is the budget this bar exists to protect.
            <MobileChatHeader
              workspace={activeWorkspace ?? null}
              tabSlug={activeTabSlug}
              title={destinationTitle(pathname)}
              onBack={backToList}
            />
          ) : (
            // `/` on its way somewhere. (The list itself, the real root, has no
            // bar here at all — its own bar is the top bar; see showTopBar.)
            <Brand asLink={true} responsive={true} markOnly={!!activeWorkspace} />
          )}
          {/* Slot the active terminal's face switch paints into via portal —
              see TabView. Keeps it in the top bar so mobile spends no second
              row on chrome. Empty (display:none) for a chat, which has no
              control to put here. */}
          {activeWorkspace && isMobile && (
            <div className="mobile-pane-chrome" id="mobile-pane-chrome" />
          )}
          {(!chatList || onRoot) && !activeWorkspace && <span className="ws-tabbar-spacer" />}
          <a
            className="brand-text-side"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={`muxpad — build ${__MUXPAD_VERSION__}`}
          >
            muxpad <span className="brand-text-side-version">{__MUXPAD_VERSION__}</span>
          </a>
          <SettingsMenu />
        </header>
      )}
      {rendersAppBody({ wsSlug, shellRoute, sidebarMode, chatList, onChatList }) ? (
        <div className="app-body">
          {/* ── THE LEFT SIDE: ONE HEADER OVER TWO STRIPS ─────────────────────
              "muxpad top header should extend all the way to the left
              including the icon rail as well." So the brand row is the head
              of the WHOLE left side — the destination rail (Home, Unread,
              Activity, Artifacts, Apps) and the chat list beside it both start
              under it — rather than a label for the chat list's column with a
              cut-off corner beside it.

              The outer <aside> is `.sidenav`, the rail's token ISLAND (ink,
              surface, seam), so the header, the destination rail and the list
              all wear the rail's tokens from one rule. The chat list's own
              column (`.sidenav-list`) holds the WIDTH you drag: the resize
              grip measures and persists it, exactly as it did the old aside,
              so a saved sidebarWidth still means the chat list's width. */}
          {sidebarMode && (
            <aside className="sidenav sidenav-with-rail">
              <div className="sidenav-brand">
                {/* Search rides the brand row rather than owning one of its
                    own — see RailSearchButton. The spacer on the other side
                    keeps the wordmark optically centred — now over the whole
                    left side, so it reads as the app's, not one column's. */}
                <RailSearchButton />
                <Brand asLink={true} responsive={false} />
                <span className="sidenav-brand-spacer" aria-hidden="true" />
              </div>
              <div className="sidenav-body">
                <DestinationRail lastWsSlug={lastWsSlug} />
                <div
                  className="sidenav-list"
                  ref={sidenavRef}
                  style={{ flexBasis: `${settings.sidebarWidth}px` }}
                >
                  <NavTree
                    variant="sidebar"
                    activeWorkspaceSlug={wsSlug ?? lastWsSlug}
                    activeTabSlug={activeTabSlug}
                  />
                  <SidenavResizeHandle asideRef={sidenavRef} />
                  {/* ── NO FOOT ON THE LIST ────────────────────────────────
                      The build stamp, the theme picker and the gear used to
                      close this column with a `--chrome-h` bar. They are the
                      APP's controls, not any conversation's, and the list is
                      the one column that is entirely about conversations — so
                      they sit at the foot of the destination rail now, which
                      had the room and was already where the app's own places
                      are listed. The list gets the row of height back. */}
                </div>
              </div>
            </aside>
          )}
          {/* ── NO TAB BAR ────────────────────────────────────────────────
              There was a strip of the recently-active chats here, above the
              pane: a band moved out of the rail on the reasoning that a list
              which looks like the list under it and means something different
              reads as noise however carefully it is coloured.

              True about the band in the rail; not an argument for a second
              navigation surface. The rail already lists those chats, in
              groups, with their state — so the strip was a second place to
              click the same thing, and it cost a row of the pane's height to
              be it. "Rethink tab bar — remove it and bring back the recent
              chats section at the top of the sidebar."

              The band is back at the top of the rail (NavTree), inside the
              scroller, which is where the phone sheet has had it all along. */}
          <div className="workspace-column">
            {/* ── A DESTINATION RENDERS *BESIDE* THE KEPT-ALIVE WORKSPACES ──
                Not instead of them. The hosts below stay mounted and hidden
                exactly as they do when you switch workspace, so opening
                Artifacts and going back to your chat unmounts nothing — no
                re-fetch, no terminal re-attach, no scroll position lost.
                Replacing the column (which is what `{wsSlug ? … : <Outlet/>}`
                did) threw all of that away every time, which is a large part
                of why these two pages felt like leaving the app. */}
            {shellRoute && (
              <div className="workspace-host-slot">
                <Outlet />
              </div>
            )}
            {chatList && (listVisited || onChatList) && (
              <MobileChatList
                visible={onChatList}
                activeWorkspaceSlug={wsSlug ?? lastWsSlug}
                activeTabSlug={activeTabSlug ?? lastTabSlug}
              />
            )}
            <div className="workspace-hosts" hidden={hostsHidden} aria-hidden={hostsHidden}>
              {[...visitedWsSlugs].map((slug) => (
                <div
                  key={slug}
                  className="workspace-host-slot"
                  hidden={slug !== wsSlug}
                  aria-hidden={slug !== wsSlug}
                >
                  <WorkspaceShell wsSlug={slug} isActive={slug === wsSlug} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <Outlet />
      )}
      {/* Global, route-independent — a move-undo toast must outlive the
          navigation the move triggers (follow-the-pane / follow-the-tab). */}
      <MoveUndoToast />
      {/* Failure notices — same reason again, and one more: the action that
          failed (closing a workspace, deleting a chat) may have navigated
          away from the row it was about. This replaced window.alert. */}
      <NoticeToast />
      {/* Same reason, plus one of its own: an installed iOS PWA is the case
          this exists for, and the chrome's build label is display:none on
          mobile. See UpdateBanner / lib/update-check. */}
      <UpdateBanner />
    </div>
  );
}

/** The header's name for a phone destination that is not a chat. */
function destinationTitle(pathname: string): string {
  if (pathname.startsWith('/unread')) return 'Unread';
  if (pathname.startsWith('/cards')) return 'Cards';
  if (pathname.startsWith('/artifacts')) return 'Artifacts';
  if (pathname.startsWith('/activity')) return 'Activity';
  if (pathname.startsWith('/apps') || pathname.startsWith('/hosted')) return 'Apps';
  return '';
}

/**
 * Drag-to-resize grip on the sidebar's right edge. The ceiling is computed
 * from content, not fixed: you can't drag the rail wider than the longest
 * visible tab/workspace name needs to show in full, plus room for its
 * status/close icon. Dragging left narrows down to SIDENAV_MIN_WIDTH. The
 * final width persists via settings.
 */
function SidenavResizeHandle({ asideRef }: { asideRef: React.RefObject<HTMLElement> }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only a primary-button drag; let other buttons through.
    if (e.button !== 0) return;
    const aside = asideRef.current;
    if (!aside) return;
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const maxWidth = measureSidenavContentWidth(aside);
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('sidenav-resizing');

    const onMove = (ev: PointerEvent) => {
      const next = Math.round(
        Math.min(maxWidth, Math.max(SIDENAV_MIN_WIDTH, startWidth + (ev.clientX - startX))),
      );
      aside.style.flexBasis = `${next}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('sidenav-resizing');
      // Persist whatever width we landed on so it survives reloads.
      updateSettings({ sidebarWidth: Math.round(aside.getBoundingClientRect().width) });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const snapToFit = () => {
    // The widest the rail ever usefully gets — double-click or Home key.
    const aside = asideRef.current;
    if (!aside) return;
    const fit = measureSidenavContentWidth(aside);
    aside.style.flexBasis = `${fit}px`;
    updateSettings({ sidebarWidth: fit });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    if (!aside) return;
    if (e.key === 'Home') {
      e.preventDefault();
      snapToFit();
      return;
    }
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    const max = measureSidenavContentWidth(aside);
    const next = Math.round(
      Math.min(max, Math.max(SIDENAV_MIN_WIDTH, aside.getBoundingClientRect().width + step)),
    );
    aside.style.flexBasis = `${next}px`;
    updateSettings({ sidebarWidth: next });
  };

  return (
    <div
      className="sidenav-resize-handle"
      onPointerDown={onPointerDown}
      onDoubleClick={snapToFit}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabIndex={0}
    />
  );
}

/**
 * The width at which every currently-visible nav name shows in full, plus
 * room for its trailing notification/progress bubble — but NOT for the
 * hover-only close ×, which is allowed to overlap and ellipsize the name on
 * hover. Names truncate with ellipsis, but `scrollWidth` still reports their
 * full intrinsic text width, and a name's left offset within the rail is
 * fixed (icon + indent), so this is independent of the rail's current width.
 */
function measureSidenavContentWidth(aside: HTMLElement): number {
  const asideRect = aside.getBoundingClientRect();
  const asideLeft = asideRect.left;
  // Fixed chrome to the RIGHT of the name+chip in the RESTING (un-hovered)
  // state — the close × is deliberately NOT reserved, so the fit width stays
  // tight to the content. It is READ OFF THE DOM rather than written down: the
  // two terms are the row's own right inset (--nt-air, and it has already been
  // 4px and 12px) and everything outside the row (the scroll container's right
  // padding and the rail's border). Both were written here as literals, and the
  // first went stale the moment the rail's spacing scale moved: the row inset
  // went 4 → 12 and this said 4. Measured, the same tree fitted to 401px
  // instead of 404 — the whole 4px of breathing room spent and 1px of overdraft,
  // so whether the longest name ellipsises at its own fit width comes down to
  // sub-pixel text metrics. Reading it back off the DOM is the same arithmetic
  // with nothing left to go stale. (It is also the DRAG CEILING, so a short
  // measurement caps how wide the rail can be dragged, not just where
  // double-click lands.)
  // The state chip is added PER ROW below — only rows with something to say
  // pay for it.
  const probe = aside.querySelector<HTMLElement>('.navtree-tab-row, .navtree-ws-row');
  const rowInset = probe ? Number.parseFloat(getComputedStyle(probe).paddingRight) : 12;
  const outsideRow = probe ? asideRect.right - probe.getBoundingClientRect().right : 9;
  // …plus a hair of breathing room, so the fitted name is not flush against
  // the chip's own edge.
  const fixedTrailing = rowInset + outsideRow + 4;
  let max = SIDENAV_MIN_WIDTH;
  for (const el of aside.querySelectorAll<HTMLElement>('.navtree-name-text')) {
    const nameRect = el.getBoundingClientRect();
    const left = nameRect.left - asideLeft;
    // The state chip (and the workspace tab-count) trails the name, OUTSIDE the
    // link — so search the ROW, not just the link's own parent, or every
    // measurement comes up short and the auto-fit width clips the chip off the
    // right edge.
    //
    // Measuring by right-edge delta (rather than adding a constant) is now
    // load-bearing rather than merely convenient: the chip is no longer a fixed
    // column but a WORD, so the amount it trails by is per-row — 25px for the
    // working spinner, 60px for `FAILED`, 74px for `WORKING` under reduced
    // motion, 0 for an idle row (see StateChip.css). A constant could only ever
    // be right for one of them.
    const row = el.closest<HTMLElement>('.navtree-tab-row, .navtree-ws-row, .navtree-pane-row');
    const scope = row ?? el.parentElement;
    // Take the RIGHTMOST trailing element, not the first match. `querySelector`
    // returns document order, and a collapsed workspace row renders its
    // tab-count chip BEFORE the state chip — so a plain query stopped at the
    // chip and came up ~20px short on exactly the rows that have both, clipping
    // the rail off the auto-fit width.
    // `.navtree-status` is kept in the list on purpose: the nav rows moved to
    // `.navtree-state`, but the Hosted list still renders a StatusMark, and a
    // selector that silently matches nothing is exactly how this measurement
    // broke last time.
    const trailing = scope
      ? [
          ...scope.querySelectorAll<HTMLElement>(
            '.navtree-state, .navtree-status, .navtree-ws-count',
          ),
        ]
      : [];
    const statusExtra = trailing.reduce(
      (max, node) => Math.max(max, node.getBoundingClientRect().right - nameRect.right),
      0,
    );
    const needed = left + el.scrollWidth + statusExtra + fixedTrailing;
    if (needed > max) max = needed;
  }
  return Math.ceil(max);
}
