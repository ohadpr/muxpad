import { useEffect, useState } from 'react';

/**
 * Which pinned cards this reader has opened up.
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
 * Removing a card is `muxpad card clear`, by the thing that put it there.
 *
 * ── THE DEFAULT FLIPPED, AND THAT IS WHY THIS IS v2 ─────────────────────────
 * This used to record which cards were COLLAPSED, because a card was open by
 * default and shut on request. The row layout inverts that: a card is one line
 * with its value ellipsized, and opening it is the deliberate act. So the set
 * now records which cards are OPEN.
 *
 * The storage key had to change with it. A v1 entry means "this reader
 * collapsed this card"; read under v2 it would mean "this reader expanded this
 * card" — precisely backwards, and silently so, on exactly the cards somebody
 * had bothered to put away. A new key lets the old value be ignored rather than
 * misread.
 *
 * ── WHY LOCAL, AND NOT A COLUMN ─────────────────────────────────────────────
 * Openness is a VIEW preference, not content: a phone and a desktop can
 * reasonably disagree about whether the build card is worth its full height
 * right now, and neither answer should overwrite the other. Same localStorage
 * scope the nav tree's expansion, settings and last-visited already use.
 *
 * Keyed on tab + NAME, not on the card's row id. `TabCardStore.set` upserts on
 * (tab_id, name), so the name is the card's identity across every rewrite; the
 * id survives an update but not a clear-and-recreate, which would silently
 * reset a card the reader had opened.
 */
const KEY = 'muxpad.cardOpen.v2';

/** tabId/name -> open. Only EXPLICIT opens are stored; the default is the
 *  compact row, because that is the whole point of the layout. */
export type CardOpenState = Record<string, boolean>;

export function cardKey(tabId: string, name: string): string {
  return `${tabId}/${name}`;
}

export function isCardOpen(
  state: CardOpenState,
  tabId: string | null | undefined,
  name: string,
): boolean {
  if (!tabId) return false;
  return state[cardKey(tabId, name)] === true;
}

function read(): CardOpenState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: CardOpenState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Only `true` is worth keeping — `false` is the default, and storing it
      // would grow this forever with every card anyone ever closed again.
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

let current: CardOpenState = typeof window === 'undefined' ? {} : read();
const listeners = new Set<(s: CardOpenState) => void>();

export function toggleCardOpen(tabId: string, name: string): void {
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

export function useCardOpen(): CardOpenState {
  const [state, setState] = useState<CardOpenState>(current);
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
export function __reloadCardOpen(): void {
  listeners.clear();
  current = read();
}
