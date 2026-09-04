import { useEffect, useState } from 'react';

export type Theme =
  | 'tokyo-night'
  | 'dracula'
  | 'alucard'
  | 'github-light'
  | 'acme'
  | 'acme-dark';

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'alucard', label: 'Alucard (Dracula Light)' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'acme', label: 'Acme' },
  { value: 'acme-dark', label: 'Acme Dark' },
];

const VALID_THEMES = new Set<Theme>(THEMES.map((t) => t.value));

/**
 * Which themes are dark. Needed because "follow the system" cannot be a theme
 * id: with five themes and no 1:1 pairing (acme has acme-dark, but dracula and
 * tokyo-night have no light counterpart), any fixed pair would be arbitrary —
 * a dracula user would be handed GitHub Light at sunrise. So the preference is
 * a separate flag plus a chosen theme for each side.
 */
export const DARK_THEMES = new Set<Theme>(['tokyo-night', 'dracula', 'acme-dark']);

export const LIGHT_THEME_CHOICES = THEMES.filter((t) => !DARK_THEMES.has(t.value));
export const DARK_THEME_CHOICES = THEMES.filter((t) => DARK_THEMES.has(t.value));

/** The media query the OS answers. One string, so the listener and the read
 *  can never drift apart. */
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * The theme actually painted, given the settings and what the OS reports.
 * Pure, so the resolution rule is testable without a DOM.
 */
export function resolveTheme(s: Settings, prefersDark: boolean): Theme {
  if (!s.followSystem) return s.theme;
  return prefersDark ? s.themeDark : s.themeLight;
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
  fontFamily: string;
  theme: Theme;
  /** Follow the OS light/dark setting instead of the fixed `theme`. */
  followSystem: boolean;
  /** Used while following the system and it reports light. */
  themeLight: Theme;
  /** Used while following the system and it reports dark. */
  themeDark: Theme;
  /**
   * Which generation of the system-matching PAIR defaults this install has
   * seen. The pair shipped for one release defaulting to Acme/Acme Dark before
   * moving to Dracula/Alucard; without this marker the stored Acme pair would
   * outrank the new default forever, and a fresh install and a day-old one
   * would follow the system differently. Bumping it re-homes only an
   * untouched pair — see read().
   */
  themePairV: number;
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
  fontFamily: 'Menlo, Monaco, monospace',
  theme: 'acme',
  // Off by default: an existing install has a theme it chose deliberately, and
  // silently starting to repaint it at sunset would be a surprise, not a
  // feature.
  followSystem: false,
  // The system-matching pair is Dracula and its own light counterpart, so a
  // sunrise flip reads as the same theme in daylight rather than as a
  // different product.
  themeLight: 'alucard',
  themeDark: 'dracula',
  themePairV: 2,
  sidebarWidth: 280,
};

const KEY = 'muxpad.settings.v1';
const LEGACY_KEY = 'webagents.settings.v1';

/**
 * Parse a stored theme id, honouring the alias table. `ok` additionally rejects
 * a valid theme that is wrong for its SLOT — a stored themeDark of 'acme'
 * would otherwise paint a cream UI at midnight, which is the one thing the
 * whole feature exists to avoid.
 */
function readTheme(raw: unknown, fallback: Theme, ok?: (t: Theme) => boolean): Theme {
  if (typeof raw !== 'string') return fallback;
  const t = VALID_THEMES.has(raw as Theme)
    ? (raw as Theme)
    : raw in THEME_ALIASES
      ? (THEME_ALIASES[raw] as Theme)
      : null;
  if (t === null) return fallback;
  return ok && !ok(t) ? fallback : t;
}

/** The v1 pair defaults, kept only so the migration can recognise an
 *  untouched one. Never used as a value. */
const PAIR_V1 = { themeLight: 'acme' as Theme, themeDark: 'acme-dark' as Theme };

/**
 * Resolve the system-matching pair, migrating an install that never chose one.
 *
 * Only an UNTOUCHED v1 pair is re-homed: if the stored values still match the
 * old defaults exactly, they are a default rather than a decision, so they move
 * to the new one. Anything else the user actually picked is kept, which is why
 * this cannot simply overwrite on version bump.
 */
