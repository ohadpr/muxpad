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
    expect(tab).toMatch(/min-width:\s*112px/);
    expect(/\.wstabs \{([^}]*)\}/.exec(CSS)?.[1] ?? '').toMatch(/overflow-x:\s*auto/);
  });

  it('joins the pane it belongs to, which the band could never do', () => {
    // The band borrowed a selected row's fill and had no pane beside it to
    // flare into. A tab has one directly underneath.
    const active =
      /\.wstab\[data-active=["']true["']\] \.wstab-link \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(active).toMatch(/background:\s*var\(--bg-pane-face/);
  });

  it('spends colour on status, not identity', () => {
    // 62 emoji are in use; colour is the loudest channel and belongs to the
    // thing that changes.
    expect(/\.wstab-icon \{([^}]*)\}/.exec(CSS)?.[1] ?? '').toMatch(/filter:\s*saturate/);
  });
});
