import { describe, expect, it } from 'vitest';
import { pointerLeaveAborts } from '../use-long-press';
import { folderSurface, showFolderChip, tabRowAffordances } from './nav-row-affordances';

const row = (o: Partial<Parameters<typeof tabRowAffordances>[0]> = {}) =>
  tabRowAffordances({
    variant: 'sidebar',
    isEditing: false,
    ...o,
  });

describe('tab row affordances — desktop sidebar', () => {
  it('offers the hover-revealed menu button', () => {
    expect(row({ variant: 'sidebar' })).toEqual({ menuButton: true });
  });
});

describe('tab row affordances — mobile sheet', () => {
  it('renders NO permanent per-row control — not the pin, not the ×', () => {
    // Every always-on hit square on a sheet row sits exactly where a thumb
    // lands while scrolling, which made the two commonest mis-taps in the app
    // "closed a chat I meant to open" and "opened a menu I meant to scroll
    // past". Both controls moved under the row, behind a deliberate left
    // swipe (see swipe-axis). Desktop is untouched.
    expect(row({ variant: 'sheet' })).toEqual({ menuButton: false });
  });

  it('has no pane expander — a row holds one thing, so there is no list under it', () => {
    expect(row({ variant: 'sheet' })).not.toHaveProperty('paneExpander');
    expect(row({ variant: 'sheet' })).not.toHaveProperty('paneCountChip');
    expect(row({ variant: 'sheet' })).not.toHaveProperty('tapExpandsPanes');
  });

  it('an inline rename stands every row control down', () => {
    expect(row({ variant: 'sheet', isEditing: true }).menuButton).toBe(false);
    // Desktop too: the button would otherwise sit beside the input and steal
    // the width the name needs while you're typing into it.
    expect(row({ variant: 'sidebar', isEditing: true }).menuButton).toBe(false);
  });
});

describe('long-press: pointerleave handling', () => {
  it('a TOUCH pointerleave never aborts the hold', () => {
    // Root cause of "long press no work on mobile": iOS re-targets the
    // pointer when the pressed row restyles, and the old handler treated
    // that as the finger leaving.
    expect(pointerLeaveAborts('touch')).toBe(false);
  });

  it('mouse and pen still abort — the pointer really can wander off', () => {
    expect(pointerLeaveAborts('mouse')).toBe(true);
    expect(pointerLeaveAborts('pen')).toBe(true);
    expect(pointerLeaveAborts('')).toBe(true);
  });
});

describe('chat header: when the working folder is shown', () => {
  it('shows the folder cell for a project pane', () => {
    expect(showFolderChip({ hasProject: true })).toBe(true);
    expect(folderSurface({ hasProject: true })).toBe('chip');
  });

  it('hides path AND the "!" for a plain chat — nothing is wrong, you just aren’t coding', () => {
    expect(showFolderChip({ hasProject: false })).toBe(false);
  });

  it('a hidden chip never means an unreachable folder — it moves to the session menu', () => {
    expect(folderSurface({ hasProject: false })).toBe('session-menu');
  });

  it('exactly ONE surface owns the path whenever a folder is known', () => {
    for (const hasProject of [true, false]) {
      const surface = folderSurface({ hasProject });
      expect(surface).not.toBe('none');
      // The chip and the menu row are mutually exclusive by construction, so
      // the path can never be printed twice in the same header.
      expect(surface === 'chip').toBe(showFolderChip({ hasProject }));
    }
  });

  it('no folder resolved yet → no surface at all (not an empty chip)', () => {
    expect(folderSurface(null)).toBe('none');
    expect(showFolderChip(null)).toBe(false);
  });
});
