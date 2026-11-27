import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { unreadByWorkspace } from '../lib/chat-sections';
import {
  DESTINATIONS,
  DESTINATION_LABEL,
  type Destination,
  currentDestination,
  destinationAction,
  destinationHref,
  navigatesOnClick,
} from '../lib/desktop-destinations';
import { setRailView, useRailView } from '../lib/rail-view';
import { useUnreadCorpus } from '../lib/use-unread';
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
  const unread = [...unreadByWorkspace(useUnreadCorpus()).values()].reduce((a, b) => a + b, 0);

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
        // ─── EVERY ENTRY IS AN ANCHOR ────────────────────────────────
        // Cards, Artifacts and Apps were links and the other three were
        // buttons, on the reasoning that a view switch is not a navigation.
        // True about the CLICK, wrong about the ELEMENT: "icon rail still not
        // using <a>." A button cannot be right-clicked into a new tab,
        // middle-clicked, or copied as a link, and no handler can add those —
        // they belong to the browser and the browser needs an href.
        //
        // So all six carry one, and the three VIEW entries intercept the plain
        // left-click to switch in place exactly as they always did. The
        // modified clicks fall through untouched, which is the whole point:
        // cmd-click Unread and you get /unread in a new tab, plain-click it
        // and the list beside you changes without leaving your chat.
        const href = destinationHref(d, lastWsSlug);
        const body = <RailItemBody dest={d} count={count} />;
        const shared = {
          className: 'dest-rail-item',
          'data-dest': d,
          'data-current': d === current ? 'true' : undefined,
          'aria-current': d === current ? ('page' as const) : undefined,
          'aria-label': label,
          title: label,
        };
        // No workspace visited yet: Home has nowhere to point, so it stays a
        // button rather than becoming a link to nothing.
        if (!href)
          return (
            <button key={d} type="button" {...shared} onClick={() => go(d)}>
              {body}
            </button>
          );
        return (
          <Link
            key={d}
            to={href}
            {...shared}
            onClick={(e: React.MouseEvent) => {
              if (navigatesOnClick(d)) return;
              // A MODIFIED CLICK IS THE BROWSER'S. cmd/ctrl (new tab), shift
              // (new window), middle button, or any default already prevented
              // by something upstream — leave every one of them alone. Taking
              // them would be re-breaking what the href was added to fix.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              go(d);
            }}
          >
            {body}
          </Link>
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
