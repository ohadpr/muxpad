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
  it('collapses only on a touch LAYOUT, from the shared breakpoint', () => {
    // Not a user-agent sniff and not a second number: the same media query
    // every other mobile decision in the app reads.
    expect(SRC).toMatch(/useMediaQuery\(MOBILE_BREAKPOINT\)/);
    expect(SRC).toMatch(/collapsedTools = touchLayout && toolsIdle/);
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

  it('keeps the full row on desktop, where there is room and hover', () => {
    const branch = SRC.slice(SRC.indexOf('{collapsedTools ? ('));
    const desktop = branch.slice(branch.indexOf(') : ('));
    expect(desktop).toMatch(/<ReviewButton/);
    expect(desktop).toMatch(/<VoiceControl/);
    expect(desktop).toMatch(/className="chat-attach"/);
  });

  it('opens its sheet upward, away from the bottom of the screen', () => {
    const rest = CSS.slice(CSS.indexOf('.chat-tools-sheet {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/bottom:\s*calc\(100% \+/);
    expect(rule).toMatch(/left:\s*0/);
  });
});
