import type { PaneStatus, Workspace } from '@muxpad/shared';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { api } from '../api';
import {
  CHAT_SECTIONS,
  type ChatSection,
  activityChats,
  shortAgo,
  unreadChats,
} from '../lib/chat-sections';
import { CHAT_LIST_PATH, backToList, trackListEntry } from '../lib/mobile-nav';
import { type SearchableTab, toSearchableTabs } from '../lib/nav-search';
import { useAllChats } from '../lib/use-all-chats';
import { useTabs } from '../tabs';
import { useDocumentTitle } from '../use-document-title';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { Brand } from './Brand';
import { ChatSearch } from './CommandPalette';
import { NavContextMenu, NavTree, createHouseTab } from './NavTree';
import { SettingsMenu } from './SettingsMenu';
import { StatusMark } from './StatusMark';
import './MobileNav.css';

/**
 * THE LIST, on a phone: the root of the mobile layout. See lib/mobile-nav for
 * why it is a route and not a panel.
 *
 * ONE header row (muxpad, new chat, settings), the section's content, and a
 * BOTTOM tab bar — Home · Unread · Activity · Search — the way Slack's mobile
 * app switches Home · DMs · Mentions/Activity (the references are on the
 * published mobile-nav page). Bottom, not a row under the header: that is
 * where Slack puts it, where a thumb is, and it costs the list no row at the
 * top.
 *
 * MOUNTED ONCE AND KEPT. AppLayout renders this beside the workspace hosts and
 * only HIDES it while you are in a chat; each section is kept the same way
 * once visited, so switching tabs and going into a chat and back lose nothing
 * — not the expanded workspaces, not a typed search, not a scroll position.
 * The scroll needs one more step than "stay mounted": `hidden` is
 * `display: none`, and a scroller loses its offset when its box goes away, so
 * each section records its offset and gets it back (KeptScroll).
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
  const [section, setSection] = useState<ChatSection>(readSection);
  const [visited, setVisited] = useState<ReadonlySet<ChatSection>>(() => new Set([section]));
  const searchInput = useRef<HTMLInputElement>(null);
  const groups = useAllChats();
  const corpus = useMemo(
    () =>
      toSearchableTabs(
        groups.map((g) => ({
          id: g.workspace.id,
          slug: g.workspace.slug,
          name: g.workspace.name,
          tabs: g.tabs,
        })),
      ),
    [groups],
  );
  const unread = useMemo(() => unreadChats(corpus), [corpus]);
  const activity = useMemo(() => activityChats(corpus), [corpus]);

  const pick = (next: ChatSection) => {
    // flushSync for Search: iOS raises the keyboard only for a focus() made
    // inside the tap that asked for it — the palette's button does the same.
    flushSync(() => {
      setSection(next);
      setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
    });
    writeSection(next);
    if (next === 'search') searchInput.current?.focus();
  };

  const shown = (s: ChatSection) => visible && section === s;

  return (
    <div className="mobile-chat-list" hidden={!visible} aria-hidden={!visible}>
      {visible && <ListTitle />}
      <ListHeader />
      <div className="mcl-body">
        <KeptScroll visible={shown('home')} selector=".navtree-scroll" centerActive={true}>
          <NavTree
            variant="sheet"
            activeWorkspaceSlug={activeWorkspaceSlug}
            activeTabSlug={activeTabSlug}
            hideBar={true}
          />
        </KeptScroll>
        {visited.has('unread') && (
          <KeptScroll visible={shown('unread')} selector=".mcl-scroll">
            <PreviewList rows={unread} active={shown('unread')} empty={<CaughtUp />} />
          </KeptScroll>
        )}
        {visited.has('activity') && (
          <KeptScroll visible={shown('activity')} selector=".mcl-scroll">
            <PreviewList
              rows={activity}
              active={shown('activity')}
              empty={
                <div className="mcl-empty">
                  <p className="mcl-empty-title">Nothing recent</p>
                  <p className="mcl-empty-sub">Chats you open show up here.</p>
                </div>
              }
            />
          </KeptScroll>
        )}
        {visited.has('search') && (
          <KeptScroll visible={shown('search')} selector=".cmdk-results">
            <div className="mcl-search">
              <ChatSearch
                inputRef={searchInput}
                autoFocus={false}
                hint={false}
                cursor={false}
                onDone={() => {}}
                onEscape={() => searchInput.current?.blur()}
              />
            </div>
          </KeptScroll>
        )}
      </div>
      <SectionBar section={section} unread={unread.length} onPick={pick} />
    </div>
  );
}

const SECTION_KEY = 'muxpad.mobileSection.v1';

/** The tab you were on survives a reload of the PWA, not just a trip into a chat. */
function readSection(): ChatSection {
  try {
    const v = sessionStorage.getItem(SECTION_KEY);
    return (CHAT_SECTIONS as readonly string[]).includes(v ?? '') ? (v as ChatSection) : 'home';
  } catch {
    return 'home';
  }
}
function writeSection(s: ChatSection): void {
  try {
    sessionStorage.setItem(SECTION_KEY, s);
  } catch {
    // private mode etc. — the in-memory state still holds for this session
  }
}

