import type { RailView } from './chat-sections';

/**
 * THE DESKTOP'S LEFT RAIL: five destinations, in the owner's order —
 * "i want the rail. on it have: Home / Unread / Activity / Artifacts / Apps."
 *
 * Two kinds, one strip:
 *   home · unread · activity   VIEWS of the chat list beside the rail
 *                              (lib/rail-view). Home is the tree, every
 *                              workspace a section; Unread and Activity are
 *                              lists that SPAN EVERY WORKSPACE, each row
 *                              naming its own.
 *   cards · artifacts · apps   PAGES (routes) that belong to no workspace,
 *                              rendered beside the kept-alive workspace hosts
 *                              (lib/shell-routes).
 * They share a strip because they are the things he navigates BY; the
 * workspaces are sections in the list, not entries here.
 *
 * SIX now, not the five he first named: Cards was added after the fact that
 * seven cards were living in seven different chats, each only visible from
 * inside the one that owned it — see pages/CardsView.
 */
export type Destination = 'home' | 'unread' | 'activity' | 'cards' | 'artifacts' | 'apps';

export const DESTINATIONS: readonly Destination[] = [
  'home',
  'unread',
  'activity',
  // CARDS SITS WITH THE PAGES, not with the views above it. A card is a thing
  // muxpad is holding for you, like an artifact or an app — and like them it
  // belongs to no workspace. It goes FIRST of the three because it is the one
  // that changes on its own: artifacts and apps are where you go to find
  // something you made, this is where you go to see what is true now.
  'cards',
  'artifacts',
  'apps',
];

export const DESTINATION_LABEL: Record<Destination, string> = {
  home: 'Home',
  unread: 'Unread',
  activity: 'Activity',
  cards: 'Cards',
  artifacts: 'Artifacts',
  apps: 'Apps',
};

/**
 * WHICH VIEW THE RAIL'S LIST SHOWS — the route first, then the stored choice.
 *
 * `/unread` and `/activity` are PAGES of the same rows the rail's views show,
 * and the rail marks their entry current while you stand on one
 * (`currentDestination`, from the path). The list beside it read only the
 * STORED view, so the two contradicted each other: standing on /unread with
 * the stored view at Home, the Unread entry was marked current and the list
 * next to it was the full Home tree of every chat. Reported as "clicking the
 * unread icon looks like it loads the activity view, because it's a full
 * list", and confirmed in the browser — 14 tree rows beside a page showing
 * one unread chat.
 *
 * Derived, not stored: leaving the page returns the list to whatever the
 * owner last chose, which is the behaviour a page visit should not overwrite.
 */
export function railViewFor(pathname: string, stored: RailView): RailView {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/unread') return 'unread';
  if (p === '/activity') return 'activity';
  return stored;
}

/**
 * Which entry is CURRENT. A page route wins — standing on Artifacts you are on
 * Artifacts, whatever the list beside it is showing. `/activity` (the page,
 * kept for deep links) is Activity. Anywhere else — a chat — it is the list's
 * view.
 */
export function currentDestination(pathname: string, view: RailView): Destination {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/unread') return 'unread';
  if (p === '/cards') return 'cards';
  if (p === '/artifacts') return 'artifacts';
  if (p === '/apps' || p.startsWith('/hosted')) return 'apps';
  if (p === '/activity') return 'activity';
  return view;
}

/**
 * What a click on an entry does. A page entry goes to its route. A view entry
 * sets the list's view — and, when you are on a PAGE (Artifacts, Apps,
 * /activity), also takes you back to your work, because the view is a view
 * OF the chat list and the chat it belongs beside is where you came from.
 * On a chat it navigates nowhere: switching views never moves you.
 */
export function destinationAction(
  dest: Destination,
  pathname: string,
): { view?: RailView; to?: '/cards' | '/artifacts' | '/apps' | 'back-to-work' } {
  if (dest === 'cards') return { to: '/cards' };
  if (dest === 'artifacts') return { to: '/artifacts' };
  if (dest === 'apps') return { to: '/apps' };
  const onPage = /^\/(unread|cards|artifacts|apps|activity|hosted)(\/|$)/.test(pathname);
  return onPage ? { view: dest, to: 'back-to-work' } : { view: dest };
}

/**
 * THE URL AN ENTRY STANDS FOR — every entry, including the three that do not
 * navigate on a plain click.
 *
 * "Icon rail still not using <a>." Cards, Artifacts and Apps became anchors;
 * Home, Unread and Activity did not, because they switch which view the chat
 * list is showing and the URL does not change. That reasoning is right about
 * the CLICK and wrong about the ELEMENT: a thing with no href cannot be
 * right-clicked, opened in a new tab, middle-clicked or bookmarked, and the
 * honest fix is for the destination to exist rather than for the entry to
 * pretend.
 *
 * So all six are anchors now. The three view entries point at the page that
 * shows the same thing — `/unread` and `/activity` are those pages, and Home
 * is the workspace you were last in — and the rail intercepts their plain
 * left-click to switch the view in place, exactly as before. The browser's
 * own gestures fall through and land on the page.
 *
 * Home needs the caller's last workspace, which is why this takes it. With no
 * workspace yet there is nowhere to point and the entry stays a button.
 */
export function destinationHref(dest: Destination, lastWsSlug: string): string | null {
  if (dest === 'cards') return '/cards';
  if (dest === 'artifacts') return '/artifacts';
  if (dest === 'apps') return '/apps';
  if (dest === 'unread') return '/unread';
  if (dest === 'activity') return '/activity';
  return lastWsSlug ? `/w/${lastWsSlug}` : null;
}

/** Does a plain left-click on this entry NAVIGATE, or switch the view in
 *  place? The three views switch; the three pages go. */
export function navigatesOnClick(dest: Destination): boolean {
  return dest === 'cards' || dest === 'artifacts' || dest === 'apps';
}
