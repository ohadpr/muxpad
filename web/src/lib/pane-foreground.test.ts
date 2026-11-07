import { describe, expect, it } from 'vitest';
import {
  type ForegroundInput,
  escapeClearsJump,
  focusesComposerOnArrival,
  foregroundOf,
  ownsKeyboard,
  showsScrollArrow,
} from './pane-foreground';

const base: ForegroundInput = {
  active: true,
  drawerOpen: false,
  drawerPaneId: null,
  openTool: false,
  openImage: false,
};
const at = (o: Partial<ForegroundInput> = {}): ForegroundInput => ({ ...base, ...o });

/** Every combination, so a new surface cannot be added without a case here. */
const ALL: ForegroundInput[] = [];
for (const drawerOpen of [false, true])
  for (const drawerPaneId of [null, 'p1'])
    for (const openTool of [false, true])
      for (const openImage of [false, true])
        for (const active of [false, true])
          ALL.push({ active, drawerOpen, drawerPaneId, openTool, openImage });

describe('what is in front', () => {
  it('stacks the way the DOM does', () => {
    expect(foregroundOf(at())).toBe('transcript');
    expect(foregroundOf(at({ drawerOpen: true }))).toBe('drawer-list');
    expect(foregroundOf(at({ drawerOpen: true, drawerPaneId: 'p1' }))).toBe('drawer-chat');
    expect(foregroundOf(at({ drawerOpen: true, openTool: true }))).toBe('tool');
    expect(foregroundOf(at({ drawerOpen: true, openTool: true, openImage: true }))).toBe('image');
  });

  it('ignores a mounted sub-chat id while the drawer is shut', () => {
    // The id outlives the drawer being closed — it is remembered so reopening
    // returns you to the worker you were reading.
    expect(foregroundOf(at({ drawerPaneId: 'p1' }))).toBe('transcript');
  });
});

describe('who owns the keyboard', () => {
  it('is the transcript, and only when this pane is the visible face', () => {
    expect(ownsKeyboard(at())).toBe(true);
    expect(ownsKeyboard(at({ active: false }))).toBe(false);
  });

  it('is NOT the parent while a sub-chat is open in its drawer', () => {
    // The bug: a nested ChatPane inherits `active`, both claimed the window's
    // keydown, and the parent — registered first — won. You typed into the
    // chat you were reading and it went to the one behind it.
    expect(ownsKeyboard(at({ drawerOpen: true, drawerPaneId: 'p1' }))).toBe(false);
  });

  it('is nobody while a modal is up', () => {
    expect(ownsKeyboard(at({ openTool: true }))).toBe(false);
    expect(ownsKeyboard(at({ openImage: true }))).toBe(false);
  });

  it('never belongs to an inactive pane, whatever else is true', () => {
    for (const i of ALL.filter((x) => !x.active))
      expect(ownsKeyboard(i), JSON.stringify(i)).toBe(false);
  });
});

describe('the jump-to-latest arrow', () => {
  it('is drawn only when the transcript is what you are looking at', () => {
    expect(showsScrollArrow(at())).toBe(true);
    // It scrolls the transcript, and it shares the drawer's z-index, so while
    // the drawer is open it does not merely mislead — it paints on top.
    expect(showsScrollArrow(at({ drawerOpen: true }))).toBe(false);
    expect(showsScrollArrow(at({ openTool: true }))).toBe(false);
    expect(showsScrollArrow(at({ openImage: true }))).toBe(false);
  });
});

describe('Escape', () => {
  it('clears the search highlight unless a modal owns it', () => {
    expect(escapeClearsJump(at())).toBe(true);
    expect(escapeClearsJump(at({ openTool: true }))).toBe(false);
    expect(escapeClearsJump(at({ openImage: true }))).toBe(false);
  });

  it('still belongs to the transcript while the drawer is open', () => {
    // The drawer has its own close control, and a reader who glanced at it
    // still wants the highlight when they come back.
    expect(escapeClearsJump(at({ drawerOpen: true }))).toBe(true);
    expect(escapeClearsJump(at({ drawerOpen: true, drawerPaneId: 'p1' }))).toBe(true);
  });
});

describe('focusing the composer on arrival', () => {
  it('follows the keyboard, and never on a touch layout', () => {
    expect(focusesComposerOnArrival(at(), false)).toBe(true);
    // Focusing raises the software keyboard over the conversation you just
    // opened.
    expect(focusesComposerOnArrival(at(), true)).toBe(false);
    expect(focusesComposerOnArrival(at({ drawerOpen: true, drawerPaneId: 'p' }), false)).toBe(
      false,
    );
  });
});

describe('the three answers agree with each other', () => {
  it('never lets a pane own the keyboard while something is in front of it', () => {
    for (const i of ALL) {
      if (foregroundOf(i) !== 'transcript') expect(ownsKeyboard(i), JSON.stringify(i)).toBe(false);
    }
  });

  it('never draws the arrow where the keyboard is not the transcript’s — on an active pane', () => {
    // The arrow is about what is on top; the keyboard adds "is this pane the
    // visible face". On an active pane the two must agree, and the pair being
    // out of step is exactly how the arrow ended up over the drawer.
    for (const i of ALL.filter((x) => x.active))
      expect(showsScrollArrow(i), JSON.stringify(i)).toBe(ownsKeyboard(i));
  });
});
