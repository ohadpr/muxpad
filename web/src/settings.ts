import { useEffect, useState } from 'react';

export type Theme =
  | 'tokyo-night'
  | 'dracula'
  | 'alucard'
  | 'github-light'
  | 'acme'
  | 'acme-dark';

/** What the picker offers: a theme, or "whatever the OS is doing". */
export type ThemeChoice = Theme | 'system';

/**
 * The pair "System" resolves to. Fixed rather than configurable: two extra
 * pickers to express a preference almost nobody holds is a worse trade than
 * one obvious entry in one list, and Dracula is the only theme here that has a
 * real light counterpart built to match it.
 */
export const SYSTEM_PAIR = { light: 'alucard', dark: 'dracula' } as const;

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'alucard', label: 'Alucard (Dracula Light)' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'acme', label: 'Acme' },
  { value: 'acme-dark', label: 'Acme Dark' },
];

const VALID_THEMES = new Set<Theme>(THEMES.map((t) => t.value));

/** The picker's options: System first, because it is the recommended default. */
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System (Dracula / Alucard)' },
  ...THEMES,
];

/** The media query the OS answers. One string, so the listener and the read
 *  can never drift apart. */
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * The theme actually painted, given the choice and what the OS reports.
 * Pure, so the resolution rule is testable without a DOM.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice !== 'system') return choice;
  return prefersDark ? SYSTEM_PAIR.dark : SYSTEM_PAIR.light;
}

// Old theme ids that no longer exist — migrate to the closest replacement.
const THEME_ALIASES: Record<string, Theme> = {
  dark: 'tokyo-night',
  'one-dark': 'tokyo-night',
  'soft-dark': 'tokyo-night',
  nord: 'tokyo-night',
  light: 'github-light',
  'solarized-light': 'github-light',
  'solarized-dark': 'tokyo-night',
  latte: 'github-light',
};

export interface Settings {
  fontSize: number;
  theme: ThemeChoice;
  // Persisted width of the desktop sidebar. The upper bound is enforced live
  // while dragging (never wider than the longest tab name + its status/close
  // icon needs); this stored value is only sanity-clamped on read.
  //
  // The DEFAULT is 280, raised from 240 when the rail gained a second line and
  // a meta column. Measured on the worst-case row (one carrying a schedule):
  // icon 30 + meta 79 + rail 30 leaves the name 74px at 240px, and a
  // 14-character name needs 96px in the nav font — which is why "Reading List"
  // rendered as "Reading …". At 280 the same row gives the name 114px, and a
  // row without a schedule gets 193px. Still narrower than the 330px rail the
  // design was approved against. Users who dragged their own width keep it;
  // this only moves the starting point.
  sidebarWidth: number;
}

// Hard floor/ceiling for the stored sidebar width. The *useful* max while
// dragging is computed from content; these just keep a corrupt localStorage
// value from producing an unusable rail.
export const SIDENAV_MIN_WIDTH = 160;
export const SIDENAV_MAX_WIDTH = 640;

const DEFAULTS: Settings = {
  fontSize: 14,
  // System by default: it is the option most people want, and it is the one
  // pair in this list built to be flipped between.
  theme: 'system',
  sidebarWidth: 280,
};

const KEY = 'muxpad.settings.v1';
const LEGACY_KEY = 'webagents.settings.v1';


/**
 * Resolve the stored theme choice, migrating the two shapes that came before.
 *
 * The system preference briefly shipped as a `followSystem` flag plus a chosen
 * theme per side. That is gone — it was two extra controls for a preference
 * almost nobody holds — so an install carrying the flag becomes plain
 * 'system', and its per-side picks are dropped rather than honoured: keeping
 * them would mean keeping the machinery that read them.
 */
function readChoice(parsed: Partial<Settings> & { followSystem?: unknown }): ThemeChoice {
  if (parsed.followSystem === true) return 'system';
  const raw = parsed.theme;
  if (raw === 'system') return 'system';
  if (typeof raw !== 'string') return DEFAULTS.theme;
  if (VALID_THEMES.has(raw as Theme)) return raw as Theme;
  if (raw in THEME_ALIASES) return THEME_ALIASES[raw] as Theme;
  // Unknown id — the default, which is 'system'.
  return DEFAULTS.theme;
}

function read(): Settings {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      // One-time migration from the pre-rename key. Copy then clear so old
      // installs don't fight a future schema bump.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(KEY, legacy);
        localStorage.removeItem(LEGACY_KEY);
        raw = legacy;
      }
    }
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : DEFAULTS.fontSize,
      theme: readChoice(parsed),
      sidebarWidth:
        typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
          ? Math.min(SIDENAV_MAX_WIDTH, Math.max(SIDENAV_MIN_WIDTH, parsed.sidebarWidth))
          : DEFAULTS.sidebarWidth,
    };
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<(s: Settings) => void>();

let current: Settings = typeof window === 'undefined' ? DEFAULTS : read();

function applyToDocument(s: Settings) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolveTheme(s.theme, systemPrefersDark());
}

/**
 * Repaint when the OS flips, without a reload. Registered once at module load
 * rather than per-component: the theme is a document-level fact, and a
 * component-scoped listener would stop working the moment that component
 * unmounted (the settings popover is mounted only while open).
 *
 * Listeners are notified too, so anything reading `useSettings` re-renders —
 * XtermPane rebuilds its terminal palette from the resolved theme.
 */
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia(DARK_QUERY);
  const onFlip = () => {
    if (current.theme !== 'system') return;
    applyToDocument(current);
    for (const fn of listeners) fn({ ...current });
  };
  if (mq.addEventListener) mq.addEventListener('change', onFlip);
  else mq.addListener?.(onFlip); // Safari < 14
}

if (typeof window !== 'undefined') {
  applyToDocument(current);
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  applyToDocument(current);
  for (const fn of listeners) fn(current);
}

/**
 * The terminal font. Not a setting.
 *
 * It was a five-way picker backed by three self-hosted webfont families —
 * ~25 KB of render-blocking CSS (36 faces x unicode-range) lazily imported,
 * plus a document.fonts round trip that terminal startup had to await before
 * xterm could measure a cell, or it would measure Menlo and re-measure
 * (garbled) when the real font swapped in. Menlo is a system font on every
 * platform muxpad runs on, so choosing it removes the chunk, the await and
 * the re-measure entirely.
 */
export const TERMINAL_FONT = 'Menlo, Monaco, monospace';

export function useResolvedTheme(): Theme {
  const s = useSettings();
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(DARK_QUERY);
    const onFlip = () => setPrefersDark(mq.matches);
    onFlip(); // the OS may have flipped between first render and this effect
    if (mq.addEventListener) {
      mq.addEventListener('change', onFlip);
      return () => mq.removeEventListener('change', onFlip);
    }
    mq.addListener?.(onFlip);
    return () => mq.removeListener?.(onFlip);
  }, []);
  return resolveTheme(s.theme, prefersDark);
}

export function useSettings(): Settings {
  const [state, setState] = useState<Settings>(current);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
