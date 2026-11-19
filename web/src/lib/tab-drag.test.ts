import { describe, expect, it } from 'vitest';
import { type DraggableTab, orderAfterDrop } from './tab-drag';

/**
 * Reorder used to be PINNED-ONLY, and that was a consequence rather than a
 * choice: the unpinned block was auto-sorted and re-derived on every poll, so
 * an order dragged into it evaporated. The block is stable now, and without
 * the gesture the order was two-thirds of a design — no recency, no drag,
 * therefore permanently oldest-first with no way to arrange it.
 *
 * What stays refused is a drop ACROSS a block boundary, and both halves of
 * that have a history: dropping an unpinned row onto a pinned one is the old
 * "it silently pins it" gesture, and dropping a live chat into the done
 * drawer is a retirement performed by accident.
 */
const tabs: DraggableTab[] = [
  { id: 'p1', pinned: true },
  { id: 'p2', pinned: true },
  { id: 'p3', pinned: true },
  { id: 'u1' },
  { id: 'u2' },
  { id: 'u3' },
  { id: 'd1', done: true },
  { id: 'd2', done: true },
];

describe('orderAfterDrop', () => {
  it('reorders within the pinned block', () => {
    expect(orderAfterDrop(tabs, 'p1', 'p3')?.ids).toEqual([
      'p2',
      'p3',
      'p1', // dragged down → lands after the target
      'u1',
      'u2',
      'u3',
      'd1',
      'd2',
    ]);
  });

  it('reorders within the UNPINNED block, which is the new part', () => {
    expect(orderAfterDrop(tabs, 'u3', 'u1')?.ids).toEqual([
      'p1',
      'p2',
      'p3',
      'u3', // dragged up → lands before the target
      'u1',
      'u2',
      'd1',
      'd2',
    ]);
  });

  it('reorders inside the done drawer too', () => {
    // It is a block like any other. Nothing about it needed a special case,
    // and a special case would be a drawer whose rows cannot be arranged for
    // no reason anybody could name.
    expect(orderAfterDrop(tabs, 'd2', 'd1')?.ids.slice(-2)).toEqual(['d2', 'd1']);
  });

  it('refuses an unpinned row dropped on a pinned one — it never pins it', () => {
    // The old behaviour pinned whatever you dropped: a gesture that silently
    // changed a tab's category to make the drag mean something.
    expect(orderAfterDrop(tabs, 'u1', 'p2')).toBeNull();
  });

  it('refuses a pinned row dropped past the divider', () => {
    // It does not unpin, and it does not pin the target either.
    expect(orderAfterDrop(tabs, 'p1', 'u2')).toBeNull();
  });

  it('refuses a live chat dropped into the done drawer, and the reverse', () => {
    // Retirement is an act with its own affordance (the row's ×). A drag that
    // performed it would retire a chat by accident, and un-retire one by
    // accident on the way back.
    expect(orderAfterDrop(tabs, 'u1', 'd1')).toBeNull();
    expect(orderAfterDrop(tabs, 'd1', 'u1')).toBeNull();
  });

  it('is a no-op for a self-drop or an unknown id', () => {
    expect(orderAfterDrop(tabs, 'u1', 'u1')).toBeNull();
    expect(orderAfterDrop(tabs, 'nope', 'u1')).toBeNull();
    expect(orderAfterDrop(tabs, 'u1', 'nope')).toBeNull();
  });

  it('returns the WHOLE list, because that is what gets persisted', () => {
    // `POST /api/tabs/reorder` writes `position = index` for every id it is
    // given, so sending one block alone would leave the other block's
    // positions describing an order nobody is looking at.
    const next = orderAfterDrop(tabs, 'u3', 'u1');
    expect(next?.ids).toHaveLength(tabs.length);
  });

  it('keeps every id exactly once', () => {
    // Guards against a reorder that drops or duplicates a row.
    const next = orderAfterDrop(tabs, 'u2', 'u1');
    expect(next?.ids.slice().sort()).toEqual(
      tabs
        .map((t) => t.id)
        .slice()
        .sort(),
    );
  });

  it('does not mutate the list it was handed', () => {
    const before = tabs.map((t) => t.id);
    orderAfterDrop(tabs, 'u3', 'u1');
    expect(tabs.map((t) => t.id)).toEqual(before);
  });
});
