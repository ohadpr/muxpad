/**
 * THE PHONE'S TWO LEVELS: the list of chats, and a chat.
 *
 * The list is a ROUTE (`/chats`), not a panel. It replaced MobileNavSwitcher,
 * a breadcrumb in the top bar that dropped the same NavTree down as component
 * state — which got two things wrong that only a route gets right:
 *
 *   1. THE OS BACK GESTURE. A panel in `useState` is invisible to history, so
 *      swipe-back / Android-back left the chat you were in instead of closing
 *      the list, and a refresh or a shared link could never land on the list.
 *   2. THE LIST'S OWN STATE. The panel unmounted on every close, so a scroll
 *      position in a 1,100-chat list was thrown away on every trip into a chat.
 *      The list is now mounted once and kept, hidden, while you are in a chat
 *      (see MobileChatList), exactly as AppLayout keeps the workspace hosts.
 *
 * The list is the ROOT: there is no back button on it, because there is
 * nowhere above it to go. Desktop never sees any of this — it has the rail.
 */
export const CHAT_LIST_PATH = '/chats';

export function isChatListPath(pathname: string): boolean {
  return pathname === CHAT_LIST_PATH || pathname === `${CHAT_LIST_PATH}/`;
}

/** Does this layout navigate by the full-screen list? Phones, and not an embed. */
export function usesChatList(view: { isMobile: boolean; embedded: boolean }): boolean {
  // An EMBED never does: inside somebody else's app the surrounding product is
  // the navigation (lib/embed), and `/` sending an embed to a list would send it
  // somewhere the embed cannot show.
  return view.isMobile && !view.embedded;
}

/**
 * Where `/` goes. Phone: the list. Desktop (and an embed): the first
 * workspace, and from there its last-visited chat — unchanged.
 */
export function rootLanding(view: {
  isMobile: boolean;
  embedded: boolean;
}): 'chat-list' | 'first-workspace' {
  return usesChatList(view) ? 'chat-list' : 'first-workspace';
}

/**
 * Does AppLayout render the app body — the one that keeps every visited
 * workspace MOUNTED AND HIDDEN — or hand the whole column to the route's
 * <Outlet/>?
 *
 * The answer that matters is the list: it has to render BESIDE the hosts, not
 * instead of them, or every return to a chat re-attaches its terminal and
 * re-fetches its transcript. Artifacts and Apps get the same treatment on a
 * phone, since they are reached from the list's foot and you come back.
 */
export function rendersAppBody(view: {
  wsSlug: string | null;
  shellRoute: boolean;
  sidebarMode: boolean;
  chatList: boolean;
  onChatList: boolean;
}): boolean {
  if (view.wsSlug) return true;
  if (view.shellRoute && (view.sidebarMode || view.chatList)) return true;
  return view.chatList && view.onChatList;
}

/**
 * WHERE THE LIST SITS IN HISTORY, so the header's back button can go BACK to
 * it rather than push a fresh copy.
 *
 * Pushing `/chats` from a chat would make the stack list → chat → list, and
 * then the OS back gesture on the ROOT would dive into a chat. So the header
 * walks history back to the list's own entry when there is one, and only
 * replaces the current entry when there is not (a deep link, a refresh, a
 * notification that opened a chat cold).
 *
 * `index` is the history entry index (`__TSR_index`). The recorded entry is
 * forgotten as soon as history is at or before it on another page: from there
 * the next push overwrites it, and walking back to it would land on a chat.
 */
export function trackListEntry(
  listIndex: number | null,
  pathname: string,
  index: number,
): number | null {
  if (isChatListPath(pathname)) return index;
  if (listIndex !== null && index <= listIndex) return null;
  return listIndex;
}

export function backToList(
  listIndex: number | null,
  index: number,
): { kind: 'go'; delta: number } | { kind: 'replace' } {
  if (listIndex !== null && listIndex < index) return { kind: 'go', delta: listIndex - index };
  return { kind: 'replace' };
}
