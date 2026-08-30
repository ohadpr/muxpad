/**
 * Which controls a NavTree TAB ROW offers, per chrome variant.
 *
 * Extracted as pure logic because the two variants diverged for real
 * usability reasons and kept drifting by accident:
 *
 *  - The DESKTOP sidebar has hover, so controls can hide until the pointer
 *    arrives. The pin lives there as a hover-revealed button and doubles as
 *    the "this is pinned" marker.
 *
 *  - The MOBILE sheet has no hover, so a hidden control is an invisible one.
 *    It also has no dependable long-press: the rows sit in a momentum-
 *    scrolling container (`.navtree-scroll`), and iOS hands that touch to the
 *    scroll recognizer, which reaches the page as `pointercancel` and kills
 *    the hold. So touch gets an explicit ⋯ button that opens the same menu on
 *    a plain tap, and does NOT get a second always-on pin square competing
 *    with the × for thumb space.
 *
 * The pane-count chip exists because a one-pane and a five-pane row looked
 * identical on the sheet yet behaved completely differently on tap (navigate
 * vs expand-in-place). It is the SAME chip a collapsed workspace row uses,
 * so it adds no new visual vocabulary — only the meaning it already carries:
 * "N children are hidden in here."
 */
export type NavTreeVariantName = 'sidebar' | 'sheet';

export interface TabRowAffordances {
  /** Hover-revealed pin/unpin button (desktop only). */
  pinButton: boolean;
  /** ⋯ button opening the row's action menu (touch only). */
  moreButton: boolean;
  /** Leading chevron that expands the row into its pane list (touch only). */
  paneExpander: boolean;
  /** Subtle "N panes" chip — the one hint that a tap will expand, not navigate. */
  paneCountChip: boolean;
  /** Tapping the row's NAME expands the pane list instead of navigating. */
  tapExpandsPanes: boolean;
}

export function tabRowAffordances(opts: {
  variant: NavTreeVariantName;
  paneCount: number;
  /** The sheet row is currently expanded into its pane list. */
  panesOpen: boolean;
  /** The row is showing its inline rename input — all controls stand down. */
  isEditing: boolean;
}): TabRowAffordances {
  const { variant, paneCount, panesOpen, isEditing } = opts;
  const sheet = variant === 'sheet';
  // A single-pane tab has nothing to pick between, so it never expands — it
  // just opens, which is the behavior that felt right all along.
  const picksPane = sheet && paneCount > 1;
  return {
    pinButton: variant === 'sidebar',
    moreButton: sheet && !isEditing,
    paneExpander: picksPane && !isEditing,
    // Collapsed-only, mirroring the workspace chip: once the panes are listed
    // below, the count is right there and the chip would just double-signal.
    paneCountChip: picksPane && !panesOpen,
    tapExpandsPanes: picksPane,
  };
}

/**
 * Should the chat header show the pane's working folder as its own cell?
 *
 * ONLY when the pane actually sits in a project — a git repo, AGENTS.md or
 * .mcp.json somewhere up the tree (the server computes this as
 * `hasProjectContext` and ships it on the session frame).
 *
 * For a plain conversation the working directory is an implementation
 * detail. Worse, the old header rendered it with a red "!" warning, so every
 * non-coding chat looked BROKEN — it read as "something is misconfigured"
 * when the honest answer was "you just aren't coding right now". A chat
 * about dinner has no business advertising `~`.
 *
 * Hiding the cell never hides the capability: the full path and the folder
 * switcher move into the session menu (see ChatPane's SessionBar), so
 * setting or checking the folder is always one tap away.
 */
export function showFolderChip(folder: { hasProject: boolean } | null): boolean {
  return folder?.hasProject === true;
}

/** Where the folder is reachable from, given the chip's visibility. Exists so
 *  the rule "exactly one surface shows the path, always at least one" is
 *  asserted rather than assumed. */
export function folderSurface(
  folder: { hasProject: boolean } | null,
): 'chip' | 'session-menu' | 'none' {
  if (!folder) return 'none';
  return showFolderChip(folder) ? 'chip' : 'session-menu';
}