function pairFor(parsed: Partial<Settings>): {
  themeLight: Theme;
  themeDark: Theme;
  themePairV: number;
} {
  const light = readTheme(parsed.themeLight, DEFAULTS.themeLight, (t) => !DARK_THEMES.has(t));
  const dark = readTheme(parsed.themeDark, DEFAULTS.themeDark, (t) => DARK_THEMES.has(t));
  const seen = typeof parsed.themePairV === 'number' ? parsed.themePairV : 1;
  if (seen < 2 && light === PAIR_V1.themeLight && dark === PAIR_V1.themeDark) {
    return { themeLight: DEFAULTS.themeLight, themeDark: DEFAULTS.themeDark, themePairV: 2 };
  }
  return { themeLight: light, themeDark: dark, themePairV: 2 };
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
      fontFamily: typeof parsed.fontFamily === 'string' ? parsed.fontFamily : DEFAULTS.fontFamily,
      theme: readTheme(parsed.theme, DEFAULTS.theme),
      followSystem: parsed.followSystem === true,
      ...pairFor(parsed),
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
  document.documentElement.dataset.theme = resolveTheme(s, systemPrefersDark());
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
    if (!current.followSystem) return;
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
  void ensureTerminalFonts(current.fontFamily);
  for (const fn of listeners) fn(current);
}

/**
 * The terminal-font families that need a webfont downloaded. Menlo is a system
 * font on every platform muxpad runs on, and MesloLGS NF is declared eagerly
 * in fonts.css, so neither is here.
 */
const WEBFONT_FAMILIES = new Set([
  '"JetBrains Mono", Menlo, monospace',
  '"Fira Code", Menlo, monospace',
  '"IBM Plex Mono", Menlo, monospace',
]);

let terminalFontsChunk: Promise<unknown> | null = null;

/**
 * Pull in the terminal-font @font-face declarations, once, and only if the
 * selected family actually needs them. They are ~25 KB of render-blocking CSS
 * (36 faces × unicode-range) that the default install never uses — see
 * terminal-fonts.css.
 *
 * Resolves when the stylesheet is applied, so callers that measure glyphs
 * (XtermPane, which sizes its grid from the font) can wait for the
 * declarations to exist before asking document.fonts to load them. Awaiting a
 * family we don't ship resolves immediately.
 */
export function ensureTerminalFonts(family: string): Promise<unknown> {
  if (!WEBFONT_FAMILIES.has(family)) return Promise.resolve();
  terminalFontsChunk ??= import('./terminal-fonts.css').catch(() => {
    // Chunk fetch failed (offline, mid-deploy). The family falls back to
    // Menlo; a later load retries because we keep no failed promise.
    terminalFontsChunk = null;
  });
  return terminalFontsChunk;
}

// Start the fetch at boot for someone who already picked one of these, so the
// stylesheet is usually in place before the first XtermPane measures anything.
if (typeof window !== 'undefined') void ensureTerminalFonts(current.fontFamily);

/**
 * The theme actually painted right now — `settings.theme`, or whichever side of
 * the pair the OS is asking for.
 *
 * Anything that derives COLOUR must use this rather than `settings.theme`.
 * XtermPane builds its terminal palette here, and keying that effect on
 * `settings.theme` would leave terminals on the old palette after a system
 * flip: the stored theme did not change, only the resolution did.
 */
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
  return resolveTheme(s, prefersDark);
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

// Curated list — visually distinct fonts only. Dropped near-duplicates of
// Menlo (SF Mono, System UI Mono, Source Code Pro) since at body sizes they
// look near-identical.
export const FONT_FAMILIES = [
  'Menlo, Monaco, monospace',
  '"MesloLGS NF", Menlo, monospace',
  '"JetBrains Mono", Menlo, monospace',
  '"Fira Code", Menlo, monospace',
  '"IBM Plex Mono", Menlo, monospace',
];

export const FONT_FAMILY_LABELS: Record<string, string> = {
  'Menlo, Monaco, monospace': 'Menlo (default)',
  '"MesloLGS NF", Menlo, monospace': 'MesloLGS Nerd Font',
  '"JetBrains Mono", Menlo, monospace': 'JetBrains Mono',
  '"Fira Code", Menlo, monospace': 'Fira Code',
  '"IBM Plex Mono", Menlo, monospace': 'IBM Plex Mono',
};
