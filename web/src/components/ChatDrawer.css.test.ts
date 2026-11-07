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

describe('the row is one line, and the mark is beside the name', () => {
  // Reported with a screenshot: twelve rows filled a phone, each carrying a
  // name over a four-character age, with a 6px dot marooned in a 24px column.
  it('lays the row out in one line, with the age trailing', () => {
    const row = rule('.chat-drawer__row-text');
    expect(row).toMatch(/align-items:\s*baseline/);
    // NOT a column: that is what made every row two lines tall.
    expect(row).not.toMatch(/flex-direction:\s*column/);
    const sub = rule('.chat-drawer__row-sub');
    expect(sub).toMatch(/margin-inline-start:\s*auto/);
    // The name keeps the slack and truncates first; four characters of age is
    // never the thing to drop.
    expect(sub).toMatch(/flex:\s*0 0 auto/);
    expect(sub).toMatch(/white-space:\s*nowrap/);
  });

  it('runs the scale from FILLED to plain grey, not down one alpha ramp', () => {
    // Four shades of the same accent is not a scale you can read: the steps
    // sit a few percent of saturation apart and the bottom of the list looks
    // like the top with the lights down. The fade has to cross a boundary.
    const mark = rule('.chat-drawer__mark');
    expect(mark).toMatch(/width:\s*22px/);
    expect(mark).toMatch(/background:\s*var\(--mark-bg\)/);

    const bg = (h: number) =>
      rule(`.chat-drawer__block[data-heat='${h}']`).match(/--mark-bg:\s*([^;]+);/)?.[1] ?? '';
    // Running is SOLID accent — the only filled mark on the panel.
    expect(bg(3).trim()).toBe('var(--d-accent)');
    // The middle two are the accent mixed into the panel's own surface, so
    // they stay opaque and the steps stay even on a light theme.
    expect(bg(2)).toMatch(/var\(--d-accent\) 30%, var\(--d-surface\)/);
    expect(bg(1)).toMatch(/var\(--d-accent\) 14%, var\(--d-surface\)/);
    // And the oldest block has NO hue at all. The colour is the recency, so
    // none of it means none left.
    expect(bg(0)).not.toMatch(/--d-accent/);
    expect(bg(0)).toMatch(/--d-ink/);
  });

  it('gives the running block a wash of its own, so it reads as one thing', () => {
    expect(rule("[data-block='running'] .chat-drawer__list")).toMatch(
      /background:\s*color-mix\(in srgb, var\(--d-accent\) 7%/,
    );
  });

  it('draws the count as a pill, not a bare number', () => {
    // "YESTERDAY 10" inherits the heading's tracking and renders as "|0".
    const pill = rule('.chat-drawer__group-count');
    expect(pill).toMatch(/border-radius:\s*999px/);
    expect(pill).toMatch(/letter-spacing:\s*0/);
  });

  it('gives the list air — a list you read down, not a menu', () => {
    expect(rule('.chat-drawer__list')).toMatch(/gap:\s*4px/);
    expect(rule('.chat-drawer__row')).toMatch(/padding:\s*8px 9px/);
  });

  it('puts the running state in a word, in the accent', () => {
    const live = rule('.chat-drawer__row-live');
    expect(live).toMatch(/color:\s*var\(--d-accent\)/);
    expect(live).toMatch(/margin-inline-start:\s*auto/);
  });

  it('keeps the name as the thing that truncates', () => {
    expect(rule('.chat-drawer__row-name')).toMatch(/text-overflow:\s*ellipsis/);
  });
});
