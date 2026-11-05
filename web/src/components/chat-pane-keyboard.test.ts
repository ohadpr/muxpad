import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ── THE CHAT ON SCREEN OWNS THE KEYBOARD ─────────────────────────────────
 *
 * A worker opened in the work drawer is a second ChatPane, mounted INSIDE its
 * parent and handed the parent's `active`. Both then registered the same
 * window-level type-to-focus listener, and the parent — registered first —
 * won: click any non-editable part of the worker you are reading, type, and
 * the PARENT's composer takes the focus. The child's listener sees an editable
 * element already focused and politely declines. Enter sends the message to
 * the wrong conversation.
 *
 * Keeping the parent mounted behind the drawer is what preserves its scroll
 * position, so the fix is not to unmount it — it is for the parent to give up
 * its keyboard claim while something else is in front of it. Asserted on the
 * source because the bug is which listener EXISTS, and a jsdom test of two
 * mounted ChatPanes would be testing the whole chat to check one gate.
 */
const src = readFileSync(join(import.meta.dirname, 'ChatPane.tsx'), 'utf8');

describe('type-to-focus', () => {
  it('is gated on more than `active`, which a nested pane inherits', () => {
    const effect = src.slice(src.indexOf('const onKey = (e: KeyboardEvent) => {'));
    // The guard sits immediately above the listener it protects.
    const guard = src.slice(0, src.indexOf('const onKey = (e: KeyboardEvent) => {'));
    expect(guard.slice(-400)).toContain('if (!active || showingChildChat) return;');
    expect(effect.length).toBeGreaterThan(0);
  });

  it('re-runs when the drawer opens or closes a child', () => {
    // A gate that is not in the dependency list is a gate that is read once.
    expect(src).toContain('}, [active, openTool, openImage, showingChildChat]);');
  });

  it('calls a child on screen a child, whatever the drawer tab says', () => {
    // `drawerOpen` alone is not it: the drawer's own lists are not a chat, and
    // a parent that went deaf while you were reading an artifact list would be
    // the same bug pointed the other way.
    expect(src).toContain('const showingChildChat = drawerOpen && drawer.paneId !== null;');
  });
});
