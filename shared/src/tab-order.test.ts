import { describe, expect, it } from 'vitest';
import { compareUnpinnedTabs, sortSidebarTabs } from './tab-order.js';

describe('wire-only sidebar order', () => {
  it.each([null, 200])(
    'uses ID order for every permutation and conflicting position map (activity %s)',
    (last_activity_at) => {
      const rows = [
        { id: 'c', last_activity_at },
        { id: 'b', last_activity_at },
        { id: 'a', last_activity_at },
      ];
      const permutations = <T>(xs: T[]): T[][] =>
        xs.length === 0
          ? [[]]
          : xs.flatMap((x, i) =>
              permutations(xs.filter((_, j) => j !== i)).map((tail) => [x, ...tail]),
            );
      for (const serverInput of permutations(rows)) {
        const manual = new Map(serverInput.map((t, i) => [t.id, i]));
        const server = [...serverInput].sort((a, b) => compareUnpinnedTabs(a, b, manual));
        expect(server.map((t) => t.id)).toEqual(['a', 'b', 'c']);
        for (const clientInput of permutations(rows)) {
          const published = new Map(clientInput.map((t, i) => [t.id, i]));
          expect(sortSidebarTabs(clientInput, published).map((t) => t.id)).toEqual(['a', 'b', 'c']);
          expect(sortSidebarTabs(clientInput, published)).toEqual(server);
        }
      }
    },
  );

  it('keeps pinned manual order separate from canonical unpinned ties', () => {
    const rows = [{ id: 'z', pinned: true }, { id: 'a', pinned: true }, { id: 'd' }, { id: 'c' }];
    expect(sortSidebarTabs(rows).map((t) => t.id)).toEqual(['z', 'a', 'c', 'd']);
  });
});
