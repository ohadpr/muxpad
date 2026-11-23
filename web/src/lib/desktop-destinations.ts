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
 *   artifacts · apps           PAGES (routes) that belong to no workspace,
 *                              rendered beside the kept-alive workspace hosts
 *                              (lib/shell-routes).
 * They share a strip because they are the five things he navigates BY; the
 * workspaces are sections in the list, not entries here.
 */
export type Destination = 'home' | 'unread' | 'activity' | 'artifacts' | 'apps';

export const DESTINATIONS: readonly Destination[] = [
  'home',
  'unread',
  'activity',
  'artifacts',
  'apps',
];

export const DESTINATION_LABEL: Record<Destination, string> = {
  home: 'Home',
  unread: 'Unread',
  activity: 'Activity',
  artifacts: 'Artifacts',
  apps: 'Apps',
};

/**
 * Which entry is CURRENT. A page route wins — standing on Artifacts you are on
 * Artifacts, whatever the list beside it is showing. `/activity` (the page,
 * kept for deep links) is Activity. Anywhere else — a chat — it is the list's
 * view.
 */
export function currentDestination(pathname: string, view: RailView): Destination {
  const p = pathname.replace(/\/+$/, '') || '/';
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
): { view?: RailView; to?: '/artifacts' | '/apps' | 'back-to-work' } {
  if (dest === 'artifacts') return { to: '/artifacts' };
  if (dest === 'apps') return { to: '/apps' };
  const onPage = /^\/(artifacts|apps|activity|hosted)(\/|$)/.test(pathname);
  return onPage ? { view: dest, to: 'back-to-work' } : { view: dest };
}
