import { useEffect, useState } from 'react';

/**
 * Which pinned cards this reader has collapsed.
 *
 * ── WHY COLLAPSE REPLACED DISMISS ───────────────────────────────────────────
 * The card's header carried an × that DELETED it — the only control a reader
 * had was the destructive one. That is the wrong division of ownership: the
 * card belongs to whoever writes it (a cron, an agent, `muxpad card set`), and
 * the writer is the one who knows when it is finished. A reader pressing × on a
 * market card does not mean "retire this schedule's output forever"; it means
 * "I am not looking at this right now", and the next fire would have silently
 * recreated it anyway — a button that appears to work and then undoes itself.
 *
 * So the reader gets the non-destructive control instead: collapse to the
 * header row, which still says the card's name, its age, and whether it has
 * gone overdue. Removing a card is `muxpad card clear`, by the thing that put
 * it there.
 *
 * ── WHY LOCAL, AND NOT A COLUMN ─────────────────────────────────────────────
 * Collapsed-ness is a VIEW preference, not content: two people (or a phone and
 * a desktop) can reasonably disagree about whether the build card is in the way
 * right now, and neither answer should overwrite the other. localStorage is the
 * same scope the nav tree's expansion, settings and last-visited already use.
 *
 * Keyed on tab + NAME, not on the card's row id. `TabCardStore.set` upserts on
 * (tab_id, name), so the name is the card's identity across every rewrite; the
 * id survives an update but not a clear-and-recreate, which would silently
 * re-expand a card the reader had put away.
 */
const KEY = 'muxpad.cardCollapse.v1';

/** tabId/name -> collapsed. Only EXPLICIT collapses are stored; the default is
 *  expanded, because a card nobody asked to hide is a card you want to read. */
export type CardCollapseState = Record<string, boolean>;

export function cardKey(tabId: string, name: string): string {
  return `${tabId}/${name}`;
}

export function isCardCollapsed(
  state: CardCollapseState,
  tabId: string | null | undefined,
  name: string,
): boolean {
  if (!tabId) return false;
  return state[cardKey(tabId, name)] === true;
}

function read(): CardCollapseState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: CardCollapseState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Only `true` is worth keeping — `false` is the default, and storing it
      // would grow this forever with every card anyone ever expanded again.
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

let current: CardCollapseState = typeof window === 'undefined' ? {} : read();
const listeners = new Set<(s: CardCollapseState) => void>();

export function toggleCardCollapsed(tabId: string, name: string): void {
  const k = cardKey(tabId, name);
  const next = { ...current };
  if (next[k]) delete next[k];
  else next[k] = true;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // quota exceeded etc. — best-effort; the in-memory state still updated, so
    // the toggle works for this session either way.
  }
  for (const fn of listeners) fn(current);
}

export function useCardCollapse(): CardCollapseState {
  const [state, setState] = useState<CardCollapseState>(current);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/**
 * Test seam — drops the in-memory state and re-reads localStorage, which is
 * exactly what a page load does. Re-READS rather than blanking, so a test can
 * distinguish "the module remembered it" from "the storage did".
 */
export function __reloadCardCollapse(): void {
  listeners.clear();
  current = read();
}
