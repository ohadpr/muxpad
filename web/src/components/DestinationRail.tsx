import { useNavigate, useRouterState } from '@tanstack/react-router';
import { unreadByWorkspace } from '../lib/chat-sections';
import {
  DESTINATIONS,
  DESTINATION_LABEL,
  type Destination,
  currentDestination,
  destinationAction,
} from '../lib/desktop-destinations';
import { setRailView, useRailView } from '../lib/rail-view';
import { useChatCorpus } from '../lib/use-all-chats';
import './DestinationRail.css';

/**
 * THE LEFT RAIL — Home, Unread, Activity, Artifacts, Apps: an icon with its
 * word under it, the current one marked, Unread carrying its count. See
 * lib/desktop-destinations for what each entry is and does.
 *
 * Desktop only; the phone has the same first three as its bottom tab bar.
 */
export function DestinationRail({ lastWsSlug }: { lastWsSlug: string }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const view = useRailView();
  const current = currentDestination(pathname, view);
  // Every workspace's unread conversations — Unread is a list across all of
  // them, so its badge counts all of them (no sub-chats; see isUnreadChat).
  const unread = [...unreadByWorkspace(useChatCorpus()).values()].reduce((a, b) => a + b, 0);

  const go = (dest: Destination) => {
    const act = destinationAction(dest, pathname);
    if (act.view) setRailView(act.view);
    if (act.to === '/artifacts' || act.to === '/apps') void navigate({ to: act.to });
    else if (act.to === 'back-to-work' && lastWsSlug)
      // The workspace's own redirect lands on its last-visited chat.
      void navigate({ to: '/w/$wsSlug', params: { wsSlug: lastWsSlug } });
  };

  return (
    <nav className="dest-rail" aria-label="Destinations">
      {DESTINATIONS.map((d) => {
        const count = d === 'unread' ? unread : 0;
        const label =
          count > 0 ? `${DESTINATION_LABEL[d]} — ${count} unread` : DESTINATION_LABEL[d];
        return (
          <button
            key={d}
            type="button"
            className="dest-rail-item"
            data-dest={d}
            data-current={d === current ? 'true' : undefined}
            aria-current={d === current ? 'page' : undefined}
            aria-label={label}
            title={label}
            onClick={() => go(d)}
          >
            <span className="dest-rail-icon">
              <DestinationIcon dest={d} />
              {count > 0 && (
                <span className="dest-rail-badge" aria-hidden="true">
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span className="dest-rail-label" aria-hidden="true">
              {DESTINATION_LABEL[d]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * ONE SET, five glyphs: a 24-unit grid, a 1.75 stroke, round caps and joins,
 * 2-unit corner radii, every glyph filling the same ~16×16 live area so none
 * reads bigger than its neighbours. Drawn in currentColor, so each theme's
 * rail ink is the only colour — they sit on deep rails and light ones alike.
 */
export function DestinationIcon({ dest }: { dest: Destination }) {
  return (
    <svg
      className="dest-rail-glyph"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPH[dest]}
    </svg>
  );
}

const GLYPH: Record<Destination, React.ReactNode> = {
  // A house: pitched roof, a door.
  home: (
    <>
      <path d="M4 10.2 12 4l8 6.2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M9.5 20v-5.5h5V20" />
    </>
  ),
  // An inbox tray with something in it — "waiting to be read".
  unread: (
    <>
      <path d="M4 13.5 6.2 6.3A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.3l2.2 7.2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 13.5h4.2l1.3 2h5l1.3-2H20" />
    </>
  ),
  // A pulse — things moving, most recent first.
  activity: <path d="M3.5 12.5h3.8l2.2-6.5 5 13 2.2-6.5h3.8" />,
  // Stacked sheets — things you made and put somewhere.
  artifacts: (
    <>
      <path d="m12 4 8 4.2-8 4.2-8-4.2z" />
      <path d="m4 12.2 8 4.2 8-4.2" />
      <path d="m4 16 8 4 8-4" />
    </>
  ),
  // Four tiles — running servers, an app grid.
  apps: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="2" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" />
    </>
  ),
};
