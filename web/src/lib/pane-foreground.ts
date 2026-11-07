/**
 * WHO IS IN FRONT IN A CHAT PANE, named once.
 *
 * ── THE MACHINE THIS REPLACES ────────────────────────────────────────────
 * Four flags — `drawerOpen`, `drawer.paneId`, `openTool`, `openImage` — plus
 * `active` from the parent, read in six places, each re-deriving the same
 * question with its own subset:
 *
 *     if (!active || openTool || openImage || isMobileLayout()) return;   // focus the draft
 *     if (!active || showingChildChat) return;                           // type-to-focus
 *     if (openTool || openImage) return;                                 //   …again, inside it
 *     if (e.key === 'Escape' && !openTool && !openImage) clearJump();    // Escape
 *     {showScrollDown && !drawerOpen ? …}                                // the arrow
 *
 * Nothing names the states, so each site states its own, and the bugs are
 * always a MISSING TERM rather than a wrong one. Two of them this week: typing
 * went to the parent while a sub-chat was open in the drawer (the type-to-focus
 * site did not know about the drawer), and the jump-to-latest arrow painted over
 * the drawer (the arrow did not either). Both read "correct" at the site; both
 * were a combination nobody had written down.
 *
 * ── WHAT IT IS INSTEAD ───────────────────────────────────────────────────
 * One function, five named states, and the three questions anyone actually
 * asks. A new surface in front of the log — the next modal, a preview, an
 * inspector — is a case here, and every existing site inherits the answer
 * instead of needing to be found and amended.
 *
 * Deliberately NOT a hook and NOT in the component: it is a pure function of
 * four booleans, which is a thing you can put a table under.
 */

/** What is in front of this pane's conversation. In precedence order. */
export type Foreground =
  /** A lightbox over everything, including the drawer. */
  | 'image'
  /** A tool-call detail modal. */
  | 'tool'
  /** The work drawer, with a sub-chat mounted in it. */
  | 'drawer-chat'
  /** The work drawer, showing its own lists. */
  | 'drawer-list'
  /** Nothing — the conversation itself. */
  | 'transcript';

export interface ForegroundInput {
  /** Is this pane the visible face at all? */
  active: boolean;
  drawerOpen: boolean;
  /** The sub-chat mounted inside the drawer, if any. */
  drawerPaneId: string | null;
  openTool: boolean;
  openImage: boolean;
}

/**
 * Precedence is the stacking order, and it is the same order the DOM uses:
 * the lightbox is over the tool modal is over the drawer is over the log.
 */
export function foregroundOf(i: ForegroundInput): Foreground {
  if (i.openImage) return 'image';
  if (i.openTool) return 'tool';
  if (i.drawerOpen) return i.drawerPaneId ? 'drawer-chat' : 'drawer-list';
  return 'transcript';
}

/**
 * Does the CONVERSATION own the keyboard?
 *
 * False for every surface in front of it, and the one that matters is
 * `drawer-chat`: the nested pane is a second ChatPane that inherits its
 * parent's `active`, so both used to claim the window's keydown and the
 * parent — registered first — won. You typed into the chat you were reading
 * and it went to the one behind it.
 *
 * An INACTIVE pane owns nothing, which is what keeps every other mounted chat
 * out of the way.
 */
export function ownsKeyboard(i: ForegroundInput): boolean {
  return i.active && foregroundOf(i) === 'transcript';
}

/**
 * Should the jump-to-latest arrow be drawn?
 *
 * It scrolls the transcript, so it is meaningless whenever the transcript is
 * not what you are looking at — and it carries the drawer's own `z-index`, so
 * while the drawer is open it does not merely mislead, it paints on top.
 */
export function showsScrollArrow(i: ForegroundInput): boolean {
  return foregroundOf(i) === 'transcript';
}

/**
 * Does Escape belong to the transcript's search highlight?
 *
 * No while a modal is up — closing the lightbox must not also throw away the
 * highlight underneath it. The drawer does NOT take Escape: it has its own
 * close control, and a reader who has jumped to a hit and then glanced at the
 * drawer still wants the highlight when they come back.
 */
export function escapeClearsJump(i: ForegroundInput): boolean {
  const f = foregroundOf(i);
  return f !== 'image' && f !== 'tool';
}

/**
 * May the composer take focus on arrival — the restored-draft case?
 *
 * Same answer as the keyboard, with one addition the other sites do not share:
 * never on a touch layout, where focusing raises the software keyboard over
 * the conversation somebody just opened. That is a caller's concern, not this
 * function's, so it is passed in rather than detected here.
 */
export function focusesComposerOnArrival(i: ForegroundInput, touchLayout: boolean): boolean {
  return !touchLayout && ownsKeyboard(i);
}
