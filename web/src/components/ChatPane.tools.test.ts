import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE LEFT CLUSTER COLLAPSES ON TOUCH, AND ONLY WHILE IT IS IDLE.
 *
 * Three permanent targets — attach, review a screen, dictate — for actions
 * taken a few times a day each, eating ~90px of a 360px pill: "there are too
 * many buttons in the composer window itself on mobile."
 *
 * The two conditions are independent, which is the part worth pinning: the
 * LAYOUT decides whether there is room for a row, and the STATE decides
 * whether any of them is currently more than a button.
 */
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

describe('the composer tools', () => {
  it('gives each layout the shape that layout can read', () => {
    // Touch gets one `+` and a sheet. Desktop gets the same actions as
    // LABELLED buttons on the tool row — not bare icons, which is what "I see
    // multiple buttons on the left, doesn't feel like anything changed" was
    // looking at, and which really is indistinguishable from what it replaced.
    expect(SRC).toMatch(/const collapsedTools = toolsIdle && touchLayout;/);
    expect(SRC).toMatch(/const labelledTools = toolsIdle && !touchLayout;/);
    const labelled = SRC.slice(SRC.indexOf(') : labelledTools ? ('));
    expect(labelled.slice(0, labelled.indexOf(') : ('))).toMatch(/chat-tool-btn/);
  });

  it('pops a LIVE control back out of the sheet', () => {
    // A recording in progress is not an action waiting to be taken, it is the
    // thing you are doing — its elapsed time and its stop have to stay
    // reachable, which they are not from behind a `+`.
    expect(SRC).toMatch(
      /toolsIdle =\s*review\.state\.phase === 'idle' && !voiceIsLive\(voice\.state\)/,
    );
  });

  it('closes the sheet when the + that opened it goes away', () => {
    // A control going live (or a rotation to the desktop layout) removes the
    // button the sheet hangs from; the sheet must not outlive it.
    expect(SRC).toMatch(/if \(!collapsedTools\) setToolsOpen\(false\);/);
  });

  it('still has the full row to fall back to, for a LIVE control', () => {
    // The expanded branch is not dead code: it is what renders while a screen
    // review or the mic is running, because that is state rather than an
    // action and its stop has to stay reachable.
    const branch = SRC.slice(SRC.indexOf('{collapsedTools ? ('));
    const expanded = branch.slice(branch.indexOf(') : ('));
    expect(expanded).toMatch(/<ReviewButton/);
    expect(expanded).toMatch(/<VoiceControl/);
    expect(expanded).toMatch(/className="chat-attach"/);
  });

  it('opens its sheet upward, away from the bottom of the screen', () => {
    const rest = CSS.slice(CSS.indexOf('.chat-tools-sheet {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/bottom:\s*calc\(100% \+/);
    expect(rule).toMatch(/left:\s*0/);
  });
});
