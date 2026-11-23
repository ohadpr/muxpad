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

// ─── The desktop: two strips ────────────────────────────────────────────────
//
// The rail used to answer two questions at once — WHICH WORKSPACE (collapsible
// sections) and WHICH CHAT (the rows inside them) — which is why it was long.
// It is two strips now: a narrow column of workspace icons on the far left,
// and the chat rail for the CURRENT workspace beside it, with Home | Unread |
// Activity at its top. These are the rules both strips read, pure.

/** The views at the top of the desktop chat rail. */
export type RailView = 'home' | 'unread' | 'activity';
export const RAIL_VIEWS: readonly RailView[] = ['home', 'unread', 'activity'];

/**
 * Which workspace is CURRENT — the one whose icon is marked and whose chats
 * the rail lists. The URL's, when it names one. On a destination that names
 * none (Artifacts, Apps, /activity) the one you came FROM: you opened a page,
 * you did not leave your work. A cold open straight to one falls back to the
 * first visible workspace. A slug that is not a visible workspace never wins —
 * the hidden apps container is plumbing, not a place.
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
 * The badge on each workspace icon: how many of its CONVERSATIONS have
 * something unread ({@link isUnreadChat} — no sub-chats). This is what keeps
 * the split honest: you can no longer see another workspace's chats in the
 * same scroll, so its icon has to say when one of them wants reading.
 * Counted from the cross-workspace corpus (lib/all-tabs), because a workspace
 * you are not in has no list mounted to count from.
 */
export function unreadByWorkspace(tabs: readonly SearchableTab[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tabs)
    if (isUnreadChat(t)) out.set(t.workspaceId, (out.get(t.workspaceId) ?? 0) + 1);
  return out;
}

/**
 * The rail's UNREAD view — a LIST of this workspace's unread chats, each with
 * its last message, not a filter laid over the tree.
 *
 * In the RAIL'S OWN ORDER (the corpus carries each workspace's rows in the
 * server's stored order): switching views hides rows, it never reorders them
 * (shared/tab-order). The phone's Unread tab sorts by recency; that list is a
 * screen you visit, this one sits beside your work.
 *
 * The chat you are ON stays while you are on it: opening an unread chat reads
 * it, and a row vanishing from under the click would punish using the list.
 * It leaves when you leave it.
 */
export function railUnreadRows(
  tabs: readonly SearchableTab[],
  workspaceId: string,
  activeTabId: string | null,
): SearchableTab[] {
  return tabs.filter(
    (t) => t.workspaceId === workspaceId && (isUnreadChat(t) || t.tabId === activeTabId),
  );
}

/** The rail's ACTIVITY view: {@link activityChats}, for this workspace. */
export function railActivityRows(
  tabs: readonly SearchableTab[],
  workspaceId: string,
): SearchableTab[] {
  return activityChats(tabs.filter((t) => t.workspaceId === workspaceId));
}

/**
 * A workspace's icon in the left strip. Workspaces have no icon of their own,
 * so this derives one that is STABLE (the same name always gives the same
 * mark) and legible at 32px: a name that starts with an emoji wears it; a
 * name of several words gets two initials ("Side projects" → "SP"); one word
 * gets its first letter. Nothing is invented per workspace.
 */
export function workspaceMark(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)][0]
    ?.segment;
  if (first && /\p{Extended_Pictographic}/u.test(first)) return first;
  const words = trimmed.split(/[\s_\-/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const initial = (w: string) => (w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toLocaleUpperCase();
  if (words.length >= 2) return initial(words[0] ?? '') + initial(words[1] ?? '');
  return initial(words[0] ?? trimmed) || '?';
}
