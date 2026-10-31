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

  it('spends a ROW only on a desktop, and nothing on a phone', () => {
    // "I don't want that stuff to take up another line." It does not have to:
    // the `+` beside the input already opens a surface for everything you can
    // do to this chat, so on touch the tools AND the session chip live in
    // that sheet — on screen while you use it, gone the rest of the time.
    expect(SRC).toMatch(
      /\{labelledTools \? \(\s*<div className="chat-composer-tools">\s*\{composerTools\}\s*\{sessionStrip\}/,
    );
    // …and the `+` is beside the input when there is no row to hold it.
    expect(SRC).toMatch(/\{!labelledTools \? composerTools : null\}/);
    // The sheet carries the chip, which is what makes the row unnecessary.
    expect(SRC).toMatch(/<div className="chat-tools-session">\{sessionStrip\}<\/div>/);
  });

  it('keeps btw with the commands, not on the session strip', () => {
    // It was an icon on the strip — the one chip there that was a verb. "I
    // don't want the branch icon, give me another command on the left bottom
    // where we already have commands, call it 'btw'."
    expect(SRC).toMatch(/btw…/);
    const start = readFileSync(join(__dirname, 'ChatStart.tsx'), 'utf8');
    expect(start).not.toMatch(/chat-status-seg -branch/);
    // Both surfaces: the labelled row AND the sheet.
    const el = SRC.slice(SRC.indexOf('const composerTools = collapsedTools ? ('));
    const sheet = el.slice(0, el.indexOf(') : labelledTools ? ('));
    expect(sheet).toMatch(/btw…/);
  });

  it('opens its sheet upward, away from the bottom of the screen', () => {
    const rest = CSS.slice(CSS.indexOf('.chat-tools-sheet {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/bottom:\s*calc\(100% \+/);
    expect(rule).toMatch(/left:\s*0/);
  });
});

/**
 * THE MOCK-UP'S ARRANGEMENT, point by point — because several revisions each
 * drifted from it in a different place, and the report each time was a
 * version of "that is not what you drew".
 */
describe('faithful to the mock', () => {
  it('puts the mic in the SEND slot, not a label on the tool row', () => {
    // mic → send → queue, one slot. Dictation replaces typing; it does not add
    // something to a message you are writing, which is what every row on the
    // tool row does.
    expect(SRC).toMatch(/micInsteadOfSend \? \(/);
    // NOT `.chat-send`: that class means "the primary action of this
    // composer", three themes style it, and the mic is what is available when
    // there is nothing to send. See the css for the cascade fight this ends.
    expect(SRC).toMatch(/className="chat-mic"/);
    expect(SRC).not.toMatch(/chat-send is-mic/);
    const labelled = SRC.slice(SRC.indexOf(') : labelledTools ? ('));
    expect(labelled.slice(0, labelled.lastIndexOf(') : ('))).not.toMatch(/Dictate\n/);
  });

  it('ends the tool row with the chat, not with a keyboard hint', () => {
    // The row ended with "⏎ send · ⇧⏎ newline" while it had nothing else to
    // put there. It carries the model chip and Branch now — real controls,
    // which had been sitting at the top of the pane getting asked about — and
    // a third thing on the right would be the crowding that moved them.
    // Enter-to-send is also the one convention in this product nobody has to
    // be taught.
    expect(SRC).not.toMatch(/chat-tools-hint/);
    expect(CSS).not.toMatch(/\.chat-tools-hint\s*\{/);
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

  it('puts its icons on the same vertical line as the text above them', () => {
    // A tool button carries 8px of its own padding, so a row with no margin
    // starts its icons 8px right of the first letter of the input — close
    // enough to read as a mistake rather than as a second row.
    //
    // The pill spends ONE inset (12px). The input pays 4 of it back as its
    // own padding; the row pulls 4 out as a negative margin. Both land on 16.
    const rest = CSS.slice(CSS.indexOf('.chat-composer-tools {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    const pill = CSS.slice(CSS.indexOf('.chat-composer {'));
    const pillPad = /padding:\s*(\d+)px (\d+)px/.exec(pill.slice(0, pill.indexOf('}')));
    const input = CSS.slice(CSS.indexOf('.chat-input {'));
    const inputPad = /padding:\s*[\d.]+rem (\d+)px/.exec(input.slice(0, input.indexOf('}')));
    const btn = CSS.slice(CSS.indexOf('.chat-tool-btn {'));
    const btnPad = /padding:\s*\d+px (\d+)px/.exec(btn.slice(0, btn.indexOf('}')));
    const rowMargin = /margin:\s*0 (-?\d+)px/.exec(rule);
    expect(pillPad?.[2], 'pill side padding').toBeTruthy();
    const side = Number(pillPad?.[2]);
    const text = side + Number(inputPad?.[1]);
    const icon = side + Number(rowMargin?.[1]) + Number(btnPad?.[1]);
    expect(icon, `text at ${text}, icon at ${icon}`).toBe(text);
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

/**
 * ── ARRIVING AT A CHAT PUTS THE CARET IN IT ──────────────────────────────
 *
 * Switching to a chat is almost always the first half of "and now say
 * something". Type-to-focus already covers the moment you start typing; this
 * covers the half second before, where the caret is nowhere.
 */
describe('the composer takes focus on arrival', () => {
  const SRC = readFileSync(join(import.meta.dirname, 'ChatPane.tsx'), 'utf8');
  const effect = (() => {
    const i = SRC.indexOf('ARRIVING AT A CHAT PUTS THE CARET IN IT');
    return i < 0 ? '' : SRC.slice(i, SRC.indexOf('Type-to-focus:', i));
  })();

  it('exists, and re-runs when the pane becomes visible again', () => {
    // A pane that was already mounted and merely became visible never
    // re-runs on `active` alone — the same reason the re-entry effect has it.
    expect(effect, 'no arrival-focus effect').not.toBe('');
    expect(effect).toMatch(/\[active, paneId, showEpoch, openTool, openImage\]/);
  });

  it('does not raise the keyboard on a phone', () => {
    // Arriving at a chat there is at least as often about READING it, and the
    // keyboard covers half the screen. The composer is one tap away.
    expect(effect).toContain('isMobileLayout()');
  });

  it('never steals focus from another field', () => {
    // The search modal, a rename, the picker: arriving with something already
    // focused means the arrival was incidental to what you are doing.
    expect(effect).toMatch(/ae\.tagName === 'INPUT' \|\| ae\.tagName === 'TEXTAREA'/);
    expect(effect).toContain('ae.isContentEditable');
  });

  it('lands at the END of a restored draft', () => {
    // A restored draft is a sentence you were part way through, and its start
    // is the one place you were not.
    expect(effect).toMatch(/setCaret\(input\.length\)/);
  });
});
