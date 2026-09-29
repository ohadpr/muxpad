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

export const DEFAULT_NAV_VIEW: NavView = 'recent';

const KEY = 'muxpad.navView.v1';

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
