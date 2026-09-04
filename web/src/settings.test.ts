import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DARK_THEMES,
  DARK_THEME_CHOICES,
  LIGHT_THEME_CHOICES,
  type Settings,
  THEMES,
  type Theme,
  resolveTheme,
  updateSettings,
} from './settings';

/** A Settings value for the pure resolver; only the theme fields matter. */
const withTheme = (over: Partial<Settings>): Settings =>
  ({
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, monospace',
    theme: 'acme',
    followSystem: false,
    themeLight: 'acme',
    themeDark: 'acme-dark',
    sidebarWidth: 280,
    ...over,
  }) as Settings;

describe('settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists updates to localStorage', () => {
    updateSettings({ theme: 'dracula', fontSize: 18 });
    const raw = localStorage.getItem('muxpad.settings.v1');
    expect(raw).toContain('"theme":"dracula"');
    expect(raw).toContain('"fontSize":18');
  });

  it('round-trips settings through localStorage', async () => {
    updateSettings({ theme: 'dracula', fontSize: 18 });
    vi.resetModules();
    // re-import after seeding localStorage so module-init's read() runs against the seeded blob
    const { getSettings: get } = await import('./settings');
    const s = get();
    expect(s.theme).toBe('dracula');
    expect(s.fontSize).toBe(18);
  });

  it('migrates retired theme ids to their replacement', async () => {
    localStorage.setItem('muxpad.settings.v1', JSON.stringify({ theme: 'nord' }));
    vi.resetModules();
    const { getSettings: get } = await import('./settings');
    expect(get().theme).toBe('tokyo-night');
  });

  it('falls back to defaults for an unknown theme', async () => {
    localStorage.setItem('muxpad.settings.v1', JSON.stringify({ theme: 'not-a-theme' }));
    vi.resetModules();
    const { getSettings: get } = await import('./settings');
    expect(get().theme).toBe('acme');
  });

  it('back-fills defaults when older settings lack a key', async () => {
    localStorage.setItem('muxpad.settings.v1', JSON.stringify({ theme: 'dracula' }));
    vi.resetModules();
    const { getSettings: get } = await import('./settings');
    const s = get();
    expect(s.theme).toBe('dracula');
    expect(s.fontSize).toBe(14);
    expect(s.fontFamily).toBe('Menlo, Monaco, monospace');
  });

  it('falls back to defaults for a corrupt localStorage blob', async () => {
    localStorage.setItem('muxpad.settings.v1', '{not json');
    vi.resetModules();
    const { getSettings: get } = await import('./settings');
    expect(get()).toEqual({
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, monospace',
      theme: 'acme',
      followSystem: false,
      themeLight: 'acme',
      themeDark: 'acme-dark',
      sidebarWidth: 280,
    });
  });
});

describe('following the system light/dark setting', () => {
  it('ignores the system while followSystem is off', () => {
    const s = withTheme({ theme: 'dracula', followSystem: false });
    expect(resolveTheme(s, true)).toBe('dracula');
    expect(resolveTheme(s, false)).toBe('dracula');
  });

  it('picks the side of the pair the OS is asking for', () => {
    const s = withTheme({
      theme: 'dracula',
      followSystem: true,
      themeLight: 'github-light',
      themeDark: 'tokyo-night',
    });
    expect(resolveTheme(s, true)).toBe('tokyo-night');
    expect(resolveTheme(s, false)).toBe('github-light');
    // The fixed `theme` is RETAINED, not overwritten, so unticking the box
    // returns you to what you had rather than to whichever side last painted.
    expect(s.theme).toBe('dracula');
  });

  it('classifies every theme as exactly one of light or dark', () => {
    // Missing from both lists = unreachable in the paired pickers; in both =
    // offered twice. Either way the picker lies about what is available.
    for (const t of THEMES) {
      const inLight = LIGHT_THEME_CHOICES.some((c) => c.value === t.value);
      const inDark = DARK_THEME_CHOICES.some((c) => c.value === t.value);
      expect(inLight !== inDark).toBe(true);
    }
    expect(DARK_THEME_CHOICES.length).toBeGreaterThan(0);
    expect(LIGHT_THEME_CHOICES.length).toBeGreaterThan(0);
  });

  it('rejects a stored theme that is wrong for its slot', async () => {
    // A themeDark of 'acme' would paint a cream UI at midnight — precisely
    // what this feature exists to prevent. Validation is on READ, so a
    // hand-edited or downgraded localStorage cannot produce it.
    localStorage.setItem(
      'muxpad.settings.v1',
      JSON.stringify({ followSystem: true, themeDark: 'acme', themeLight: 'tokyo-night' }),
    );
    vi.resetModules();
    const fresh = await import('./settings');
    const s = fresh.getSettings();
    expect(fresh.DARK_THEMES.has(s.themeDark)).toBe(true);
    expect(DARK_THEMES.has(s.themeLight)).toBe(false);
  });
});
