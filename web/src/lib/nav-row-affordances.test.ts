import { describe, expect, it } from 'vitest';
import { pointerLeaveAborts } from '../use-long-press';
import { folderSurface, showFolderChip, tabRowAffordances } from './nav-row-affordances';

const row = (o: Partial<Parameters<typeof tabRowAffordances>[0]> = {}) =>
  tabRowAffordances({
    variant: 'sidebar',
    paneCount: 1,
    panesOpen: false,
    isEditing: false,
    ...o,
  });

describe('tab row affordances — desktop sidebar', () => {
  it('offers the hover-revealed pin, and none of the touch controls', () => {
    expect(row({ variant: 'sidebar', paneCount: 3 })).toEqual({
      pinButton: true,
      closeButton: true,
      paneExpander: false,
      paneCountChip: false,
      tapExpandsPanes: false,
    });
  });

  it('never expands into a pane list — the mosaic already shows every pane', () => {
    expect(row({ variant: 'sidebar', paneCount: 9 }).tapExpandsPanes).toBe(false);
  });
});

describe('tab row affordances — mobile sheet', () => {
  it('renders NO permanent per-row control — not the pin, not the ×', () => {
    // Every always-on hit square on a sheet row sits exactly where a thumb
    // lands while scrolling, which made the two commonest mis-taps in the app
    // "closed a chat I meant to open" and "opened a menu I meant to scroll
    // past". Both controls moved under the row, behind a deliberate left
    // swipe (see swipe-axis). Desktop is untouched.
    const a = row({ variant: 'sheet', paneCount: 1 });
    expect(a.pinButton).toBe(false);
    expect(a.closeButton).toBe(false);
  });

  it('a SINGLE-pane tab is a plain row: no chevron, no chip, tap opens it', () => {
    expect(row({ variant: 'sheet', paneCount: 1 })).toEqual({
      pinButton: false,
      closeButton: false,
      paneExpander: false,
      paneCountChip: false,
      tapExpandsPanes: false,
    });
  });

  it('a MULTI-pane tab announces itself: chevron + count, and tap expands', () => {
    expect(row({ variant: 'sheet', paneCount: 4 })).toEqual({
      pinButton: false,
      closeButton: false,
      paneExpander: true,
      paneCountChip: true,
      tapExpandsPanes: true,
    });
  });

  it('the count chip is COLLAPSED-only — expanded, the panes speak for themselves', () => {
    expect(row({ variant: 'sheet', paneCount: 4, panesOpen: true }).paneCountChip).toBe(false);
    // The chevron stays (it's how you collapse again) and tap still toggles.
    expect(row({ variant: 'sheet', paneCount: 4, panesOpen: true }).paneExpander).toBe(true);
    expect(row({ variant: 'sheet', paneCount: 4, panesOpen: true }).tapExpandsPanes).toBe(true);
  });

  it('one pane and many panes are now DISTINGUISHABLE before you tap', () => {
    // The whole point of the change: the two row types differed only by a
    // 10px chevron at the far-left edge, opposite the name you read, yet
    // behaved completely differently on tap.
    const one = row({ variant: 'sheet', paneCount: 1 });
    const many = row({ variant: 'sheet', paneCount: 2 });
    expect(one.paneCountChip).not.toBe(many.paneCountChip);
    expect(one.tapExpandsPanes).not.toBe(many.tapExpandsPanes);
  });

  it('an inline rename stands every row control down', () => {
    const a = row({ variant: 'sheet', paneCount: 4, isEditing: true });
    expect(a.closeButton).toBe(false);
    expect(a.paneExpander).toBe(false);
    // Desktop too: the × and pin would otherwise sit beside the input and
    // steal the width the name needs while you're typing into it.
    const d = row({ variant: 'sidebar', paneCount: 1, isEditing: true });
    expect(d.pinButton).toBe(false);
    expect(d.closeButton).toBe(false);
  });

  it('editing does not hide the count chip’s meaning for a collapsed row', () => {
    // The chip lives inside the link, which the rename input replaces
    // wholesale — so its flag is irrelevant while editing and we don't
    // pretend otherwise by special-casing it.
    expect(row({ variant: 'sheet', paneCount: 4, isEditing: true }).paneCountChip).toBe(true);
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
