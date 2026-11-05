import { useEffect, useState } from 'react';
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
 */

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
        setServerTheme(readTheme(e.prefs.theme));
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
