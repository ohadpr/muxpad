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
 *  - The MOBILE sheet has no hover, and it no longer has ANY permanent
 *    per-row control — no ×, no ⋯. Both were always-on hit squares parked
 *    exactly where a thumb lands while scrolling, so the two most common
 *    mis-taps in the whole app were "closed a chat I meant to open" and
 *    "opened a menu I meant to scroll past". Pin, Mark unread and Close moved
 *    UNDER the row, revealed by a left swipe (see lib/swipe-axis + NavTree's
 *    SwipeRow) — the standard iOS list idiom, discoverable by muscle memory,
 *    and impossible to hit by accident because it takes a deliberate
 *    horizontal gesture. Mark unread joined the other two rather than staying
 *    menu-only: it was the one action the removed ⋯ menu owned that has no
 *    other one-gesture route on touch. Long-press still opens the full context
 *    menu where the OS lets it through; it is a bonus path, never the only one.
 *
 * ─── What the sheet's rail rebuild deleted here ──────────────────────────
 * `paneCountChip` is GONE, and with it the rule that a multi-pane row's TAP
 * expands instead of navigating.
 *
 * The sheet rail now spends its marks on one thing: does this chat want you?
 * A pane count is a property, not an answer to that, and a chip on every
 * multi-pane row was a second permanent mark competing with the one that
 * matters. The accepted cost is stated plainly: a two-pane chat now looks
 * exactly like a one-pane chat.
 *
 * Tapping the row therefore OPENS it, on every row, with no exceptions to
 * learn — which is what a one-line list of chats should do. The pane list is
 * still reachable, and is still the only route to a second pane on mobile
 * (TabView's mobile branch has no pane switcher of its own), so the expander
 * survives as a small trailing chevron on multi-pane rows. It is COLLAPSED by
 * default now: the sheet opens on a flat list of chats, not on one chat's
 * children.
 */
export type NavTreeVariantName = 'sidebar' | 'sheet';

export interface TabRowAffordances {
  /** Hover-revealed pin/unpin button (desktop only). */
  pinButton: boolean;
  /** Hover-revealed close × (desktop only — touch swipes instead). */
  closeButton: boolean;
  /** Trailing chevron that expands the row into its pane list (touch only). */
  paneExpander: boolean;
}

export function tabRowAffordances(opts: {
  variant: NavTreeVariantName;
  paneCount: number;
  /** The row is showing its inline rename input — all controls stand down. */
  isEditing: boolean;
}): TabRowAffordances {
  const { variant, paneCount, isEditing } = opts;
  // A single-pane tab has nothing to pick between, so it never expands — it
  // just opens, which is the behavior that felt right all along.
  const picksPane = variant === 'sheet' && paneCount > 1;
  return {
    pinButton: variant === 'sidebar' && !isEditing,
    // Touch rows carry NO permanent controls at all now — see the swipe note
    // above. Both the × and the ⋯ that preceded it are gone; pin, mark-unread
    // and close live under the row, revealed by a left swipe.
    closeButton: variant === 'sidebar' && !isEditing,
    paneExpander: picksPane && !isEditing,
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
