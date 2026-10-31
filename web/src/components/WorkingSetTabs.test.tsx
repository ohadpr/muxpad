import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE WORKING SET LEFT THE RAIL.
 *
 * Every complaint the band collected was the same one: a list that looks like
 * the list under it and means something different from the list under it
 * reads as noise however carefully it is coloured. Four rounds of tuning each
 * traded one casualty for another — clip the name, clip the workspace, hide
 * the workspace, collapse the line.
 *
 * The shape was a tab bar all along: stable slots that never reorder when you
 * use them, ⌃1–⌃6, a × that means "not now", eviction by capacity, decay by
 * time. muxpad's own model calls these things tabs.
 */
const SRC = readFileSync(join(import.meta.dirname, 'WorkingSetTabs.tsx'), 'utf8');
const CSS = readFileSync(join(import.meta.dirname, 'WorkingSetTabs.css'), 'utf8');
const LAYOUT = readFileSync(join(import.meta.dirname, 'AppLayout.tsx'), 'utf8');

describe('where the tabs live', () => {
  it('mounts above the panes, right of the rail', () => {
    const col = LAYOUT.indexOf('workspace-column');
    const tabs = LAYOUT.indexOf('<WorkingSetTabs');
    const hosts = LAYOUT.indexOf('className="workspace-hosts"');
    expect(col).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(col);
    expect(tabs, 'the strip takes its height off the top').toBeLessThan(hosts);
  });

  it('is desktop only — the sheet keeps the band', () => {
    // A tab strip on a phone is six things fighting for 390px, which is the
    // crowding this move exists to undo, on the surface that can least
    // afford it.
    expect(LAYOUT).toMatch(/sidebarMode && <WorkingSetTabs/);
  });
});

