import { describe, expect, it } from 'vitest';
import { STANDING_RULES } from '../agent-instructions.js';
import { turnPreamble } from './preamble.js';

/**
 * THE RULE THAT HELD ON ONE HARNESS AND EVAPORATED ON TWO.
 *
 * claude gets a system prompt, re-sent with every request. codex and cursor
 * have no such surface, so muxpad prepended its instructions to the first
 * user message of a session — and then never again, on the reasoning that "a
 * resume already carries it in-thread".
 *
 * It does not. A message ages, is summarised, is compacted away. Measured on
 * a four-day-old codex pane: 2,392 turns, 6.5 MB, ZERO occurrences of the
 * instruction block or of any rule in it — and that pane then sent a Slack DM
 * to a colleague as a bot, unapproved, from a token it found on disk. Three
 * explicit prohibitions, none of which it had ever seen.
 */
const FULL = 'FULL DOCUMENT\n\n## muxpad’s standing rules\nthe rules\n';

describe('turnPreamble', () => {
  it('gives the first turn of a runner the whole document', () => {
    const out = turnPreamble({
      prompt: 'do the thing',
      instructionsInThread: false,
      instructions: FULL,
    });
    expect(out).toContain('FULL DOCUMENT');
    expect(out).toContain('<muxpad-instructions>');
    expect(out.endsWith('do the thing')).toBe(true);
  });

  it('gives EVERY turn after it the standing rules — the whole point', () => {
    const out = turnPreamble({
      prompt: 'do the thing',
      instructionsInThread: true,
      instructions: FULL,
    });
    expect(out).toContain(STANDING_RULES.split('\n')[0] as string);
    expect(out.endsWith('do the thing')).toBe(true);
  });

  it('never sends both — the card is inside the document', () => {
    const fresh = turnPreamble({ prompt: 'x', instructionsInThread: false, instructions: FULL });
    expect(fresh.match(/<muxpad-instructions>/g)).toHaveLength(1);
  });

  it('carries the rules whose absence caused the incident', () => {
    const resumed = turnPreamble({ prompt: 'x', instructionsInThread: true, instructions: FULL });
    // Slack identity, Slack approval, and the credentials fallback.
    expect(resumed).toMatch(/muxpad slack post/);
    expect(resumed.toLowerCase()).toMatch(/approval/);
    expect(resumed.toLowerCase()).toMatch(/credentials off disk|credentials fallback/);
    // …and the other two that are invisible when they go wrong.
    expect(resumed).toMatch(/muxpad agent new/);
    expect(resumed).toMatch(/muxpad cron/);
    // And setsid, which is invisible in a third way: the work is started, it
    // reports started, and it is dead by the time anyone looks. It has to be
    // on the CARD and not only in the document — a codex pane gets the
    // document once per runner start and the card every turn, so a pane that
    // is already running would otherwise never be told.
    expect(resumed).toMatch(/setsid/);
    expect(resumed).toMatch(/start_new_session/);
  });

  it('is cheap enough to send on every turn', () => {
    // The full document is ~33 KB. Re-sending THAT per turn would pay for the
    // rules in exactly the context pressure that lost them.
    //
    // Raised 2,500 → 2,700 on 2026-11-19, deliberately, for ONE bullet: the
    // publish TRIGGER. It had been left in the help page when the manual moved
    // out, and an agent that never thought to read that page handed back a
    // local file path and hand-rolled an http.server instead — twice, in two
    // different chats. +223 chars (~56 tokens) a turn is the cheapest fix
    // there is for a rule that only works if it is already in front of you.
    //
    // Raised 2,700 → 2,800 on 2026-11-23, for one more: setsid. Measured
    // outside the cockpit — a bare `codex exec` in an empty directory — a
    // command started the ordinary way is killed the instant the turn's
    // process exits, because codex tears its session down at turn.completed
    // and that kills the command groups it holds. A worker lost a scoring run
    // to it and spent its next hour building a terminal-based workaround.
    //
    // It is HERE rather than only in the document for the reason the document
    // cannot cover: codex gets the full text on the first turn after a runner
    // start and the card every turn after, so a pane already running would
    // never have seen it. +190 chars (~48 tokens).
    expect(STANDING_RULES.length).toBeLessThan(2800);
    expect(STANDING_RULES.length).toBeGreaterThan(400);
  });

  it('carries the publish trigger, not just a reference to the verb', () => {
    // Naming `muxpad publish` is not the rule; knowing WHEN is.
    expect(STANDING_RULES).toContain('IT, HAND BACK THE URL');
    expect(STANDING_RULES).toContain('not a hand-rolled server');
  });

  it('appends a mode overlay after the rules, not before', () => {
    const out = turnPreamble({
      prompt: 'x',
      instructionsInThread: true,
      instructions: FULL,
      modeOverlay: 'be terse',
    });
    expect(out.indexOf('<muxpad-instructions>')).toBeLessThan(out.indexOf('<muxpad-mode>'));
  });

  it('falls back to the card when there is no document to send', () => {
    // The document is read off disk. Missing, empty, or a data dir holding
    // only the user's own notes used to mean a fresh session with ZERO rules
    // — the state the Slack DM was sent from. The card is compiled in.
    const out = turnPreamble({ prompt: 'x', instructionsInThread: false, instructions: null });
    expect(out).toContain(STANDING_RULES.split('\n')[0] as string);
    expect(out.endsWith('x')).toBe(true);
    expect(
      turnPreamble({ prompt: 'x', instructionsInThread: false, instructions: '   ' }),
    ).toContain('muxpad slack post');
  });

  it('sends the document ONCE per runner, not once per turn', () => {
    const first = turnPreamble({ prompt: 'x', instructionsInThread: false, instructions: FULL });
    const rest = turnPreamble({ prompt: 'x', instructionsInThread: true, instructions: FULL });
    expect(first).toContain('FULL DOCUMENT');
    expect(rest).not.toContain('FULL DOCUMENT');
    expect(rest).toContain('muxpad slack post');
  });

  it('injects nothing when there is nothing to inject', () => {
    expect(
      turnPreamble({
        prompt: 'bare',
        instructionsInThread: false,
        instructions: null,
        standing: '',
      }),
    ).toBe('bare');
    expect(
      turnPreamble({
        prompt: 'bare',
        instructionsInThread: true,
        instructions: null,
        standing: '',
      }),
    ).toBe('bare');
  });
});

describe('STANDING_RULES is one text, not two', () => {
  it('is embedded verbatim in the document the file is generated from', async () => {
    // Two copies of a rule drift, and the drift is invisible: the file says
    // one thing and the per-turn card says another, and nobody reads both.
    const { AGENT_INSTRUCTIONS_SEED } = await import('../agent-instructions.js');
    expect(AGENT_INSTRUCTIONS_SEED).toContain(STANDING_RULES);
  });
});
