import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { SIDENAV_MIN_WIDTH, updateSettings, useSettings } from '../settings';
import { useMediaQuery } from '../use-media-query';
import { useWindowAttention } from '../use-window-attention';
import { useWorkspaces } from '../workspaces';
import { Brand } from './Brand';
import { MobileNavSwitcher } from './MobileNavSwitcher';
import { MoveUndoToast } from './MoveUndoToast';
import { NavTree } from './NavTree';
import { SettingsMenu } from './SettingsMenu';
import { WorkspaceShell } from './WorkspaceLayout';

const REPO_URL = 'https://github.com/ohadpr/muxpad';

/**
 * Persistent application chrome. Popout routes are mounted outside this layout.
 *
 * Desktop, inside a workspace: a persistent left NavTree sidebar is the only
 * navigator; it absorbs the top bar entirely (brand at its head, build +
 * settings at its foot). Mobile gets the MobileNavSwitcher breadcrumb +
 * drop-down panel in a top bar. The workspace picker ('/') has no workspace to
 * host a sidebar, so it keeps a slim brand + build + settings top bar.
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
  useWindowAttention(workspaces);
  const activeWorkspace = wsSlug ? workspaces.find((w) => w.slug === wsSlug) : null;
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const settings = useSettings();
  // Desktop always uses the persistent left sidebar; mobile never can.
  const sidebarMode = !isMobile;
  const sidenavRef = useRef<HTMLElement>(null);
  const [visitedWsSlugs, setVisitedWsSlugs] = useState<Set<string>>(() => new Set());
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
  const showTopBar = !(sidebarMode && wsSlug);

  return (
    <div className="app-layout">
      {showTopBar && (
        <header className="ws-tabbar">
          <Brand asLink={true} responsive={true} markOnly={!!activeWorkspace} />
          {activeWorkspace && isMobile && (
            // Single merged trigger on mobile: workspace + tab breadcrumb
            // opening the drop-down NavTree panel. The top bar only ever hosts
            // navigation on mobile now — desktop lives in the sidebar.
            <MobileNavSwitcher activeWorkspaceSlug={activeWorkspace.slug} />
          )}
          {/* Slot the active tab's pane-level controls (face switch + new pane)
              paint into via portal — see TabView. Keeps them in the top bar so
              mobile spends no second row on chrome; the nav sheet owns pane
              switch/close. Empty (display:none) until a pane fills it. */}
          {activeWorkspace && isMobile && (
            <div className="mobile-pane-chrome" id="mobile-pane-chrome" />
          )}
          {!activeWorkspace && <span className="ws-tabbar-spacer" />}
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
      {wsSlug ? (
        <div className="app-body">
          {sidebarMode && (
            <aside
              className="sidenav"
              ref={sidenavRef}
              style={{ flexBasis: `${settings.sidebarWidth}px` }}
            >
              <div className="sidenav-brand">
                <Brand asLink={true} responsive={false} />
              </div>
              <NavTree
                variant="sidebar"
                activeWorkspaceSlug={wsSlug}
                activeTabSlug={activeTabSlug}
              />
              <SidenavResizeHandle asideRef={sidenavRef} />
              <div className="sidenav-footer">
                <a
                  className="sidenav-build"
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`muxpad — build ${__MUXPAD_VERSION__}`}
                >
                  {__MUXPAD_VERSION__}
                </a>
                <SettingsMenu />
              </div>
            </aside>
          )}
          <div className="workspace-hosts">
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
      ) : (
        <Outlet />
      )}
      {/* Global, route-independent — a move-undo toast must outlive the
          navigation the move triggers (follow-the-pane / follow-the-tab). */}
      <MoveUndoToast />
    </div>
  );
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
  const asideLeft = aside.getBoundingClientRect().left;
  // Fixed chrome to the RIGHT of the name+bubble in the RESTING (un-hovered)
  // state — the close × is deliberately NOT reserved, so the fit width stays
  // tight to the content: the link's right gutter (6), the row's right
  // padding (4), the scroll container's right padding (8) and a hair of
  // breathing room (4). The status bubble is added PER ROW below — only rows
  // that actually carry a dot/spinner pay for it.
  const fixedTrailing = 6 + 4 + 8 + 4;
  let max = SIDENAV_MIN_WIDTH;
  for (const el of aside.querySelectorAll<HTMLElement>('.navtree-name-text')) {
    const nameRect = el.getBoundingClientRect();
    const left = nameRect.left - asideLeft;
    // A status dot/spinner (or the workspace tab-count) sits just after the
    // name, inside the same link. Its right edge minus the name's right edge
    // is exactly margin + glyph width — and that delta holds even when the
    // name is currently ellipsis-truncated, since the glyph trails the box.
    const status = el.parentElement?.querySelector<HTMLElement>(
      '.navtree-busy, .badge-dot, .navtree-ws-count',
    );
    const statusExtra = status
      ? Math.max(0, status.getBoundingClientRect().right - nameRect.right)
      : 0;
    const needed = left + el.scrollWidth + statusExtra + fixedTrailing;
    if (needed > max) max = needed;
  }
  return Math.ceil(max);
}
