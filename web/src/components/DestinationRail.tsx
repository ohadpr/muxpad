import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
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
import { NavGlyph } from './NavGlyphs';
import { SettingsMenu } from './SettingsMenu';
import { ThemeSwitch } from './ThemeSwitch';
import './DestinationRail.css';

const REPO_URL = 'https://github.com/ohadpr/muxpad';

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

  /** The ROUTE an entry goes to, or null if it only switches the list's view.
   *  Derived from destinationAction so the two cannot disagree about which
   *  entries are places — `back-to-work` is a view's return trip, not a
   *  destination of its own, and must not become an href. */
  const pageRoute = (dest: Destination): '/cards' | '/artifacts' | '/apps' | null => {
    const to = destinationAction(dest, pathname).to;
    return to === '/cards' || to === '/artifacts' || to === '/apps' ? to : null;
  };

  const go = (dest: Destination) => {
    const act = destinationAction(dest, pathname);
    if (act.view) setRailView(act.view);
    if (act.to === '/cards' || act.to === '/artifacts' || act.to === '/apps')
      void navigate({ to: act.to });
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
        // ─── A PLACE IS A LINK; A VIEW IS A BUTTON ────────────────────
        // Cards, Artifacts and Apps are ROUTES, and they were <button>s with
        // an onClick — so right-click had no "open in new tab", cmd-click did
        // nothing, the status bar showed no target and middle-click was dead.
        // "card icon rail elements don't offer right click open menu maybe
        // they are not <a> links annoying." They are now.
        //
        // Home, Unread and Activity stay buttons, and that is not an
        // oversight: they do not navigate. They switch which VIEW the chat
        // list beside the rail is showing, and the URL does not change — you
        // stay in the chat you were in. An anchor whose href is the page you
        // are already on would offer a new tab that opens the wrong thing.
        const route = pageRoute(d);
        const body = <RailItemBody dest={d} count={count} />;
        const shared = {
          className: 'dest-rail-item',
          'data-dest': d,
          'data-current': d === current ? 'true' : undefined,
          'aria-current': d === current ? ('page' as const) : undefined,
          'aria-label': label,
          title: label,
        };
        return route ? (
          <Link key={d} to={route} {...shared}>
            {body}
          </Link>
        ) : (
          <button key={d} type="button" {...shared} onClick={() => go(d)}>
            {body}
          </button>
        );
      })}
      {/* ─── THE FOOT ────────────────────────────────────────────────────
          The three controls that are about the APP rather than about any
          conversation: what build this is, what it looks like, and the rest
          of its settings. They were a bar across the bottom of the chat
          list; see .dest-rail-foot for why they are here instead. */}
      <div className="dest-rail-foot">
        <div className="dest-rail-foot-row">
          <ThemeSwitch />
          <SettingsMenu />
        </div>
        <a
          className="dest-rail-build"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={`muxpad — build ${__MUXPAD_VERSION__}`}
        >
          {__MUXPAD_VERSION__}
        </a>
      </div>
    </nav>
  );
}

/**
 * What is inside a rail entry — the glyph, its unread badge, and the word.
 *
 * Its own component rather than a fragment built in the map, because the
 * entry is either a <Link> or a <button> depending on whether it is a place
 * or a view, and the contents must be identical either way. (It was a
 * `const body = <>…</>` inside the loop; biome reads a fragment there as an
 * unkeyed iterable item, which is a false positive but a fair hint that this
 * wanted to be a component.)
 */
function RailItemBody({ dest, count }: { dest: Destination; count: number }) {
  return (
    <>
      <span className="dest-rail-icon">
        {/* WEIGHT 2.3, not the 1.75 the set was drawn at. A glyph is not text:
            at a label's colour its thin anti-aliased stroke read fainter than
            the word under it — the stroke's MEDIAN painted pixel measured
            2.3–3.7:1 on the lifted ground (memphis aside) while the labels
            cleared 4.5. So the icon carries FULL rail ink and a heavier stroke
            (median now 3.65–8.7 at rest), and the label and the current-item
            marking stay where they were. At 2.0 wokintosh's and blueprint's
            resting icons still medianed ~2.9–3.1; 2.3 is where every theme
            clears 3:1. */}
        <NavGlyph name={dest} size={22} weight={2.3} className="dest-rail-glyph" />
        {count > 0 && (
          <span className="dest-rail-badge" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span className="dest-rail-label" aria-hidden="true">
        {DESTINATION_LABEL[dest]}
      </span>
    </>
  );
}
