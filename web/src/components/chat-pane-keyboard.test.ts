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
 * the PARENT's composer takes the focus. Enter sends the message to the wrong
 * conversation.
 *
 * The rule itself now lives in lib/pane-foreground with its own table of every
 * combination; this file asserts the WIRING, which is the half that was
 * actually wrong — the rule was never stated, so each site stated its own and
 * one of them forgot the drawer.
 */
const src = readFileSync(join(import.meta.dirname, 'ChatPane.tsx'), 'utf8');

describe('type-to-focus', () => {
  it('asks who owns the keyboard rather than re-deriving it', () => {
    const guard = src.slice(0, src.indexOf('const onKey = (e: KeyboardEvent) => {'));
    expect(guard.slice(-300)).toContain('if (!ownsKeyboard(foreground)) return;');
  });

  it('re-runs whenever the foreground changes', () => {
    // A gate that is not in the dependency list is a gate read once.
    expect(src).toContain('}, [foreground]);');
  });

  it('names the states in one place, and the component only reads them', () => {
    // The flags themselves are collapsed into one value, so a new surface in
    // front of the log is a case in the module — not six sites to find.
    expect(src).toContain('drawerPaneId: drawer.paneId,');
    expect(src).not.toContain('const showingChildChat =');
    for (const fn of ['ownsKeyboard', 'showsScrollArrow', 'escapeClearsJump'])
      expect(src, fn).toContain(`${fn}(foreground)`);
  });
});
