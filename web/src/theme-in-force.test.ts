import { describe, expect, it } from 'vitest';
import { setChatTheme, themeInForce } from './settings';

/**
 * ── THE PICKER HAS TO ASK THE SAME QUESTION THE PAINTER DOES ─────────────
 *
 * `applyToDocument` paints `themeInForce(s)` — the chat's own theme if it has
 * one, otherwise the device default. The picker's selection ring read
 * `settings.theme`, the device default, while a pick made inside a chat
 * writes the CHAT's theme. So the two disagreed by construction: the window
 * repainted and the ring stayed put.
 *
 * Every theme therefore looked unselectable. It surfaced as "memphis is not
 * selectable" because that is the one somebody happened to try, and a browser
 * confirmed the pick itself worked all along — repaint, PATCH 200, no revert.
 */
describe('the theme in force', () => {
  it('is the chat’s own when it has one', () => {
    setChatTheme('memphis');
    expect(themeInForce({ theme: 'system' } as never)).toBe('memphis');
  });

  it('falls back to the device default when the chat has none', () => {
    setChatTheme(null);
    expect(themeInForce({ theme: 'riso' } as never)).toBe('riso');
  });

  it('is what a chat-level pick changes', () => {
    // The ring follows the pick rather than the setting underneath it, which
    // is the entire defect.
    setChatTheme(null);
    const device = { theme: 'system' } as never;
    expect(themeInForce(device)).toBe('system');
    setChatTheme('memphis');
    expect(themeInForce(device)).toBe('memphis');
    setChatTheme(null);
  });
});

/**
 * And the consequence that was worse than the cosmetic one: "Use for every
 * chat" saves `chosen`. With `chosen` stuck on the device default, pressing
 * it saved the value that was already the default and then cleared the pick
 * you had just made — the button did the opposite of its label, silently.
 */
describe('“Use for every chat” saves what is on screen', () => {
  it('passes the in-force theme into the picker at both call sites', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const here = join(import.meta.dirname, 'components');
    for (const f of ['SettingsMenu.tsx', 'ThemeSwitch.tsx']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src, `${f} still passes the device default`).not.toMatch(
        /<ThemePicker chosen=\{settings\.theme\}/,
      );
      expect(src).toMatch(/<ThemePicker chosen=\{themeInForce\(settings\)\}/);
    }
  });
});
