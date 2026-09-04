/**
 * Order-freeze for the MOBILE SHEET's chat list, for as long as the sheet is
 * open.
 *
 * ─── Why the whole list, and not one row ─────────────────────────────────
 * The desktop rail freezes exactly ONE row (lib/tab-freeze): the tab you are
 * looking at, because being in a tab bumps its own `last_activity_at` and the
 * row would otherwise climb the list under your cursor. Everything else
 * re-sorting live is the point of a living rail — on desktop the rows also
 * carry tints, bars and word chips, so a row that moves is not the only thing
 * telling you something changed.
 *
 * The sheet's rail carries none of that any more. An idle row is an emoji and
 * a name; the only permanent mark left is one dot on `blocked`. With the marks
 * gone, the rail's information lives almost entirely in ORDER — and the order
 * is server-computed (attention → busy → recency) and re-derived by a 5s poll.
 * A quiet list that silently reshuffles under a thumb is worse than a noisy
 * stable one: you lose the row you were reaching for, and nothing on screen
 * says why.
 *
 * So the sheet snapshots the order when it opens and holds it until it closes.
 * The sheet's NavTree is unmounted on close (MobileNavSwitcher renders it only
 * while `open`), so "first render" IS "the sheet opened" and there is no
 * lifecycle to keep in sync.
 *
 * ─── What is frozen, and what deliberately is not ────────────────────────
 * ORDER only. Every row's live STATUS — the spinner, the blocked dot, the
 * unread weight — keeps updating in place off the same poll, because that is a
 * property of the row and not of the list. Rows that disappear (a closed chat)
 * simply drop out; rows that appear (a new chat, a workspace switch inside the
 * open sheet) are APPENDED rather than sorted in, so nothing already on screen
 * moves to make room for them.
 *
 * Pure, so the rule is testable without rendering — see sheet-order.test.ts.
 */
import { useRef } from 'react';

export interface OrderableTab {
  id: string;
}

/**
 * One step of the freeze: the ids captured so far plus the list the server is
 * offering now, in → the ids to remember and the order to render, out.
 *
 * `prev === null` is the first step (the sheet just opened): the server's order
 * is taken as-is and becomes the snapshot. After that the snapshot decides,
 * and anything the snapshot has never seen goes on the end — in the server's
 * own relative order, so a burst of new chats still arrives sensibly ordered
 * among themselves.
 *
 * The returned snapshot includes the appended ids, which is what makes a new
 * row stick where it landed instead of jumping the next time the poll re-sorts
 * it upward.
 */
export function advanceSheetOrder<T extends OrderableTab>(
  prev: readonly string[] | null,
  tabs: readonly T[],
): { snapshot: string[]; order: T[] } {
  if (prev === null) {
    const order = tabs.slice();
    return { snapshot: order.map((t) => t.id), order };
  }
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const order: T[] = [];
  for (const id of prev) {
    const tab = byId.get(id);
    if (tab) order.push(tab);
  }
  const seen = new Set(prev);
  for (const tab of tabs) if (!seen.has(tab.id)) order.push(tab);
  return { snapshot: order.map((t) => t.id), order };
}

/**
 * Hook form: server-ordered tabs in, the order to render out — frozen for the
 * lifetime of this component instance.
 *
 * A ref rather than state, for the same reason useFrozenTabOrder uses one:
 * this DERIVES a render order from props and must not schedule a second
 * render. The step is idempotent for the same inputs, so StrictMode's
 * double-invoke is harmless.
 *
 * `enabled: false` returns the server order untouched AND keeps the snapshot
 * unarmed, so the desktop rail — which wants a living list — pays nothing and
 * cannot accidentally inherit a stale capture if it is ever turned on later.
 */
export function useFrozenSheetOrder<T extends OrderableTab>(tabs: T[], enabled: boolean): T[] {
  const snapshot = useRef<string[] | null>(null);
  if (!enabled) {
    snapshot.current = null;
    return tabs;
  }
  const step = advanceSheetOrder(snapshot.current, tabs);
  snapshot.current = step.snapshot;
  return step.order;
}
