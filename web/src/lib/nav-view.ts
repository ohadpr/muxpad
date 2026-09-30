import { useEffect, useState } from 'react';

/**
 * WHICH LIST the navigator is showing, per surface.
 *
 *   'recent'  ONE flat list of every chat in every visible workspace, ordered
 *             by when YOU last touched it (shared/tab-order `userTouchAt`).
 *             The DEFAULT. It answers "what was I just doing", which is the
 *             question you have when you open a navigator, and it is the only
 *             shape that can answer it without you first naming a workspace.
 *   'spaces'  today's surface, exactly and unchanged: the desktop rail's
 *             collapsible workspace tree, and the sheet's one-workspace list
 *             with its picker. It answers "show me everything in THAT
 *             workspace", including one that has been cold for ten days and
 *             that no recency order can ever surface.
 *
 * The two are not substitutes and that is why there is a toggle rather than a
 * replacement: on the live cockpit the global top eight held six Personal
 * chats, two Trayo and ZERO Trayobot, whose freshest activity was ten days
 * old. A recency list cannot reach a cold workspace at any depth. 'spaces'
 * is how you get there, and it is one tap.
 *
 * ── PER DEVICE, AND STICKY, AND PER SURFACE ──────────────────────────────────
 * PER DEVICE (localStorage, like every other nav preference here — see
 * nav-expansion, last-visited, settings) rather than synced to the server.
 * This is a property of the surface you are LOOKING at, not of your data: the
 * phone is a jump-back-to-what-I-was-doing device and the desktop rail is a
 * browse-and-organise one, and syncing would let a tap on the phone silently
 * re-shape the rail on the machine you are not sitting at. It also needs no
 * round trip, so the toggle lands on the frame you tapped it.
 *
 * STICKY, which is what makes the cold-workspace answer honest. Flipping to
 * 'spaces' to reach Trayobot costs one tap ONCE; if the choice reset on every
 * open, a cold workspace would cost a tap more than it does today, every time.
 *
 * PER SURFACE (`sheet` and `sidebar` keep independent values) for the same
 * reason those two components forked in the first place: they are different
 * shapes with different jobs, and one stored value would make choosing on one
 * of them a decision about the other.
 */
export type NavView = 'recent' | 'spaces';

export type NavSurface = 'sheet' | 'sidebar';

/**
 * 'spaces' — REVERTED FROM 'recent' after living with it.
 *
 * The flat view's argument was that "what was I just doing" is the question you
 * have when you open a navigator, and that it is the only shape that answers it
 * without you naming a workspace first. Both still true. What it missed is what
 * the list LOOKS like once it succeeds: the user's verdict after a day was
 * "sorting by recent is a big mess", and the screenshot says why — twelve rows,
 * eight of them trailing the word `Personal`, because a cross-workspace list has
 * to name a workspace on every row and most rows are from the same one.
 *
 * So the grouping does the work the label was doing, for free and in one place:
 * a workspace heading says where its rows live once, and recency sorts WITHIN
 * it. The flat view stays one tap away for the cold-workspace case it was right
 * about; it is just not what you land on.
 */
export const DEFAULT_NAV_VIEW: NavView = 'spaces';

/**
 * v2 — the default flipped, and a stored `recent` from v1 would outrank it.
 *
 * Bumping the key drops every device back to the new default once. That is the
 * point rather than a side effect: v1's value was written by a default nobody
 * chose, so honouring it would leave the surface exactly as reported. Anyone who
 * genuinely prefers the flat view is one tap from it, and this time the stored
 * value means they picked it.
 */
const KEY = 'muxpad.navView.v2';

type State = Partial<Record<NavSurface, NavView>>;

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: State = {};
    for (const surface of ['sheet', 'sidebar'] as const) {
      const v = (parsed as Record<string, unknown>)[surface];
      // Anything else — a value from a future spelling, a hand-edited key — is
      // dropped rather than coerced, so an unknown view can never render as a
      // blank list. The default below is always a real surface.
      if (v === 'recent' || v === 'spaces') out[surface] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let current: State = typeof window === 'undefined' ? {} : read();
const listeners = new Set<(s: State) => void>();

export function viewOf(state: State, surface: NavSurface): NavView {
  return state[surface] ?? DEFAULT_NAV_VIEW;
}

export function setNavView(surface: NavSurface, view: NavView): void {
  current = { ...current, [surface]: view };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Quota, private mode, a locked-down profile — best-effort, exactly as
    // nav-expansion treats it. The in-memory state below still updated, so the
    // toggle works for this session and simply does not survive a reload.
  }
  for (const fn of listeners) fn(current);
}

export function useNavView(surface: NavSurface): [NavView, (v: NavView) => void] {
  const [state, setState] = useState<State>(current);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return [viewOf(state, surface), (v: NavView) => setNavView(surface, v)];
}

/** Test seam — drops the stored choice and every subscriber. */
export function resetNavView(): void {
  current = {};
  listeners.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