/**
 * A section's box, kept mounted while hidden, that remembers where its
 * scroller was. Scroll does not bubble; capture does. Recorded only while
 * visible — the reset to 0 that `display: none` causes must not overwrite the
 * real offset — and put back on the way in, before paint.
 */
function KeptScroll({
  visible,
  selector,
  centerActive = false,
  children,
}: {
  visible: boolean;
  selector: string;
  /** Home's first showing starts on the chat you are in, not at the top. */
  centerActive?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const scroller = ref.current?.querySelector<HTMLElement>(selector);
    if (!scroller) return;
    if (saved.current !== null) {
      scroller.scrollTop = saved.current;
      return;
    }
    if (!centerActive) return;
    const here =
      scroller.querySelector('.navtree-tab-row[data-active="true"]') ??
      scroller.querySelector('[data-active="true"]');
    here?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }, [visible, selector, centerActive]);
  return (
    <div
      className="mcl-section"
      ref={ref}
      hidden={!visible}
      onScrollCapture={(e) => {
        const t = e.target as HTMLElement;
        if (visible && t.matches(selector)) saved.current = t.scrollTop;
      }}
    >
      {children}
    </div>
  );
}

/** The good case, and it reads like one: Slack's "You're all caught up". */
function CaughtUp() {
  return (
    <div className="mcl-empty">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12.5 20.5 L18 26 L28 15"
          stroke="currentColor"
          strokeWidth="2.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p className="mcl-empty-title">You’re all caught up</p>
      <p className="mcl-empty-sub">Nothing unread in any chat.</p>
    </div>
  );
}

/**
 * Unread and Activity: chats, each with THE LAST MESSAGE IT HAD — the line
 * Slack's DM list puts under every name, and the whole point of Activity.
 * Fetched for these rows only, only while the tab is showing, and again only
 * when one of them moves (the key is ids + last activity).
 */
