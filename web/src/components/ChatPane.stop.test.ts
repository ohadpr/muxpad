import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE BUTTON ON THE COMPOSER'S RIGHT EDGE, IN EVERY STATE — INCLUDING STOP.
 *
 * This has been wrong in both directions and the record is worth keeping.
 *
 *   FIRST: while a turn ran and something was typed, the composer drew TWO
 *     circles side by side, Queue and Stop. "You have both a send and a stop
 *     button and they're both horizontally presented."
 *   THEN: Stop moved to the foot of the running turn, on the grounds that the
 *     composer's button acts on your DRAFT and stopping acts on the agent's
 *     TURN. Defensible, and worse in practice. A photo of a phone settled it:
 *     the fold on the left, a Stop pill floating alone on the right attached
 *     to nothing, the composer beneath both — three rows of chrome for one
 *     running turn. "Look at this soup especially on mobile."
 *
 * The resolution is neither: ONE slot, and Stop takes it only in the state
 * where the slot has no job — a turn running with nothing typed, where the
 * alternative was a DISABLED Queue. A dead target in the most valuable 36px
 * of the composer, in the one state with exactly one thing a person wants to
 * do.
 */
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

describe('the composer holds one button, and Stop is one of its faces', () => {
  it('is NEVER two circles — the defect that started all of this', () => {
    // The branches are mutually exclusive by construction: Stop is the
    // `!canSend` arm of the busy branch and Queue is the other, so no state
    // can render both.
    expect(SRC).toMatch(/\{sending && !question && !canSend \? \(/);
    expect(SRC).toMatch(/\) : sending && !question \? \(/);
  });

  it('stops the turn when a turn is running and nothing is typed', () => {
    const busy = SRC.slice(SRC.indexOf('{sending && !question && !canSend ? ('));
    const stop = busy.slice(0, busy.indexOf(') : sending && !question ? ('));
    expect(stop).toMatch(/className="chat-send is-stop"/);
    expect(stop).toMatch(/onClick=\{stop\}/);
    expect(stop).toMatch(/aria-label="Stop this turn"/);
    // NOT disabled: this is the state that used to render a dead Queue.
    expect(stop).not.toMatch(/disabled=/);
  });

  it('gives the slot back to the draft the moment you type', () => {
    const busy = SRC.slice(SRC.indexOf(') : sending && !question ? ('));
    const queue = busy.slice(0, busy.indexOf(') : micInsteadOfSend ? ('));
    expect(queue).toMatch(/className="chat-send is-queue"/);
    // ONE FUNCTION DECIDES IT, for every button and for the send path itself.
    expect(queue).toMatch(/disabled=\{!canSend\}/);
  });

  it('wears `.chat-send`, so a theme cannot forget it', () => {
    // memphis, riso and blueprint all restyle `.chat-send`. A bespoke circle
    // here would be the one control in the composer that ignored the theme —
    // the same trap the Queue glyph was written to avoid.
    expect(CSS).toMatch(/\.chat-send\.is-stop \.chat-stop-glyph/);
    expect(SRC).toMatch(/className="chat-send is-stop"/);
  });

  it('leaves no Stop in the transcript', () => {
    // The floating pill is gone: the log is a record, and the one control
    // that acts on a live turn lives where your thumb already is.
    expect(SRC).not.toMatch(/chat-turn-stop/);
    expect(CSS).not.toMatch(/\.chat-turn-stop\b/);
  });
});
