import { useEffect, useState } from 'react';
import { api } from '../api';
import { subscribe } from '../events';
import { THEME_CHOICES, type ThemeChoice, setServerTheme } from '../settings';

/**
 * ONE THEME, FOR THE WHOLE INSTALL.
 *
 * ── WHAT THIS REPLACES, AND WHY ──────────────────────────────────────────
 * A theme was two facts at once: a device default in localStorage, and the
 * CHAT's own on `tabs.theme` so it would follow you between devices. The chat
 * won while you were in it — and because a theme defines the rail's palette as
 * well as the pane's, switching chats repainted the entire window.
 *
 * That was a coherent design and it is not the one that was wanted: "pick a
 * theme — all open muxpad windows change to that theme no matter what chat
 * they are on. no more theme-per-chat."
 *
 * So the theme is an INSTALL setting, stored server-side (PrefStore) and
 * pushed on the event bus. Which makes "all open windows" true for free, and
 * true across devices as well — the phone repaints too, which the per-chat
 * value only managed for the one chat you were standing in.
 *
 * ── THE FIRST PAINT IS NOT THIS FILE'S JOB ───────────────────────────────
 * It arrives in `/api/boot`, fired by an inline script before the bundle has
 * parsed (see routes/boot.ts). A hook could only repaint AFTER mount, which
 * is the flash this avoids. This keeps it in step afterwards.
 *
 * ── THREE SOURCES, ONE ORDER ─────────────────────────────────────────────
 * The theme now arrives from the boot snapshot, from a `prefs.updated` push,
 * and from a refetch after a reconnect — three asynchronous readers of one
 * value, which is the arrangement that produces a stale write. Observed
 * shapes, both real: the boot request answers slowly and overwrites a push
 * that landed while it was in flight; and a window that was asleep during the
 * push never hears about it at all, because the bus replays nothing.
 *
 * So every source goes through `applyTheme` with a mark taken when its value
 * was ASKED FOR, and an older ask can never overwrite a newer one. Issue
 * order, not arrival order — arrival order is precisely what is unreliable
 * here.
 *
 * A COUNTER, NOT A CLOCK. `performance.now()` would do the job and then fail
 * on the one case that must never fail: two values read inside the same
 * millisecond compare EQUAL, and "equal" has to resolve one way for a push
 * (it wins) and the other way for a snapshot (it loses). A counter gives every
 * read its own mark, so there is no tie to break.
 */

/** The mark of the freshest value applied so far. Boot is always the oldest
 *  source by construction — its request leaves before the bundle has parsed,
 *  so before any of this code could run — which is why it passes 0 instead of
 *  carrying a mark through the prefetch. */
let appliedAsOf = -1;
let marks = 0;

/** A mark for a value being read now. Unique and increasing. */
function mark(): number {
  marks += 1;
  return marks;
}

function applyTheme(raw: string | null | undefined, asOf: number): void {
  if (asOf < appliedAsOf) return;
  appliedAsOf = asOf;
  setServerTheme(readTheme(raw));
}

/**
 * A `prefs.updated` just arrived. Outranks every snapshot, and every snapshot
 * issued before it.
 *
 * Separate from the hook so the ordering can be tested without a mounted app —
 * the two bugs this guards against are both about which asynchronous reader
 * lands last, and neither needs React to reproduce.
 */
export function applyPushedTheme(raw: string | null | undefined): void {
  applyTheme(raw, mark());
}

/** The first paint's value, from the boot prefetch. Ignored if a push or a
 *  refetch has already landed — see the note above. */
export function applyBootTheme(raw: string | null | undefined): void {
  applyTheme(raw, 0);
}

/**
 * Ask the server what the theme is, and apply it if nothing newer has landed.
 *
 * Called on every reconnect. A push is the normal path and this is the gap it
 * cannot cover: `prefs.updated` is fire-and-forget, so a window whose socket
 * was down for the one second somebody picked a theme stays on the old palette
 * until it is reloaded — which, on a phone that has been in a pocket, is the
 * usual case rather than the rare one.
 *
 * Silent on failure. A theme that could not be refetched is not worth a
 * console, and the next reconnect will try again.
 */
export async function refreshAppTheme(): Promise<void> {
  const asOf = mark();
  try {
    const { prefs } = await api.prefs();
    applyTheme(prefs.theme, asOf);
  } catch {
    // The palette on screen stays; see above.
  }
}

/** A stored value, resolved against the themes this build actually has.
 *
 *  An unknown name reads as "nothing chosen" rather than as an error: the
 *  value was written by whichever client set it, and that client may be newer
 *  than this one (a theme added since) or older (one since renamed). Neither
 *  is worth a broken document. */
export function readTheme(raw: string | null | undefined): ThemeChoice | null {
  if (!raw) return null;
  return THEME_CHOICES.some((c) => c.value === raw) ? (raw as ThemeChoice) : null;
}

/**
 * Keep this window pointed at the install's theme.
 *
 * One subscription on the event bus, which every client already holds. A
 * `prefs.updated` carries the whole set — see the event's own note on why it
 * is not a key and a value.
 */
export function useAppTheme(): void {
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== 'prefs.updated') return;
        applyPushedTheme(e.prefs.theme);
      }),
    [],
  );
}

/**
 * The themes, for anything that renders the picker.
 *
 * Re-exported so a component needs one import for "the list and the current
 * value" rather than reaching into settings for one and here for the other.
 */
export function useThemeChoices(): typeof THEME_CHOICES {
  const [choices] = useState(THEME_CHOICES);
  return choices;
}