function PreviewList({
  rows,
  active,
  empty,
}: {
  rows: SearchableTab[];
  active: boolean;
  empty: ReactNode;
}) {
  const [previews, setPreviews] = useState<Record<string, Preview | null>>({});
  const key = rows.map((r) => `${r.tabId}:${r.lastActivityAt ?? ''}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `key` — the ids and their activity — not on the array's identity, which changes every corpus publish.
  useEffect(() => {
    if (!active || rows.length === 0) return;
    let cancelled = false;
    api
      .tabPreviews(rows.map((r) => r.tabId))
      .then((r) => {
        if (!cancelled) setPreviews((p) => ({ ...p, ...r.previews }));
      })
      // An older server has no such route: the rows keep their headline.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, active]);
  return (
    <div className="mcl-scroll">
      {rows.length === 0
        ? empty
        : rows.map((t) => <ChatRow key={t.tabId} tab={t} preview={previews[t.tabId] ?? null} />)}
    </div>
  );
}

type Preview = { text: string; by: 'user' | 'assistant' };

/**
 * One chat in Unread or Activity: emoji, name, workspace and time on the first
 * line; the last message under it — "You: " when it was yours, as Slack writes
 * it — falling back to the chat's headline (its topic) until a preview lands.
 */
function ChatRow({ tab, preview }: { tab: SearchableTab; preview: Preview | null }) {
  const now = Date.now();
  const second = preview
    ? preview.by === 'user'
      ? `You: ${preview.text}`
      : preview.text
    : (tab.headline ?? '');
  const status = tab.status ?? 'idle';
  return (
    <Link
      to="/w/$wsSlug/t/$tabSlug"
      params={{ wsSlug: tab.workspaceSlug, tabSlug: tab.tabSlug }}
      className="mcl-row"
      data-unread={tab.unread ? 'true' : undefined}
    >
      <span className="mcl-row-emoji" aria-hidden="true">
        {tab.icon || '💬'}
      </span>
      <span className="mcl-row-main">
        <span className="mcl-row-top">
          <span className="mcl-row-name" dir="auto">
            {tab.tabName}
          </span>
          {(status === 'working' || status === 'blocked') && (
            <span className="mcl-row-status">
              <StatusMark status={status} />
            </span>
          )}
          <span className="mcl-row-meta">
            {tab.workspaceName} · {shortAgo(tab.lastActivityAt, now)}
          </span>
        </span>
        {second && (
          <span className="mcl-row-preview" dir="auto" data-fallback={preview ? undefined : 'true'}>
            {second}
          </span>
        )}
      </span>
    </Link>
  );
}

const SECTION_LABEL: Record<ChatSection, string> = {
  home: 'Home',
  unread: 'Unread',
  activity: 'Activity',
  search: 'Search',
};

/** The switcher. Bottom of the screen, icon over label, as Slack's is. */
function SectionBar({
  section,
  unread,
  onPick,
}: {
  section: ChatSection;
  unread: number;
  onPick: (s: ChatSection) => void;
}) {
  return (
    <nav className="mcl-tabs" aria-label="Sections">
      {CHAT_SECTIONS.map((s) => (
        <button
          key={s}
          type="button"
          className="mcl-tab"
          aria-current={s === section ? 'page' : undefined}
          onClick={() => onPick(s)}
        >
          <span className="mcl-tab-icon">
            <SectionIcon section={s} filled={s === section} />
            {s === 'unread' && unread > 0 && (
              <span className="mcl-tab-badge" aria-label={`${unread} unread`}>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </span>
          <span className="mcl-tab-label">{SECTION_LABEL[s]}</span>
        </button>
      ))}
    </nav>
  );
}

function SectionIcon({ section, filled }: { section: ChatSection; filled: boolean }) {
  const stroke = { stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' as const };
  const fill = filled ? 'currentColor' : 'none';
  switch (section) {
    case 'home':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z" fill={fill} {...stroke} />
        </svg>
      );
    case 'unread':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 6.5h16v10.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"
            fill={filled ? 'currentColor' : 'none'}
            {...stroke}
          />
          <path
            d="M4 7l8 6 8-6"
            fill="none"
            {...stroke}
            stroke={filled ? 'var(--bg-chrome)' : 'currentColor'}
          />
        </svg>
      );
    case 'activity':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"
            fill={fill}
            {...stroke}
          />
        </svg>
      );
    case 'search':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6" fill="none" {...stroke} strokeWidth={filled ? 2.6 : 1.8} />
          <path
            d="M15.5 15.5 20 20"
            stroke="currentColor"
            strokeWidth={filled ? 2.6 : 1.8}
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/**
 * THE LIST'S HEADER — ONE ROW, the way Slack heads its mobile list with the
 * workspace's mark and name and puts compose beside it. It says muxpad, and
 * carries the two things that belong to the app rather than to a chat: a new
 * chat, and settings. AppLayout renders no bar above it on the list, so this
 * IS the top bar — one row of chrome, as before.
 *
 * Search is not here: it is a tab of its own in the bar at the bottom.
 */
function ListHeader() {
  return (
    <header className="mcl-head">
      <Brand asLink={false} responsive={false} markOnly={true} />
      <span className="mcl-head-title">muxpad</span>
      <NewChatButton />
      <SettingsMenu />
    </header>
  );
}

/**
 * "+" — a new chat. It ASKS where when there is a choice: the list shows every
 * workspace, so a single button that silently picked one would be the guess
 * this navigator was redesigned to stop making (see SheetRail). With one
 * workspace there is nothing to ask.
 */
function NewChatButton() {
  const navigate = useNavigate();
  const { workspaces: all } = useWorkspaces();
  const workspaces = visibleWorkspaces(all);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async (w: Workspace) => {
    if (busy) return;
    setBusy(true);
    try {
      await createHouseTab(w, navigate);
    } catch (err) {
      console.error('createTab failed', err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="mcl-head-icon"
        aria-label="New chat"
        title="New chat"
        disabled={busy || workspaces.length === 0}
        onClick={(e) => {
          const only = workspaces.length === 1 ? workspaces[0] : undefined;
          if (only) {
            void create(only);
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.right, y: r.bottom + 4 });
        }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M10 4v12M4 10h12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
      {menuAt && (
        <NavContextMenu
          x={menuAt.x}
          y={menuAt.y}
          touch={true}
          alignEnd={true}
          onDismiss={() => setMenuAt(null)}
          items={workspaces.map((w) => ({
            label: `New chat in ${w.name}`,
            onSelect: () => void create(w),
          }))}
        />
      )}
    </>
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
