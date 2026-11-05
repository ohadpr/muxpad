import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE DRAWER'S SURFACES, and the strip of chat behind it.
 *
 * Two reports, one sentence: "chat drawer looks bad fix colors maybe expose a
 * bit on left side so u can see chat behind."
 */

const CSS = readFileSync(join(__dirname, 'ChatDrawer.css'), 'utf8');
/** Comments contain the names of the tokens they explain being removed. */
const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel: string): string =>
  new RegExp(`${sel.replace(/[.[\]*]/g, '\\$&')}\\s*\\{[^}]*\\}`).exec(flat)?.[0] ?? '';

describe('it wears the CHAT’s palette, not the app’s', () => {
  it('takes every colour from a --chat-* token', () => {
    // The first version used `--bg-elev`, `--fg`, `--accent` and friends while
    // sitting INSIDE a chat pane, which rebinds all of them (ChatPane.css).
    // On a theme where the two differ that is the wrong surface under the
    // wrong ink — the same family of bug as the settings popover that painted
    // itself on the rail's purple while keeping the pane's dark ink.
    for (const t of ['--chat-panel', '--chat-fg', '--chat-border', '--chat-accent']) {
      expect(flat, t).toContain(t);
    }
  });

  it('uses the app’s tokens only as FALLBACKS', () => {
    // A drawer rendered outside a chat must still have colours; what it must
    // not do is PREFER the app's. So the shape to reject is `: var(--fg)` — a
    // declaration taking it as the value — and the shape to allow is
    // `, var(--fg)`, which is the fallback slot of a `--chat-*` lookup. The
    // first version of this regex matched both and flagged the fallbacks.
    for (const bare of ['--fg', '--border', '--accent', '--bg-hover', '--bg-elev']) {
      const direct = new RegExp(`:\\s*var\\(${bare}\\)`);
      expect(direct.test(flat), `${bare} taken directly`).toBe(false);
    }
    // …and the fallback form is present, which is what makes that meaningful.
    expect(flat).toMatch(/var\(--chat-fg,\s*var\(--fg\)\)/);
  });

  it('declares the palette on the CONTROL too, which lives outside the panel', () => {
    // The button is what opens the drawer, so it cannot be inside it — and a
    // token block on `.chat-drawer` alone did not reach it, so every colour on
    // the button resolved to nothing.
    expect(flat).toMatch(/\.chat-drawer,\s*\n?\.chat-drawer-open\s*\{[^}]*--d-surface/);
  });
});

describe('a strip of the chat stays visible', () => {
  it('never takes the full width, however narrow the pane', () => {
    // `min(420px, 100%)` gave a narrow pane a drawer covering the lot, with no
    // visual evidence the conversation was still there.
    const r = rule('.chat-drawer');
    expect(r).toMatch(/width:\s*min\(420px,\s*calc\(100% - var\(--d-peek\)\)\)/);
    expect(r).toMatch(/--d-peek:/);
  });

  it('is inset from the pane’s edges, with a radius and a real shadow', () => {
    // A card over the conversation, with the conversation around it on three
    // sides — which is also what makes the shadow legible, since a shadow
    // needs something to fall on.
    const r = rule('.chat-drawer');
    expect(r).toMatch(/inset-block:\s*8px/);
    expect(r).toMatch(/border-radius:/);
    expect(r).toMatch(/box-shadow:/);
  });
});
