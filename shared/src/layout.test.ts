import { describe, it, expect } from 'vitest';
import { appendLeafToLayout, removeLeafFromLayout, spliceLayoutAtTarget } from './layout.js';

describe('spliceLayoutAtTarget', () => {
  it('empty layout: new pane becomes root, placed=true', () => {
    expect(spliceLayoutAtTarget('', 'src', 'new', 'row')).toEqual({
      layout: 'new',
      placed: true,
    });
  });

  it('single-leaf matching target: splits at the leaf, placed=true', () => {
    expect(spliceLayoutAtTarget('a', 'a', 'new', 'row')).toEqual({
      layout: { direction: 'row', first: 'a', second: 'new' },
      placed: true,
    });
  });

  it('single-leaf NOT matching: still splits (degenerate), placed=false', () => {
    // For a single-leaf tree, root-append and split-at-leaf produce the
    // same shape, so the helper does the split anyway and lets the caller
    // decide via `placed` whether that counts as success.
    expect(spliceLayoutAtTarget('a', 'b', 'new', 'row')).toEqual({
      layout: { direction: 'row', first: 'a', second: 'new' },
      placed: false,
    });
  });

  it('nested target: splices in place, preserves siblings', () => {
    const layout = {
      direction: 'row' as const,
      first: 'left',
      second: { direction: 'column' as const, first: 'top', second: 'bottom' },
    };
    const { layout: next, placed } = spliceLayoutAtTarget(
      layout,
      'top',
      'new',
      'row',
    );
    expect(placed).toBe(true);
    expect(next).toEqual({
      direction: 'row',
      first: 'left',
      second: {
        direction: 'column',
        first: { direction: 'row', first: 'top', second: 'new' },
        second: 'bottom',
      },
    });
  });

  it('target absent from nested tree: returns layout unchanged, placed=false', () => {
    const layout = {
      direction: 'row' as const,
      first: 'a',
      second: 'b',
    };
    const { layout: next, placed } = spliceLayoutAtTarget(
      layout,
      'nope',
      'new',
      'row',
    );
    expect(placed).toBe(false);
    expect(next).toEqual(layout);
  });

  it('honors the direction arg', () => {
    expect(
      spliceLayoutAtTarget('a', 'a', 'new', 'column').layout,
    ).toEqual({ direction: 'column', first: 'a', second: 'new' });
  });

  it('position=before puts the new pane on the first side', () => {
    expect(
      spliceLayoutAtTarget('a', 'a', 'new', 'row', 'before').layout,
    ).toEqual({ direction: 'row', first: 'new', second: 'a' });
    expect(
      spliceLayoutAtTarget('a', 'a', 'new', 'column', 'before').layout,
    ).toEqual({ direction: 'column', first: 'new', second: 'a' });
  });

  it('position=before works inside a nested tree', () => {
    const layout = {
      direction: 'row' as const,
      first: 'left',
      second: { direction: 'column' as const, first: 'top', second: 'bottom' },
    };
    const { layout: next, placed } = spliceLayoutAtTarget(
      layout,
      'top',
      'new',
      'column',
      'before',
    );
    expect(placed).toBe(true);
    expect(next).toEqual({
      direction: 'row',
      first: 'left',
      second: {
        direction: 'column',
        first: { direction: 'column', first: 'new', second: 'top' },
        second: 'bottom',
      },
    });
  });
});

describe('removeLeafFromLayout', () => {
  it('empty layout stays empty', () => {
    expect(removeLeafFromLayout('', 'x')).toBe('');
  });

  it('single matching leaf collapses to empty', () => {
    expect(removeLeafFromLayout('a', 'a')).toBe('');
  });

  it('single non-matching leaf is unchanged', () => {
    expect(removeLeafFromLayout('a', 'b')).toBe('a');
  });

  it('removing one side of a split collapses to the sibling', () => {
    const layout = { direction: 'row' as const, first: 'a', second: 'b' };
    expect(removeLeafFromLayout(layout, 'a')).toBe('b');
    expect(removeLeafFromLayout(layout, 'b')).toBe('a');
  });

  it('removes a deeply nested leaf, collapsing its now-single-child branch', () => {
    const layout = {
      direction: 'row' as const,
      first: 'left',
      second: { direction: 'column' as const, first: 'top', second: 'bottom' },
    };
    expect(removeLeafFromLayout(layout, 'top')).toEqual({
      direction: 'row',
      first: 'left',
      second: 'bottom',
    });
  });

  it('only removes the FIRST matching leaf (ids are unique in practice)', () => {
    const layout = { direction: 'row' as const, first: 'a', second: 'a' };
    // Both branches match → both collapse → empty. (Defensive: real layouts
    // never duplicate a pane id, so this is just documenting the recursion.)
    expect(removeLeafFromLayout(layout, 'a')).toBe('');
  });
});

describe('appendLeafToLayout', () => {
  it('empty layout: the leaf becomes the root', () => {
    expect(appendLeafToLayout('', 'new')).toBe('new');
  });

  it('wraps an existing tree in a split with the new leaf second', () => {
    expect(appendLeafToLayout('a', 'new')).toEqual({
      direction: 'row',
      first: 'a',
      second: 'new',
    });
  });

  it('honors the direction arg and preserves the existing subtree', () => {
    const layout = { direction: 'row' as const, first: 'a', second: 'b' };
    expect(appendLeafToLayout(layout, 'new', 'column')).toEqual({
      direction: 'column',
      first: layout,
      second: 'new',
    });
  });
});
