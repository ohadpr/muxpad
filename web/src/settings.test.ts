import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSettings } from './settings';

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
    expect(get().theme).toBe('trayo');
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
      theme: 'trayo',
      sidebarWidth: 240,
    });
  });
});
