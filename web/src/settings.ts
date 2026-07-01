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

// Where the workspace/tab navigator lives on desktop. 'top' is the
// classic WorkspaceSwitcher + TabBar chrome; 'sidebar' replaces both
// with a persistent left NavTree. Mobile ignores this (always the
// drop-down panel tree).
export type NavLayout = 'top' | 'sidebar';

export interface Settings {
  fontSize: number;
  fontFamily: string;
  theme: Theme;
  navLayout: NavLayout;
  // Persisted width of the desktop sidebar (sidebar nav layout only). The
  // upper bound is enforced live while dragging (never wider than the longest
  // tab name + its status/close icon needs); this stored value is only
  // sanity-clamped on read.
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
  navLayout: 'top',
  sidebarWidth: 240,
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
      navLayout: parsed.navLayout === 'sidebar' ? 'sidebar' : DEFAULTS.navLayout,
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
  for (const fn of listeners) fn(current);
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
