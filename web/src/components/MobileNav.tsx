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
import { CHAT_SECTIONS, type ChatSection, activityChats, unreadChats } from '../lib/chat-sections';
import { CHAT_LIST_PATH, backToList, trackListEntry } from '../lib/mobile-nav';
import { toSearchableTabs } from '../lib/nav-search';
import { useAllChats, useChatCorpus } from '../lib/use-all-chats';
import { useTabs } from '../tabs';
import { useDocumentTitle } from '../use-document-title';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { Brand } from './Brand';
import { PreviewList } from './ChatPreviewList';
import { ChatSearch } from './CommandPalette';
import { NavGlyph } from './NavGlyphs';
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

const SECTION_LABEL: Record<ChatSection, string> = {
  home: 'Home',
  unread: 'Unread',
  activity: 'Activity',
  search: 'Search',
};

/**
 * THE SWITCHER, FOR A CHAT RATHER THAN THE LIST.
 *
 * "Maintain the bottom ribbon bar in chat windows as well, not just in the
 * chat list." The bar lived inside MobileChatList, so stepping into a chat
 * took the app's whole navigation off the screen and the only way anywhere
 * was the back button — one destination, via a detour through the list.
 *
 * The section lives in sessionStorage (readSection/writeSection), which is
 * what makes this possible without lifting state: this bar records the
 * section and navigates to the list, and the list reads it on mount and opens
 * there. One source of truth, two renderers, no prop drilling through
 * AppLayout.
 *
 * The CURRENT section stays marked while you are in a chat — you came from
 * somewhere and that is where Back goes, which is how Slack behaves when you
 * open a conversation from a tab.
 */
export function MobileChatSectionBar() {
  const navigate = useNavigate();
  const corpus = useChatCorpus();
  const section = readSection();
  return (
    <SectionBar
      section={section}
      unread={unreadChats(corpus).length}
      onChat={true}
      onPick={(next) => {
        writeSection(next);
        void navigate({ to: CHAT_LIST_PATH });
      }}
    />
  );
}

/** The switcher. Bottom of the screen, icon over label, as Slack's is. */
function SectionBar({
  section,
  unread,
  onPick,
  onChat = false,
}: {
  section: ChatSection;
  unread: number;
  onPick: (s: ChatSection) => void;
  /** Rendered under a CHAT rather than under the list — see `.mcl-tabs.-onchat`.
   *  The bar's ground is mixed from the rail on the list and from the page
   *  here, because its labels inherit whichever ink surrounds it. */
  onChat?: boolean;
}) {
  return (
    <nav className={`mcl-tabs${onChat ? ' -onchat' : ''}`} aria-label="Sections">
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
      {/* ─── CARDS, AND WHY IT IS NOT A SECTION ──────────────────────────
          The four above switch which VIEW this list is showing; the URL does
          not change and `ChatSection` is their union. Cards is a PAGE at
          /cards, so putting it in that union would mean every switch over a
          section having to handle a value that is not one.
          It is a <Link> for the same reason the desktop rail's page entries
          are: a real href gives long-press "open in new tab" and the browser's
          own affordances, with no handler to write. Fifth tab on a 390px
          phone is ~78px a column, which is what Slack ships. */}
      <Link className="mcl-tab" to="/cards" activeProps={{ 'aria-current': 'page' }}>
        <span className="mcl-tab-icon">
          <NavGlyph name="cards" size={24} weight={2} className="mcl-tab-glyph" />
        </span>
        <span className="mcl-tab-label">Cards</span>
      </Link>
    </nav>
  );
}

/**
 * The bar's glyphs are the DESKTOP RIBBON'S drawings (NavGlyphs) — "copy the
 * ribbon icon design from the desktop app to the mobile app" — so Home, Unread
 * and Activity are the same glyphs in both places, and Search is drawn into
 * the same family. The bar keeps its own scale and arrangement.
 *
 * The current tab used to FILL its glyph. The ribbon's set is a line set and
 * has no filled forms (a filled pulse is a scribble, a filled tray loses its
 * slot), so the current tab says so in WEIGHT instead — a heavier stroke —
 * beside the label's ink and the colour it already had.
 */
function SectionIcon({ section, filled }: { section: ChatSection; filled: boolean }) {
  return <NavGlyph name={section} size={24} weight={filled ? 2.6 : 2} className="mcl-tab-glyph" />;
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
        {/* 20px, not 18: a bigger glyph is a bigger thing to aim AT, which
            is the half of "hard to tap" that the hit box cannot fix. */}
        <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
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