describe('what the tabs keep from the band', () => {
  it('keeps the slots stable — it reads the working set, it does not sort it', () => {
    // The whole design: a chat takes the first FREE slot and keeps it. Sorting
    // by recency would reorder the list as a result of your own click.
    expect(SRC).toMatch(/const rows = useWorkingSet\(\)/);
    expect(SRC).not.toMatch(/\.sort\(/);
  });

  it('keeps ⌃1–⌃6, bound by position', () => {
    // The numbers are worth having precisely because the slots do not move.
    expect(SRC).toMatch(
      /if \(!e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey \|\| e\.shiftKey\) return/,
    );
    expect(SRC).toMatch(/rows\[n - 1\]/);
  });

  it('keeps "not now" as a slot release, not a delete', () => {
    expect(SRC).toContain('void dropFromWorkingSet(tab.id)');
    // The × must not reach for anything that changes the chat itself.
    expect(SRC).not.toMatch(/api\.(deleteTab|archiveTab|closeTab)/);
  });

  it('renders NOTHING when there is nothing — not an empty bar', () => {
    // A strip with no tabs is a row of height spent on a promise the app is
    // not keeping, and that is the normal state on a fresh install.
    expect(SRC).toMatch(/if \(rows\.length === 0\) return null/);
  });
});

describe('what a tab looks like', () => {
  it('gives a name a floor rather than an ellipsis at any width', () => {
    // Past the floor the strip SCROLLS. Squeezing six tabs into a narrow pane
    // reproduces the rail's failure — the name was the thing being clipped.
    const tab = /\.wstab \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(tab).toMatch(/min-width:\s*128px/);
    expect(/\.wstabs \{([^}]*)\}/.exec(CSS)?.[1] ?? '').toMatch(/overflow-x:\s*auto/);
  });

  it('joins the pane it belongs to, which the band could never do', () => {
    // The band borrowed a selected row's fill and had no pane beside it to
    // flare into. A tab has one directly underneath.
    // The pane face is on the TAB, not the link: the link is the hit area,
    // the tab is the shape that joins what is underneath it.
    const i = CSS.search(/\.wstab\[data-active=["']true["']\],/);
    expect(i, 'no active-tab rule').toBeGreaterThan(-1);
    const active = CSS.slice(i, CSS.indexOf('}', i));
    expect(active).toMatch(/background:\s*var\(--bg-pane-face/);
    // …and it paints over the strip's own hairline, or the two read as two
    // stacked shapes rather than one.
    expect(active).toMatch(/box-shadow:\s*0 1px 0 0 var\(--bg-pane-face/);
  });

  it('spends colour on status, not identity', () => {
    // 62 emoji are in use; colour is the loudest channel and belongs to the
    // thing that changes.
    expect(/\.wstab-icon \{([^}]*)\}/.exec(CSS)?.[1] ?? '').toMatch(/filter:\s*saturate/);
  });
});

/**
 * ── THE FIVE THINGS THAT WERE WRONG WITH THE FIRST DRAW ──────────────────
 *
 * Reported together, and each one is a different way of not being a tab bar:
 * "tabs don't look like tabs", "hovering over them changes their width",
 * "status indicators mix with x", "read/unread status isn't represented",
 * and the colour being the chat's rather than the sidebar's.
 */
describe('the strip is drawn as navigation', () => {
  it('wears the RAIL surface and rebinds the island tokens', () => {
    // It is the rail's working set moved sideways, not part of the
    // conversation. And the rebinding is not decoration: app ink on a deep
    // rail surface measures about 1.02:1 — the rail's own comment records it.
    const strip = /\.wstabs \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(strip).toMatch(/background:\s*var\(--rail-surface\)/);
    expect(strip).toMatch(/--fg:\s*var\(--rail-ink\)/);
    expect(strip).toMatch(/--status-working:\s*var\(--rail-status-working\)/);
  });

  it('gives every tab a body, not just the active one', () => {
    // Bare text in a row is a toolbar. A tab bar is read by SHAPE before it
    // is read by word.
    const tab = /\.wstab \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(tab).toMatch(/border-radius:\s*8px 8px 0 0/);
    // A lift off the strip's own surface — see the suite below for how far.
    expect(tab).toMatch(/background:\s*color-mix\(in srgb, var\(--rail-ink\)/);
    expect(tab).toMatch(/border:\s*1px solid/);
  });

  it('does not change width on hover', () => {
    // The × used to appear on hover while the name grew padding to clear it,
    // so the tab resized under the pointer. One fixed slot, always present.
    const slot = /\.wstab-slot \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(slot).toMatch(/width:\s*20px/);
    expect(slot).toMatch(/flex:\s*0 0 auto/);
    expect(CSS).not.toMatch(/\.wstab:hover \.wstab-name[^}]*padding/);
  });

  it('puts the mark and the × in the SAME slot, not beside each other', () => {
    // Two objects in one corner read as one confused control.
    expect(/\.wstab-drop \{([^}]*)\}/.exec(CSS)?.[1] ?? '').toMatch(/position:\s*absolute/);
    const i = CSS.indexOf('.wstab:hover .wstab-mark');
    expect(i, 'the mark must step aside for the ×').toBeGreaterThan(-1);
    expect(CSS.slice(i, CSS.indexOf('}', i))).toMatch(/visibility:\s*hidden/);
  });

  it('says unread the way the rail says it', () => {
    // The one state a nav element must carry: it is the reason you would
    // look at the strip at all.
    expect(SRC).toMatch(/data-unread=\{tab\.unread \? 'true' : undefined\}/);
    const unread =
      /\.wstab\[data-unread=["']true["']\] \.wstab-name \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(unread).toMatch(/font-weight:\s*700/);
    expect(unread).toMatch(/color:\s*var\(--fg\)/);
  });

  it('keeps unread louder than active, so a tab that is both says the louder thing', () => {
    const active =
      /\.wstab\[data-active=["']true["']\] \.wstab-name \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const activeW = Number(/font-weight:\s*(\d+)/.exec(active)?.[1]);
    const unreadW = Number(
      /font-weight:\s*(\d+)/.exec(
        /\.wstab\[data-unread=["']true["']\] \.wstab-name \{([^}]*)\}/.exec(CSS)?.[1] ?? '',
      )?.[1],
    );
    expect(unreadW).toBeGreaterThan(activeW);
  });
});

/**
 * ── TWO SURFACES, AND THE ONE THAT LEAVES THE ISLAND ─────────────────────
 *
 * Reported from a blueprint screenshot: "tab bar background is same color as
 * tab background so it all mixes", and "active tab highlight borks the
 * readability of tab because tab name doesn't change color".
 */
describe('the strip and the tabs on it are two surfaces', () => {
  it('lifts a tab well clear of the strip it sits on', () => {
    // `--rail-elev` is a 6% lift tuned for a control with space around it.
    // Six tabs edge to edge do not have that space — on blueprint the strip
    // and the tabs became one blue block.
    const tab = /\.wstab \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const lift = Number(/var\(--rail-ink\) (\d+)%, var\(--rail-surface\)/.exec(tab)?.[1]);
    expect(lift).toBeGreaterThanOrEqual(10);
    expect(tab).not.toMatch(/background:\s*var\(--rail-elev\)/);
  });

  it('derives both surfaces from the rail, so a new theme cannot forget one', () => {
    const tab = /\.wstab \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(tab).toMatch(/color-mix\(in srgb, var\(--rail-ink\)/);
    expect(/\.wstabs \{([^}]*)\}/.exec(CSS)?.[1] ?? '').toMatch(
      /background:\s*var\(--rail-surface\)/,
    );
  });
});

describe('the active tab leaves the island', () => {
  const active = (() => {
    const i = CSS.search(/\.wstab\[data-active=["']true["']\],/);
    return i < 0 ? '' : CSS.slice(i, CSS.indexOf('}', i));
  })();

  it('re-points the ink at the PANE, because it is painted in the pane’s face', () => {
    // The same rule, for the same reason, as the rail's selected row.
    // Without it the one tab that is not rail-coloured is drawn in rail ink:
    // white on near-white in every light theme.
    expect(active).toMatch(/--fg:\s*var\(--pane-ink\)/);
    expect(active).toMatch(/--fg-dim:\s*var\(--pane-ink-dim\)/);
  });

  it('re-points the STATUS colours too, not just the text', () => {
    // The dot sits on the pane's face as well, and a rail status hue is
    // chosen to carry on a deep surface.
    expect(active).toMatch(/--status-working:\s*var\(--pane-status-working\)/);
    expect(active).toMatch(/--status-blocked:\s*var\(--pane-status-blocked\)/);
  });

  it('is the only thing wearing the pane face', () => {
    // If an inactive tab took it too, "which one am I in" would be a
    // question about a border rather than an answer about a surface.
    expect((CSS.match(/background:\s*var\(--bg-pane-face/g) ?? []).length).toBe(1);
  });
});
