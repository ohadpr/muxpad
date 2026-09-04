import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYSTEM_PAIR,
  THEME_CHOICES,
  resolveTheme,
  updateSettings,
} from './settings';

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
    expect(get().theme).toBe('system');
  });

  it('back-fills defaults when older settings lack a key', async () => {
    localStorage.setItem('muxpad.settings.v1', JSON.stringify({ theme: 'dracula' }));
    vi.resetModules();
    const { getSettings: get } = await import('./settings');
    const s = get();
    expect(s.theme).toBe('dracula');
    expect(s.fontSize).toBe(14);
  });

  it('falls back to defaults for a corrupt localStorage blob', async () => {
    localStorage.setItem('muxpad.settings.v1', '{not json');
    vi.resetModules();
    const { getSettings: get } = await import('./settings');
    expect(get()).toEqual({
      fontSize: 14,
      theme: 'system',
      sidebarWidth: 280,
    });
  });
});

describe('the System theme option', () => {
  it('resolves to the Dracula pair, and only when chosen', () => {
    expect(resolveTheme('system', true)).toBe(SYSTEM_PAIR.dark);
    expect(resolveTheme('system', false)).toBe(SYSTEM_PAIR.light);
    expect(SYSTEM_PAIR.dark).toBe('dracula');
    expect(SYSTEM_PAIR.light).toBe('alucard');
  });

  it('leaves an explicit theme alone whatever the OS says', () => {
    expect(resolveTheme('dracula', false)).toBe('dracula');
    expect(resolveTheme('acme', true)).toBe('acme');
  });

  it('offers System first in the picker, then every real theme', () => {
    expect(THEME_CHOICES[0]?.value).toBe('system');
    expect(THEME_CHOICES.filter((c) => c.value === 'system')).toHaveLength(1);
    for (const t of ['dracula', 'alucard', 'acme', 'acme-dark', 'tokyo-night', 'github-light']) {
      expect(THEME_CHOICES.some((c) => c.value === t)).toBe(true);
    }
  });

  it('defaults to System', async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import('./settings');
    expect(fresh.getSettings().theme).toBe('system');
  });

  it('migrates the retired followSystem flag to the System choice', async () => {
    // It shipped briefly as a flag plus a theme per side. An install carrying
    // it must land on 'system', not on whichever side was stored.
    localStorage.setItem(
      'muxpad.settings.v1',
      JSON.stringify({ followSystem: true, themeLight: 'acme', themeDark: 'acme-dark' }),
    );
    vi.resetModules();
    const fresh = await import('./settings');
    expect(fresh.getSettings().theme).toBe('system');
  });

  it('keeps an explicit theme from before the flag existed', async () => {
    localStorage.setItem('muxpad.settings.v1', JSON.stringify({ theme: 'tokyo-night' }));
    vi.resetModules();
    const fresh = await import('./settings');
    expect(fresh.getSettings().theme).toBe('tokyo-night');
  });
});
