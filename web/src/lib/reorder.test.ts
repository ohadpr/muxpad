import { describe, expect, it } from 'vitest';
import { reorderByDrop } from './reorder';

describe('reorderByDrop', () => {
  const L = ['a', 'b', 'c', 'd'];

  it('drags downward → lands after the target', () => {
    expect(reorderByDrop(L, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('drags downward onto the last → reaches the end', () => {
    expect(reorderByDrop(L, 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('drags upward → lands before the target', () => {
    expect(reorderByDrop(L, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('drags upward onto the first → reaches the start', () => {
    expect(reorderByDrop(L, 'c', 'a')).toEqual(['c', 'a', 'b', 'd']);
  });

  it('adjacent swap (down)', () => {
    expect(reorderByDrop(L, 'b', 'c')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('no-ops on same id or missing id', () => {
    expect(reorderByDrop(L, 'b', 'b')).toBe(L);
    expect(reorderByDrop(L, 'b', 'z')).toBe(L);
    expect(reorderByDrop(L, 'z', 'b')).toBe(L);
  });
});
