/**
 * Position-freeze for the ACTIVE tab in the living sidebar.
 *
 * The unpinned block is auto-sorted by the server (attention → recency)
 * and re-fetched every 5s, which is exactly what you want for the
 * tabs you're NOT looking at. For the tab you ARE looking at it's hostile:
 * reading it, typing into it, or an agent finishing a turn there all bump its
 * `last_activity_at`, so the row you're on slides up the list under your
 * cursor — and every other row shifts to make way. Closing the tab below it,
 * or even re-finding where you are, becomes a moving-target problem.
 *
 * So: the active tab renders where it was when you arrived at it, and settles
 * into its sorted position only once you leave. Everything else keeps
 * re-sorting around it in real time, which is the whole point of a living
 * sidebar — the freeze is exactly one row wide.
 *
 * Purely presentational. The server's order is untouched (it stays the
 * authority every other surface reads) and the freeze evaporates on
 * deactivate, so nothing about it can outlive the visit. Pinned tabs are
 * excluded: they already have a manual position, and freezing one would fight
 * drag-to-reorder.
 */
import { useRef } from 'react';

export interface FreezableTab {
  id: string;
  pinned?: boolean | undefined;
}

/** A captured freeze: the tab it belongs to, and the row index it holds. */
export interface TabFreeze {
  id: string;
  index: number;
}

/**
 * `tabs` (server order) with the active tab moved back to `frozenIndex`.
 *
 * Returns the input unchanged when there's nothing to freeze: no active tab,
 * no captured index, an active tab that isn't in this list (another
 * workspace), or a PINNED active tab (manual order already owns it).
 *
 * The target is clamped into the unpinned block, and it has to be: the pinned
 * count changes under us (pinning another tab, dragging one to pin it) and
 * tabs come and go, so a captured index must never push the active row above
 * the pinned divider — into the "you arranged these" block, where it is not.
 */
export function freezeActiveTab<T extends FreezableTab>(
  tabs: T[],
  activeId: string | null,
  frozenIndex: number | null,
): T[] {
  if (!activeId || frozenIndex === null) return tabs;
  const from = tabs.findIndex((t) => t.id === activeId);
  if (from < 0) return tabs;
  const tab = tabs[from];
  if (!tab || tab.pinned) return tabs;
  const rest = tabs.filter((_, i) => i !== from);
  const pinnedCount = rest.filter((t) => t.pinned).length;
  const to = Math.min(Math.max(frozenIndex, pinnedCount), rest.length);
  if (to === from) return tabs;
  const next = rest.slice();
  next.splice(to, 0, tab);
  return next;
}

/**
 * The index to freeze the active tab at: the HIGHEST it has reached this visit.
 *
 * ── IT USED TO PIN THE ROW WHERE YOU CLICKED IT ─────────────────────────────
 * The index came from the DISPLAYED order, captured once on arrival, and held
 * for the whole visit — "what you clicked stays exactly where you clicked it".
 * That reads well and is half a rule. The missing half: opening a chat makes it
 * the most recent thing you have touched, so the server immediately sorts it to
 * the top — and this held it at row 8, where it had been two hours cold. The
 * promotion the user asked for by clicking never arrived on screen, and the row
 * that DID climb was the one they had just left (its freeze having been dropped
 * on the way out). Reported as "when I touch a chat it doesn't go to the top".
 *
 * So the rule becomes directional, which is what it always should have been.
 * What hurts is a row sliding DOWN the list under your cursor while you work in
 * it — other chats getting busier and pushing it away, so closing the row below
 * it or re-finding where you are becomes a moving-target problem. A row moving
 * UP is the opposite: it is the consequence of the click you just made, it
 * happens once, and it ends at the top where it then stays.
 *
 * Hence the minimum. The freeze holds the best index the active row has
 * achieved, so it rises to its sorted position and never falls back. It also
 * makes the capture self-correcting without any knowledge of when the server's
 * stamp lands: the arrival index is simply the first candidate, and the
 * promotion a moment later wins on its own.
 */
export function activeTabFreezeIndex<T extends FreezableTab>(
  displayed: T[],
  activeId: string | null,
): number | null {
  if (!activeId) return null;
  const i = displayed.findIndex((t) => t.id === activeId);
  if (i < 0) return null;
  return displayed[i]?.pinned ? null : i;
}

/**
 * One step of the freeze state machine, pure so the whole behaviour is
 * testable without rendering: takes the previous freeze plus what's on screen
 * now, returns the freeze to keep and the order to render.
 *
 * The rules, in the order they apply:
 *  - no active tab → drop the freeze (this is the "settles when deactivated"
 *    half: the row falls straight into its sorted place);
 *  - a DIFFERENT tab became active → capture its current on-screen index;
 *  - the active tab got pinned while active → drop the freeze, so unpinning
 *    later re-captures a current index instead of teleporting the row back to
 *    where it sat minutes ago;
 *  - otherwise → keep the BEST index it has held, and let the server promote
 *    it above that at any time. See `activeTabFreezeIndex` for why the rule is
 *    directional: down is the moving target, up is the answer to your click.
 *
 * Capture is retried on every step until it succeeds (a null freeze with an
 * active id re-enters the capture branch), which covers the ordinary case of
 * the active tab being known from the URL before its list has loaded.
 */
export function advanceTabFreeze<T extends FreezableTab>(
  prev: TabFreeze | null,
  opts: { tabs: T[]; displayed: T[]; activeId: string | null },
): { freeze: TabFreeze | null; order: T[] } {
  const { tabs, displayed, activeId } = opts;
  let freeze = prev;
  if (!activeId) {
    freeze = null;
  } else if (freeze?.id !== activeId) {
    const index = activeTabFreezeIndex(displayed, activeId);
    freeze = index === null ? null : { id: activeId, index };
  } else if (tabs.find((t) => t.id === activeId)?.pinned) {
    freeze = null;
  } else {
    // SAME tab, still active: let a promotion through and keep it. The server's
    // index is where recency says this row belongs; a smaller one means it has
    // climbed, which is exactly what arriving here caused and what must not be
    // undone. Anything larger is the list closing over it and is what the
    // freeze is for.
    const now = tabs.findIndex((t) => t.id === activeId);
    if (now >= 0 && now < freeze.index) freeze = { id: activeId, index: now };
  }
  return { freeze, order: freezeActiveTab(tabs, activeId, freeze?.index ?? null) };
}

/**
 * Hook form: server-ordered tabs in, the order to render out.
 *
 * Refs rather than state because this derives a render order from props — it
 * must not schedule a second render, and the step is idempotent for the same
 * inputs (safe under StrictMode's double-invoke).
 */
export function useFrozenTabOrder<T extends FreezableTab>(tabs: T[], activeId: string | null): T[] {
  const freeze = useRef<TabFreeze | null>(null);
  // Last rendered order — what a fresh capture must measure against.
  const displayed = useRef<T[]>(tabs);
  const step = advanceTabFreeze(freeze.current, {
    tabs,
    displayed: displayed.current,
    activeId,
  });
  freeze.current = step.freeze;
  displayed.current = step.order;
  return step.order;
}
