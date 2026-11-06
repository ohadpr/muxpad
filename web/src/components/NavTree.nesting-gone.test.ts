import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE RAIL DOES NOT NEST ANY MORE, AND BOTH HALVES MUST AGREE.
 *
 * Sub-chats moved into their parent's work drawer, so no row is a child of
 * another. What was left behind was the worst shape a feature can be left in:
 * a stylesheet full of `[data-child="true"]` rules and a React side that had
 * stopped emitting the attribute — fifteen rules that could never match, three
 * props threaded from nothing, and tests asserting all of it.
 *
 * Removing it was NOT the clean delete it looked like, which is why this guard
 * exists. `parent` was also read at two live call sites — the chip's shape and
 * the drag gate — and deleting the prop made those names resolve to a
 * DIFFERENT `parent` in an enclosing scope (`byId.get(parentId)`). TypeScript
 * was perfectly happy and every row silently became a dot. The tests caught
 * what the compiler could not.
 *
 * So: if nesting ever comes back, it comes back in both halves at once.
 */
const CSS = readFileSync(join(import.meta.dirname, 'NavTree.css'), 'utf8');
const TSX = readFileSync(join(import.meta.dirname, 'NavTree.tsx'), 'utf8');
/** Comments talk about the history on purpose; only real code counts. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the child-row machinery is gone from both sides', () => {
  it('has no stylesheet rule that nothing can match', () => {
    const live = code(CSS);
    for (const attr of ['data-child', 'data-child-last', 'data-family'])
      expect(live, `${attr} is styled but never emitted`).not.toContain(attr);
  });

  it('emits none of those attributes, and threads no prop for them', () => {
    const live = code(TSX);
    for (const token of ['data-child', 'data-family', 'childLast'])
      expect(live, token).not.toContain(token);
  });

  it('chooses the chip’s shape outright rather than from a stale prop', () => {
    // The regression this file was written for: `shape={parent ? 'dot' : 'tile'}`
    // kept compiling after the prop went away, bound to another variable.
    expect(code(TSX)).not.toMatch(/shape=\{[^}]*parent/);
  });
});
