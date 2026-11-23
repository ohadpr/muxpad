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

// ─── The desktop rail's Unread FILTER ───────────────────────────────────────
//
// On the desktop the rail is the MAP — it is on screen while you work — so
// Unread is not a tab that replaces it but a filter on it: the same rows, in
// the same places, fewer of them. HIDING, NEVER REORDERING. The rail's order
// is manual and stable (shared/tab-order), and a row that moves under the
// cursor is the bug that file exists to end; every function below returns its
// input in its input's order, with rows taken out.

/** The rail holds wire rows, not corpus rows: the same rule as
 *  {@link isUnreadChat}, in the wire's spelling. */
export function isUnreadTab(t: {
  unread?: boolean | undefined;
  spawned_by?: string | null | undefined;
}): boolean {
  return t.unread === true && !t.spawned_by;
}

/**
 * Which rows of ONE workspace's list survive the filter, in their order.
 *
 * The row you are ON stays, unread or not. Opening a chat is reading it, so
 * without this the row would vanish from under the pointer the moment you
 * clicked it — the filter would punish using it. It leaves when you leave it,
 * which is the "reading takes it out" you would expect.
 */
export function unreadFilterRows<
  T extends { id: string; unread?: boolean | undefined; spawned_by?: string | null | undefined },
>(rows: readonly T[], activeTabId: string | null): T[] {
  return rows.filter((t) => t.id === activeTabId || isUnreadTab(t));
}

/** How many chats the rail's chip counts — every visible workspace's. */
export function unreadCount(tabs: readonly SearchableTab[]): number {
  return tabs.filter(isUnreadChat).length;
}

/**
 * Is the filter actually filtering? Only with something to show. When the last
 * unread chat is read the filter has nothing left, and an empty rail — or one
 * holding only the chat you are standing on — is worse than the map: so it
 * falls back to everything, and the chip reads as off.
 */
export function unreadFilterActive(wanted: boolean, count: number): boolean {
  return wanted && count > 0;
}

/**
 * Which workspaces the filtered rail shows: those holding an unread chat, plus
 * the one you are in (its row stays — see {@link unreadFilterRows}). Order is
 * the input's — the workspace order you arranged.
 */
export function unreadFilterWorkspaces<W extends { id: string; slug: string }>(
  workspaces: readonly W[],
  tabs: readonly SearchableTab[],
  activeWorkspaceSlug: string | null,
): W[] {
  const has = new Set(tabs.filter(isUnreadChat).map((t) => t.workspaceId));
  return workspaces.filter((w) => has.has(w.id) || w.slug === activeWorkspaceSlug);
}
