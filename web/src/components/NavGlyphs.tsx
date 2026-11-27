import type { ReactNode } from 'react';

/**
 * THE NAVIGATION GLYPHS — one set, drawn once, for both places he navigates
 * by: the desktop ribbon (DestinationRail: Home · Unread · Activity ·
 * Artifacts · Apps) and the phone's bottom bar (MobileNav: Home · Unread ·
 * Activity · Search). "copy the ribbon icon design from the desktop app to
 * the mobile app" — so the shared three are the SAME drawings in both, and
 * Search, which the ribbon does not have, is drawn into the same family.
 *
 * The family: a 24-unit grid, round caps and joins, 2-unit corner radii,
 * every glyph filling the same ~16×16 live area so none reads bigger than its
 * neighbours. currentColor only — each surface decides the ink and the weight
 * (see the callers), the drawing never does.
 */
export type NavGlyphName =
  | 'home'
  | 'unread'
  | 'activity'
  | 'cards'
  | 'artifacts'
  | 'apps'
  | 'search';

export function NavGlyph({
  name,
  size,
  weight,
  className,
}: {
  name: NavGlyphName;
  size: number;
  /** Stroke width in grid units. */
  weight: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}

const GLYPHS: Record<NavGlyphName, ReactNode> = {
  // Two cards, the front one offset — "values I have pinned somewhere". A
  // deck rather than a single rectangle, which at 22px is indistinguishable
  // from a note, a window or a stop button. The inner line is the one row of
  // content a card is allowed to be.
  cards: (
    <>
      <rect x="3" y="7" width="14" height="11" rx="2" />
      <path d="M8 4.5h11a2 2 0 0 1 2 2V15" />
      <path d="M6.5 12.5h7" />
    </>
  ),
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
  // SEARCH, drawn into the family: the lens is the same 16-unit live area as
  // the others (a 6.25 radius ring centred at 10.5 plus its handle reaching
  // 20,20), on the same stroke and caps. It has no ribbon counterpart — ⌘K is
  // the desktop's search — so this is its only home.
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.25" />
      <path d="m15.2 15.2 4.8 4.8" />
    </>
  ),
};
