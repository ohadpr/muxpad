import { useEffect, useState } from 'react';

export type Theme = 'tokyo-night' | 'dracula' | 'github-light' | 'acme' | 'acme-dark';

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'acme', label: 'Acme' },
  { value: 'acme-dark', label: 'Acme Dark' },
];

const VALID_THEMES = new Set<Theme>(THEMES.map((t) => t.value));

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
  sidebarWidth: 280,
};

const KEY = 'muxpad.settings.v1';
const LEGACY_KEY = 'webagents.settings.v1';

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
      theme: ((): Theme => {
        const t = parsed.theme;
        if (typeof t !== 'string') return DEFAULTS.theme;
        if (VALID_THEMES.has(t as Theme)) return t as Theme;
        if (t in THEME_ALIASES) return THEME_ALIASES[t] as Theme;
        return DEFAULTS.theme;
      })(),
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
  document.documentElement.dataset.theme = s.theme;
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
