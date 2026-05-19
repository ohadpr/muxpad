import { describe, it, expect } from 'vitest';
import { spliceLayoutAtTarget } from './layout.js';

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
