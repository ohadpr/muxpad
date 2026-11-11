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
/** Quotes in an attribute selector belong to the formatter, not to us: biome
 *  rewrites `'x'` to `"x"`, and a test that pins the quote is a test about
 *  biome. Callers may write either. */
const anyQuote = (sel: string) => sel.replace(/['"]/g, `['"]`);
const rule = (sel: string): string =>
  new RegExp(`${anyQuote(sel.replace(/[.[\]*]/g, '\\$&'))}\\s*\\{[^}]*\\}`).exec(flat)?.[0] ?? '';

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

  it('spends colour only where work is happening, and greys the rest', () => {
    // Four shades of the same accent is not a scale you can read: the steps
    // sit a few percent of saturation apart and the bottom of the list looks
    // like the top with the lights down. The fade has to cross a boundary.
    const mark = rule('.chat-drawer__mark');
    expect(mark).toMatch(/width:\s*22px/);
    expect(mark).toMatch(/background:\s*var\(--mark-bg\)/);

    const bg = (h: number) =>
      rule(`.chat-drawer__block[data-heat='${h}']`).match(/--mark-bg:\s*([^;]+);/)?.[1] ?? '';
    // RUNNING is the only block that spends any colour, and it spends it on a
    // ring and a glyph rather than a filled square — on a theme whose accent
    // is #d6006e, one filled square is all you see.
    expect(bg(3)).toMatch(/var\(--d-accent\) 15%, var\(--d-surface\)/);
    expect(rule(".chat-drawer__block[data-heat='3']")).toMatch(/--mark-ink:\s*var\(--d-accent\)/);
    // EVERY FINISHED BLOCK IS NEUTRAL. Colour on the sixteen rows that are
    // over is colour not available to the two that are not.
    for (const h of [2, 1, 0]) {
      expect(bg(h), `heat ${h}`).not.toMatch(/--d-accent/);
      expect(bg(h), `heat ${h}`).toMatch(/--d-ink/);
    }
    // …and they still step, so the list fades without being painted.
    const inks = [2, 1, 0].map((h) =>
      Number(rule(`.chat-drawer__block[data-heat='${h}']`).match(/--d-ink\) (\d+)%/)?.[1]),
    );
    expect(inks).toEqual([...inks].sort((a, b) => b - a));
    expect(new Set(inks).size).toBe(3);
  });

  it('gives the running block a wash of its own, so it reads as one thing', () => {
    expect(rule("[data-block='running'] .chat-drawer__list")).toMatch(
      /background:\s*color-mix\(in srgb, var\(--d-accent\) 5%/,
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

  it('puts the state in a LABEL, not another word in the row', () => {
    // It shipped as plain text at the row's own size and 153 rows of it read
    // as "word soup" — `done` competing with the name beside it. A plate, a
    // smaller size and uppercase tracking make it a mark the eye can skip.
    const live = rule('.chat-drawer__row-live');
    expect(live).toMatch(/border-radius:\s*999px/);
    expect(live).toMatch(/text-transform:\s*uppercase/);
    expect(live).toMatch(/background:\s*var\(--state-plate/);
    expect(live).toMatch(/margin-inline-start:\s*auto/);
    // PETITE. It shipped at 0.625rem/700 and read as a shouting label on a
    // row whose subject is the name beside it. Small, and light: a thing that
    // repeats 153 times must not be bold.
    expect(live).toMatch(/font-size:\s*0\.5625rem/);
    expect(live).toMatch(/font-weight:\s*500/);
  });

  it('keeps DONE the quiet one and the exceptions loud', () => {
    // Almost every row in a work log is done, so the common case is furniture
    // and the exceptions are the news. A label every row wears at full
    // strength cannot point at anything.
    const done = rule('.chat-drawer__row-live[data-state="delivered"]');
    const working = rule('.chat-drawer__row-live[data-state="working"]');
    expect(done).toContain('--status-ready');
    const pct = (r: string) => Number(/(\d+)%/.exec(r)?.[1] ?? 0);
    expect(pct(done), 'done must not be as loud as a running row').toBeLessThan(pct(working));
  });

  it('keeps the name as the thing that truncates', () => {
    expect(rule('.chat-drawer__row-name')).toMatch(/text-overflow:\s*ellipsis/);
  });
});

/**
 * MOTION IS THE PART THAT READS AS "RIGHT NOW".
 *
 * The closed drawer's button already turned accent-coloured with a count on
 * it — but that is a STATE, and it looks identical whether the workers are
 * running or merely sitting there open. Asked for directly: "when sub-chat is
 * working show some working indicator on the subchat drawer icon in the top
 * right."
 */
describe('the drawer says something is going on in there', () => {
  it('spins the BADGE, not the whole button', () => {
    // An orbiting ring around the control was the first answer and the wrong
    // one: "replace the '1' with a spinner don't spin the whole thing". The
    // badge is already the corner the eye checks.
    // A REAL BADGE: the filled dot stays, and the spinner is INSIDE it in
    // the badge's own ink — the iPhone shape, with motion where the number
    // goes. A hollow ring in place of the dot stopped looking like a badge.
    const dot = rule('.chat-drawer-open__count.-spinning');
    const spin = rule('.chat-drawer-open__count.-spinning::after');
    expect(dot, 'the badge is gone').not.toBe('');
    expect(spin, 'nothing spins inside the badge').not.toBe('');
    expect(spin).toMatch(/animation:\s*chat-drawer-spin/);
    expect(spin).toMatch(/border-top-color/);
    // The badge's ink, not a status hue: it sits ON the accent fill.
    expect(spin).toContain('--d-accent-ink');
    // The dot keeps its fill — it must not become a hollow ring.
    expect(dot).not.toMatch(/background:\s*transparent/);
    // …and nothing orbits the button any more.
    expect(rule('.chat-drawer-open[data-running="true"]::after')).toBe('');
  });

  it('paints a running row in the WORKING hue, never the accent', () => {
    // This theme's accent is a crimson, and a crimson label on a healthy
    // running row reads as an error — "working is red, red feels error".
    const working = rule('.chat-drawer__row-live[data-state="working"]');
    expect(working).toContain('--status-working');
    expect(working).not.toMatch(/--state-ink:\s*var\(--d-accent\)/);
  });

  it('does not animate it when nothing is running', () => {
    // The breath is the whole signal. A button that always breathes says
    // nothing, which is where this started.
    expect(rule('.chat-drawer-open')).not.toMatch(/animation:/);
  });

  it('spins the running row’s mark, since the arc itself is static', () => {
    expect(rule('.chat-drawer__spin')).toMatch(/animation:/);
  });

  it('takes its finished hue from the STATUS channel, never the accent', () => {
    // The accent is re-tuned per theme; "did this finish" must not be.
    expect(rule('.chat-drawer__row-live[data-state="delivered"]')).toContain('--status-ready');
    expect(rule('.chat-drawer__row-live[data-state="failed"]')).toContain('--status-dead');
  });

  it('stops every one of them for a reader who asked for no motion', () => {
    const css = readFileSync(join(__dirname, 'ChatDrawer.css'), 'utf8');
    const at = css.indexOf('prefers-reduced-motion');
    expect(at, 'no reduced-motion guard at all').toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}\n}', at));
    expect(block).toContain('.chat-drawer__spin');
    expect(block).toContain('.chat-drawer-open__count.-spinning::after');
    expect(block).toContain('animation: none');
  });
});
