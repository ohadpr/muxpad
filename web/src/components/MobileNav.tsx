import type { PaneStatus, Workspace } from '@muxpad/shared';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { CHAT_LIST_PATH, backToList, trackListEntry } from '../lib/mobile-nav';
import { useTabs } from '../tabs';
import { useDocumentTitle } from '../use-document-title';
import { NavTree } from './NavTree';
import { StatusMark } from './StatusMark';
import './MobileNav.css';

/**
 * THE LIST, on a phone: every workspace and its chats, full screen. See
 * lib/mobile-nav for why it is a route and not a panel.
 *
 * MOUNTED ONCE AND KEPT. AppLayout renders this beside the workspace hosts and
 * only HIDES it while you are in a chat, so expanded workspaces, an opened done
 * drawer and the scroll position are all still there when you come back.
 *
 * The scroll position needs one more step than "stay mounted": `hidden` is
 * `display: none`, and a scroller loses its offset when its box goes away. So
 * the offset is recorded as it changes and put back on the way in.
 */
export function MobileChatList({
  visible,
  activeWorkspaceSlug,
  activeTabSlug,
}: {
  visible: boolean;
  activeWorkspaceSlug: string;
  activeTabSlug: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const savedTop = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!visible) return;
    const scroller = rootRef.current?.querySelector<HTMLElement>('.navtree-scroll');
    if (!scroller) return;
    if (savedTop.current !== null) {
      scroller.scrollTop = savedTop.current;
      return;
    }
    // First showing (a cold open, or back from a deep-linked chat): start where
    // you are, as the drop-down panel did, rather than at the top of the list.
    const here =
      scroller.querySelector('.navtree-tab-row[data-active="true"]') ??
      scroller.querySelector('[data-active="true"]');
    here?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [visible]);

  return (
    <div
      className="mobile-chat-list"
      ref={rootRef}
      hidden={!visible}
      aria-hidden={!visible}
      // Scroll does not bubble; capture does. Only while visible — the reset to
      // 0 that `display: none` causes must not overwrite the real offset.
      onScrollCapture={(e) => {
        const t = e.target as HTMLElement;
        if (visible && t.classList.contains('navtree-scroll')) savedTop.current = t.scrollTop;
      }}
    >
      {visible && <ListTitle />}
      {/* Room for the header area the list will grow (the way Slack puts
          things above its conversation list) goes HERE, above the tree. */}
      <NavTree
        variant="sheet"
        activeWorkspaceSlug={activeWorkspaceSlug}
        activeTabSlug={activeTabSlug}
      />
    </div>
  );
}

function ListTitle() {
  useDocumentTitle('Chats · muxpad');
  return null;
}

/**
 * The record of where the list sits in history, kept for the header's back
 * button. Called from AppLayout, which is mounted on every route, so it sees
 * every location — including the ones where no back button is on screen.
 */
export function useBackToList(): () => void {
  const router = useRouter();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const index = useRouterState({
    select: (s) => (s.location.state as { __TSR_index?: number }).__TSR_index ?? 0,
  });
  const listIndex = useRef<number | null>(null);
  useEffect(() => {
    listIndex.current = trackListEntry(listIndex.current, pathname, index);
  }, [pathname, index]);
  return useCallback(() => {
    const plan = backToList(listIndex.current, index);
    if (plan.kind === 'go') router.history.go(plan.delta);
    else void navigate({ to: CHAT_LIST_PATH, replace: true });
  }, [router, navigate, index]);
}

/**
 * The second level's header: back, the chat's state, its name. Lives IN the
 * top bar rather than as a row under it; the bar's other occupants (the
 * terminal face slot and settings) follow it.
 */
export function MobileChatHeader({
  workspace,
  tabSlug,
  title,
  onBack,
}: {
  workspace: Workspace | null;
  tabSlug: string | null;
  /** For a destination that is not a chat (Artifacts, Apps). */
  title: string;
  onBack: () => void;
}) {
  const { tabs } = useTabs(workspace?.id ?? '');
  const tab = tabSlug ? tabs.find((t) => t.slug === tabSlug) : undefined;
  // `attention` is the raw BEL bit an older server sends without `status`.
  const status: PaneStatus = tab
    ? tab.attention === true
      ? 'blocked'
      : (tab.status ?? 'idle')
    : 'idle';
  const name = tab?.name ?? (workspace ? '' : title);
  return (
    <div className="mobile-chat-head">
      <button
        type="button"
        className="mobile-chat-back"
        onClick={onBack}
        aria-label="Back to chats"
        title="Back to chats"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M11.5 3.5 L6 9 L11.5 14.5"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="mobile-chat-title">
        {status !== 'idle' && (
          <span className="mobile-chat-status">
            <StatusMark status={status} />
          </span>
        )}
        {/* `auto` on the NAME, not the row: a Hebrew name must read right to
            left without flipping the row and throwing it to the far edge. */}
        <span className="mobile-chat-name" dir="auto">
          {name}
        </span>
      </span>
    </div>
  );
}
