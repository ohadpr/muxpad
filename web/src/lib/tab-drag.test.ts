import { describe, expect, it } from 'vitest';
import { type DraggableTab, orderAfterPinnedDrop, paneDropAction } from './tab-drag';

const tabs: DraggableTab[] = [
  { id: 'p1', pinned: true },
  { id: 'p2', pinned: true },
  { id: 'p3', pinned: true },
  { id: 'u1' },
  { id: 'u2' },
];

describe('orderAfterPinnedDrop', () => {
  it('reorders within the pinned block and leaves the sorted block untouched', () => {
    const next = orderAfterPinnedDrop(tabs, 'p1', 'p3');
    expect(next?.pinnedIds).toEqual(['p2', 'p3', 'p1']); // dragged down → lands after
    // The auto-sorted tail is passed through verbatim: the client never
    // invents an order for it, and the server would overwrite one anyway.
    expect(next?.allIds).toEqual(['p2', 'p3', 'p1', 'u1', 'u2']);
  });

  it('reorders upward too (drop BEFORE the target)', () => {
    expect(orderAfterPinnedDrop(tabs, 'p3', 'p1')?.pinnedIds).toEqual(['p3', 'p1', 'p2']);
  });

  it('refuses to reorder an UNPINNED tab — dragging one never pins it', () => {
    // The old behaviour pinned whatever you dropped. Now an unpinned drag is
    // a move-to-another-workspace gesture and nothing else: inside its own
    // list it must be a complete no-op, with no pin patch as a side effect.
    expect(orderAfterPinnedDrop(tabs, 'u1', 'p2')).toBeNull();
    expect(orderAfterPinnedDrop(tabs, 'u1', 'u2')).toBeNull();
  });

  it('refuses a pinned tab dropped ON an unpinned one (past the divider)', () => {
    // There is no manual position down there to land at, so the drop simply
    // does nothing — it does not unpin, and it does not silently pin the
    // target either.
    expect(orderAfterPinnedDrop(tabs, 'p1', 'u2')).toBeNull();
  });

  it('is a no-op for a self-drop or an unknown id', () => {
    expect(orderAfterPinnedDrop(tabs, 'p1', 'p1')).toBeNull();
    expect(orderAfterPinnedDrop(tabs, 'nope', 'p1')).toBeNull();
    expect(orderAfterPinnedDrop(tabs, 'p1', 'nope')).toBeNull();
  });

  it('keeps every id exactly once', () => {
    // (guards against a reorder that drops or duplicates a tab)
    const next = orderAfterPinnedDrop(tabs, 'p2', 'p1');
    expect(next?.allIds.slice().sort()).toEqual(
      tabs
        .map((t) => t.id)
        .slice()
        .sort(),
    );
  });
});

describe('paneDropAction — dropping a pane on a workspace header', () => {
  const origin = (over: Partial<{ soloPane: boolean; fromWorkspaceId: string }> = {}) => ({
    paneId: 'p',
    fromTabId: 't',
    fromWorkspaceId: 'ws-a',
    ...over,
  });

  it('extracts a pane from a multi-pane tab into a new tab there', () => {
    expect(paneDropAction(origin({ soloPane: false }), 'ws-b')).toBe('new-tab');
    expect(paneDropAction(origin({ soloPane: false }), 'ws-a')).toBe('new-tab'); // pop out at home
  });

  it("moves the whole TAB when the pane is that tab's only one", () => {
    // Extracting would delete the tab and rebuild an identical one — losing
    // its name/icon/slug and bouncing anyone viewing it to the workspace root.
    expect(paneDropAction(origin({ soloPane: true }), 'ws-b')).toBe('move-tab');
  });

  it('declines a solo pane dropped on the workspace it already lives in', () => {
    // Nothing to extract; the row must not advertise a drop it can't perform.
    expect(paneDropAction(origin({ soloPane: true }), 'ws-a')).toBe('none');
  });

  it('falls back to new-tab when the drag origin is unknown', () => {
    // The server enforces the churn rule anyway, and its answer for a solo
    // pane at home is a no-op — never a destroyed tab.
    expect(paneDropAction(null, 'ws-b')).toBe('new-tab');
    expect(paneDropAction({ paneId: 'p', fromTabId: 't', soloPane: true }, 'ws-b')).toBe('new-tab');
  });
});
