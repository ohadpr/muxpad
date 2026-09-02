import { type PaneStatus, rollupStatus } from '@muxpad/shared';

/**
 * The manual "mark unread" mark, as the client sees it.
 *
 * There is exactly ONE server route behind this (POST /api/tabs/:id/unread to
 * set, POST /api/tabs/:id/seen to clear) and it is reached DELIBERATELY from
 * three places: the desktop context menu, the touch long-press menu, and the
 * sheet's swipe tray. They all route through {@link setTabUnread} so the three
 * cannot drift — in particular so the two menus can't keep the plain "write
 * then refetch" behaviour while only the swipe tray gets the optimistic patch.
 *
 * NOT every caller of /seen, and that distinction matters. TabView also hits
 * /seen twice as a side effect of NAVIGATION (a debounced per-pane seen while
 * you sit on a tab, and a bulk tab-seen when you leave it), and those are not
 * this action — they are "you looked at it", which is the read event itself.
 * They stay outside this module, and they mean a manual mark on the tab you
 * are CURRENTLY VIEWING is cleared again when you navigate away. That is
 * long-standing behaviour of the mark (the context menu has always worked this
 * way); the swipe tray only makes it easier to reach. Deciding whether an
 * explicit mark should survive leaving the tab is a product question about the
 * /seen routes, not something to paper over here.
 *
 * WHY OPTIMISTIC AT ALL. The tab list refreshes on a 5s poll, and the write
 * used to be `await POST; await refetch()`. That is fine over loopback and
 * awful over a Tailscale hop on a phone: you swipe, tap "Unread", the tray
 * closes and the row sits there looking exactly as it did for as long as the
 * round trip takes. The mark is the entire point of the gesture, so it has to
 * land on the same frame as the tap. The refetch still happens and still wins
 * — this only covers the gap.
 */

/** A tab row, as far as the unread mark is concerned. */
export interface UnreadRow {
  unread?: boolean | undefined;
  status?: PaneStatus | undefined;
}

/**
 * What a row LOOKS like the instant it is marked (un)read, before the server
 * has answered.
 *
 * The row renders two things from this write: the bold name (`unread`) and
 * the status rail's mark (`status`). Setting only `unread` would bold the name
 * and leave the rail blank, which is a state the server can never produce — so
 * the optimistic row would visibly differ from the one that replaces it a
 * moment later.
 *
 * `status` is a ROLLUP, not an assignment: the server folds a manual unread
 * mark in as one more `ready` among the tab's panes (decorateTab), so a tab
 * whose agent is mid-turn stays `working` when you mark it unread. Assigning
 * `ready` here would blank a spinner for one frame and then bring it back.
 *
 * Clearing is the mirror image, and it is exact rather than a guess: a pane is
 * `ready` exactly when it is unread (ptyd-cache), and /seen clears the manual
 * mark AND every pane's, so a cleared tab has no `ready` left to inherit. The
 * refetch behind it is still not optional — it is what reconciles anything
 * that changed on the server between the tap and the reply — but the patch
 * itself is a correct inverse, which is what makes the rollback below sound.
 */
export function unreadRowPatch(
  row: UnreadRow,
  unread: boolean,
): { unread: boolean; status: PaneStatus } {
  const current: PaneStatus = row.status ?? 'idle';
  if (unread) return { unread: true, status: rollupStatus([current, 'ready']) };
  return { unread: false, status: current === 'ready' ? 'idle' : current };
}

/** Everything {@link setTabUnread} touches, injected so the action is testable
 *  without a module cache, a fetch, or a React tree. */
export interface TabUnreadIo {
  /** POST /api/tabs/:id/unread — the existing route, not a new one. */
  markUnread: (id: string) => Promise<void>;
  /** POST /api/tabs/:id/seen — the same route viewing a tab already calls. */
  markSeen: (id: string) => Promise<void>;
  /** Patch the cached row so the sidebar repaints now. */
  patch: (tabId: string, unread: boolean) => void;
  /** Re-read the authoritative lists (tabs + the workspace rollup). */
  refresh: () => Promise<void>;
}

/**
 * Toggle a tab's manual unread mark: patch, write, reconcile.
 *
 * A failed write ROLLS THE PATCH BACK before rethrowing. Without that, a
 * request that fails offline would leave the row permanently bold with nothing
 * behind it — the one outcome worse than the latency this patch exists to
 * hide, because it lies in the direction of "something needs your attention".
 */
export async function setTabUnread(io: TabUnreadIo, tabId: string, want: boolean): Promise<void> {
  io.patch(tabId, want);
  try {
    await (want ? io.markUnread(tabId) : io.markSeen(tabId));
  } catch (err) {
    io.patch(tabId, !want);
    await io.refresh().catch(() => {
      // the poll will retry; the rollback above already restored the row
    });
    throw err;
  }
  await io.refresh();
}
