import { readFileSync, readdirSync } from 'node:fs';
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
    expect(labelled.slice(0, labelled.lastIndexOf(') : ('))).toMatch(/chat-tool-btn/);
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
    const el = SRC.slice(SRC.indexOf('const composerTools = collapsedTools ? ('));
    const expanded = el.slice(el.indexOf(') : labelledTools ? ('));
    expect(expanded).toMatch(/<ReviewButton/);
    expect(expanded).toMatch(/<VoiceControl/);
    expect(expanded).toMatch(/className="chat-attach"/);
  });

  it('spends a whole ROW on the tools only where there are labels to carry', () => {
    // A phone keeps its `+` beside the input: a row for one button is the
    // cost this exercise exists to remove, and the mock-up's phone has no
    // tool row at all.
    expect(SRC).toMatch(/\{!labelledTools \? composerTools : null\}/);
    expect(SRC).toMatch(/\{labelledTools \? \(\s*<div className="chat-composer-tools">/);
  });

  it('opens its sheet upward, away from the bottom of the screen', () => {
    const rest = CSS.slice(CSS.indexOf('.chat-tools-sheet {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/bottom:\s*calc\(100% \+/);
    expect(rule).toMatch(/left:\s*0/);
  });
});

/**
 * THE MOCK-UP'S ARRANGEMENT, point by point — because the last three
 * revisions each drifted from it in a different place and the report each
 * time was a version of "that is not what you drew".
 */
describe('faithful to the mock', () => {
  it('puts the mic in the SEND slot, not a label on the tool row', () => {
    // mic → send → queue, one slot. Dictation replaces typing; it does not add
    // something to a message you are writing, which is what every row on the
    // tool row does.
    expect(SRC).toMatch(/micInsteadOfSend \? \(/);
    expect(SRC).toMatch(/className="chat-send is-mic"/);
    const labelled = SRC.slice(SRC.indexOf(') : labelledTools ? ('));
    expect(labelled.slice(0, labelled.lastIndexOf(') : ('))).not.toMatch(/Dictate\n/);
  });

  it('ends the tool row with what Enter does right now', () => {
    expect(SRC).toMatch(/className="chat-tools-hint"/);
    expect(SRC).toMatch(/⏎ send · ⇧⏎ newline/);
    expect(SRC).toMatch(/queues behind the running turn/);
  });

  it('sets the tool row in the UI face, never the chrome face', () => {
    // --chrome-font is a MONO on several themes (blueprint, riso, demoscene),
    // and three mono labels inside a surface that is otherwise all prose read
    // as terminal output bolted into the composer.
    const rest = CSS.slice(CSS.indexOf('.chat-tool-btn {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/font-family:\s*var\(--ui-font/);
    expect(rule).not.toMatch(/--chrome-font/);
  });

  it('keeps the tool row flush with the input, not inset like a toolbar', () => {
    const rest = CSS.slice(CSS.indexOf('.chat-composer-tools {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    // No side padding of its own: the pill's padding already set the text
    // column, and the icons line up with the first letter you type.
    expect(rule).toMatch(/padding:\s*0 0 2px/);
  });
});

/**
 * NO DEAD RULES IN THE CHAT'S OWN STYLESHEET.
 *
 * themes.test.ts already fails on a THEME selector that matches nothing —
 * "a rule that matches nothing renders exactly like a rule that works" — and
 * the component's own sheet had four of them: the caret that used to reveal a
 * folded cron's prompt (`.chat-sysnote-chevron`, `.chat-sysnote-body` and its
 * folded width), the paperclip's upload spinner (`.chat-attach-spin`), and the
 * wrapper of the folder cell (`.chat-folder`) that the pane head replaced.
 */
describe('ChatPane.css names nothing the app never renders', () => {
  const RENDERED = (() => {
    const read = (dir: string): string => {
      let out = '';
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out += read(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.'))
          out += readFileSync(full, 'utf8');
      }
      return out;
    };
    return read(join(__dirname, '..'));
  })();

  it('finds the classes to check at all', () => {
    expect(RENDERED.length).toBeGreaterThan(10_000);
  });

  it('has no chat-* class the source never mentions', () => {
    // Comments stripped: several of them NAME a deleted class to say why it
    // is gone. Dynamic names count as rendered — `chat-sysnote-${variant}`
    // builds `.chat-sysnote-report` from NOTICE_ICON, so the substring test
    // is deliberate rather than lazy.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const styled = new Set([...flat.matchAll(/\.(chat-[a-z0-9-]+)/g)].map((m) => m[1] as string));
    const dead = [...styled].filter(
      (c) => !RENDERED.includes(c) && !RENDERED.includes(c.replace(/-[a-z0-9]+$/, '-$')),
    );
    expect(dead, 'these rules match nothing').toEqual([]);
  });
});
