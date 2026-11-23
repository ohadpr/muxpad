import { type SearchableTab, recentTabs } from './nav-search';

/**
 * THE PHONE LIST'S FOUR SECTIONS, switched from a bottom tab bar the way
 * Slack's mobile app switches Home · DMs · Activity (references on the
 * published mobile-nav page):
 *
 *   home      every workspace and its chats — the list as it always was.
 *   unread    only the chats with something you have not read.
 *   activity  the chats you have been in lately, each with its last message.
 *   search    the ⌘K search, inline.
 *
 * Which chats each section holds is decided HERE, purely, from the same corpus
 * ⌘K searches (lib/all-tabs, every visible workspace) — so a chat cannot be in
 * Unread on one surface and missing from it on another.
 */
export type ChatSection = 'home' | 'unread' | 'activity' | 'search';

export const CHAT_SECTIONS: readonly ChatSection[] = ['home', 'unread', 'activity', 'search'];

/** Activity is a screenful of recent chats, not an archive. */
export const ACTIVITY_LIMIT = 40;

/**
 * Is there something in this chat you have not read?
 *
 * `unread` on the wire is the server's composition (ptyd-cache decorateTab):
 * ANY pane unread — an agent finished a turn while you were not looking — OR
 * the chat was marked unread by hand. Both are "unread" in the sense this list
 * means: Slack's mark-unread puts a conversation back in its unread view too.
 *
 * NOT a sub-chat. A worker's finished turn reports into its parent's
 * conversation, which marks the PARENT unread; listing the worker too would be
 * the same news twice, and a worker is its parent's business, reached from the
 * parent's drawer. NOT excluded for being `done`: done means four days
 * untouched, and an unread chat is exactly the one you have not touched.
 */
export function isUnreadChat(t: SearchableTab): boolean {
  return t.unread === true && !t.spawnedBy;
}

/** Unread chats, most recently active first. */
export function unreadChats(tabs: readonly SearchableTab[]): SearchableTab[] {
  return tabs
    .filter(isUnreadChat)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || cmpId(a, b));
}

/**
 * The chats you have been in lately — `recentTabs`, the ⌘K recents ranking,
 * at a screenful. One definition of "recent" for both surfaces.
 *
 * It excludes sub-chats, and that is kept on purpose: this is "take me back to
 * what I was doing", a worker's result arrives in its parent, and a sub-chat's
 * `last_user_at` is stamped at creation — eight fresh workers would push every
 * conversation off the top. Done chats (four days untouched) are out for the
 * plain reason that they are not recent.
 */
export function activityChats(
  tabs: readonly SearchableTab[],
  limit = ACTIVITY_LIMIT,
): SearchableTab[] {
  return recentTabs(tabs, { limit }).map((m) => m.tab);
}

/** Every section a chat appears in. Home holds them all; Search finds them. */
export function sectionsOf(t: SearchableTab, tabs: readonly SearchableTab[]): ChatSection[] {
  const out: ChatSection[] = ['home'];
  if (isUnreadChat(t)) out.push('unread');
  if (activityChats(tabs).some((x) => x.tabId === t.tabId)) out.push('activity');
  out.push('search');
  return out;
}

/**
 * A row's time, compact: `now`, `12m`, `3h`, `Yesterday`, a weekday inside
 * the week, a date beyond it. Slack's list reads exactly this way; a full
 * timestamp on every row is a column of noise.
 */
export function shortAgo(ts: number | null | undefined, now: number): string {
  if (!ts) return '';
  const d = Math.max(0, now - ts);
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  const then = new Date(ts);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= midnight) return `${Math.floor(d / 3_600_000)}h`;
  if (ts >= midnight - 86_400_000) return 'Yesterday';
  if (ts >= midnight - 6 * 86_400_000)
    return then.toLocaleDateString(undefined, { weekday: 'short' });
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cmpId(a: SearchableTab, b: SearchableTab): number {
  return a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0;
}

// ─── The desktop rail's three views ─────────────────────────────────────────
//
// One rail, every workspace in it as a section (a strip of workspace icons
// beside a one-workspace rail was tried and reversed), with Home | Unread |
// Activity at its top. WHICH OF THEM ARE SCOPED TO WHAT, stated once:
//   home      the tree — every workspace, each section its own chats.
//   unread    GLOBAL: every visible workspace's unread conversations.
//   activity  GLOBAL: every visible workspace's recent conversations.
// The rows of the two lists name their workspace, so a global list never has
// to be read against a section header.

/** The views at the top of the desktop chat rail. */
export type RailView = 'home' | 'unread' | 'activity';
export const RAIL_VIEWS: readonly RailView[] = ['home', 'unread', 'activity'];

/**
 * Which workspace you are "in" on a page that names none (Artifacts, Apps,
 * /activity): the URL's when it names one, else the one you were last in,
 * else the first visible. A slug that is not a visible workspace never wins —
 * the hidden apps container is plumbing, not a place. (AppLayout uses it for
 * which section is open and which row is marked on those pages.)
 */
export function currentWorkspaceSlug(
  urlSlug: string | null,
  lastVisitedSlug: string | null,
  visible: readonly { slug: string }[],
): string | null {
  const ok = (s: string | null) => !!s && visible.some((w) => w.slug === s);
  if (ok(urlSlug)) return urlSlug;
  if (ok(lastVisitedSlug)) return lastVisitedSlug;
  return visible[0]?.slug ?? null;
}

/**
 * How many of each workspace's CONVERSATIONS are unread ({@link isUnreadChat}
 * — no sub-chats), from the cross-workspace corpus. A COLLAPSED section shows
 * its count on its header: its rows are out of sight, and the header's status
 * mark is a rollup that ranks `working` above `ready`, so it cannot say this.
 */
export function unreadByWorkspace(tabs: readonly SearchableTab[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tabs)
    if (isUnreadChat(t)) out.set(t.workspaceId, (out.get(t.workspaceId) ?? 0) + 1);
  return out;
}

/**
 * The rail's UNREAD view — a LIST, across every workspace, of the unread
 * conversations, each with its last message; not a filter laid over the tree.
 *
 * IN THE RAIL'S OWN ORDER: the corpus carries workspaces in your workspace
 * order and each workspace's rows in the server's stored order, so this is a
 * subsequence of the tree read top to bottom. Switching views hides rows, it
 * never reorders them (shared/tab-order). The phone's Unread tab sorts by
 * recency; that list is a screen you visit, this one sits beside your work.
 *
 * The chat you are ON stays while you are on it: opening an unread chat reads
 * it, and a row vanishing from under the click would punish using the list.
 * It leaves when you leave it.
 */
export function railUnreadRows(
  tabs: readonly SearchableTab[],
  activeTabId: string | null,
): SearchableTab[] {
  return tabs.filter((t) => isUnreadChat(t) || t.tabId === activeTabId);
}
