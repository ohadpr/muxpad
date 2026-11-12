import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ── ONE CONFIRMATION, NOT TWO ────────────────────────────────────────────
 *
 * Deleting a chat asked three times: open the context menu, choose the one
 * red item, then "click again — this cannot be undone" on the item you had
 * just chosen. Reported as a double confirmation, and it is: a prompt people
 * learn to click through protects nothing, and this one sat behind a
 * right-click or a long press that nobody performs by accident.
 *
 * The rail's × keeps its arming, and that asymmetry is the point: THAT one
 * is a single click away on every row in the list.
 */
const SRC = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');

describe('deleting a chat', () => {
  /** The context-menu item, from its label to the end of its entry. */
  const item = (): string => {
    const at = SRC.indexOf("label: 'Delete permanently'");
    expect(at, 'the delete item is gone — this test is about nothing').toBeGreaterThan(-1);
    return SRC.slice(at, SRC.indexOf('},', at));
  };

  it('asks no second time once you have chosen it', () => {
    expect(item()).not.toContain('confirm:');
  });

  it('is still the red one, and still says permanently', () => {
    // Removing the prompt must not also remove the warning: the word and the
    // colour are what remain to say this cannot be undone.
    expect(item()).toContain('danger: true');
    expect(item()).toContain('permanently');
  });

  it('leaves the rail’s × armed — that one IS one click from every row', () => {
    expect(SRC).toContain('useArmed');
    expect(SRC).toMatch(/armedLabel/);
  });
});
