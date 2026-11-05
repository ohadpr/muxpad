import { describe, expect, it } from 'vitest';
import { setServerTheme, themeInForce } from './settings';

/**
 * ── THE PICKER HAS TO ASK THE SAME QUESTION THE PAINTER DOES ─────────────
 *
 * `applyToDocument` paints `themeInForce(s)` — the INSTALL's theme if one is
 * stored, otherwise this browser's own default. The picker's selection ring
 * once read `settings.theme` directly while a pick wrote the other value, so
 * the two disagreed by construction: the window repainted and the ring stayed
 * put. Every theme looked unselectable ("memphis is not selectable"), and a
 * browser confirmed the pick itself had worked all along.
 *
 * The override used to be the CHAT's, which is why it moved: switching chats
 * repainted the whole window, rail included. It is one value for the install
 * now, pushed to every open window (lib/app-theme).
 */
describe('the theme in force', () => {
  it('is the install’s when one is stored', () => {
    setServerTheme('memphis');
    expect(themeInForce({ theme: 'system' } as never)).toBe('memphis');
  });

  it('falls back to this browser’s default when nothing is stored', () => {
    setServerTheme(null);
    expect(themeInForce({ theme: 'riso' } as never)).toBe('riso');
  });

  it('is what a pick changes, so the ring follows the press', () => {
    setServerTheme(null);
    const device = { theme: 'system' } as never;
    expect(themeInForce(device)).toBe('system');
    setServerTheme('memphis');
    expect(themeInForce(device)).toBe('memphis');
    setServerTheme(null);
  });
});

describe('both pickers read the theme in force', () => {
  it('passes it in at both call sites, not the local default', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const here = join(import.meta.dirname, 'components');
    for (const f of ['SettingsMenu.tsx', 'ThemeSwitch.tsx']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src, `${f} still passes the local default`).not.toMatch(
        /<ThemePicker chosen=\{settings\.theme\}/,
      );
      expect(src).toMatch(/<ThemePicker chosen=\{themeInForce\(settings\)\}/);
    }
  });

  it('offers no per-chat control any more', async () => {
    // One value for the install: there is nothing to override and so nothing
    // to hand back. The button cleared a chat's theme and promoted it to the
    // device default — two concepts that are now one.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, 'components', 'SettingsMenu.tsx'), 'utf8');
    expect(src).not.toMatch(/Use for every chat/);
    expect(src).not.toMatch(/patchTab\([^)]*theme/);
  });
});
