import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ── EVERY × ARCHIVES ──────────────────────────────────────────────────────
 *
 * This one DELETED, permanently, behind a single armed tap — while the
 * sidebar's × and the sheet's swipe tray archive. Same glyph, opposite
 * outcomes, and only one of them can be undone: the chat, its queue, its
 * cards and its attachments went, from the control that looks most like
 * tidying up.
 *
 * Asserted against the source rather than a render, like
 * NavTree.delete.test.ts: what is being pinned is WHICH CALL the button
 * makes, and a render of this component needs the tab stores and a workspace
 * to say the same thing at ten times the cost.
 */
const SRC = readFileSync(join(__dirname, 'TabBarDropdown.tsx'), 'utf8');

describe('the tab-bar dropdown’s ×', () => {
  it('archives, and never deletes', () => {
    expect(SRC).toContain('api.archiveTab(tab.id)');
    expect(SRC, 'a permanent delete must not be one tap from a tab row').not.toContain(
      'api.deleteTab',
    );
  });

  it('says archive, in the title and to a screen reader', () => {
    // The label is half the fix: an × that says "Close tab" and deletes the
    // chat is the same bug one layer up.
    expect(SRC).toMatch(/title=\{armed \? 'Click again to archive/);
    expect(SRC).toMatch(/aria-label=\{armed \? `Click again to archive/);
    expect(SRC).not.toContain('anything running here will be killed');
  });

  it('still arms, matching the sidebar’s ×', () => {
    expect(SRC).toContain('useArmed');
  });
});
