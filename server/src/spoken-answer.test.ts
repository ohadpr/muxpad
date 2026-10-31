import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spokenAnswerFrom } from './spoken-answer.js';

/**
 * AN AGENT-MODE TURN HAS NO `reply` TOOL, AND NOW HAS A VOICE ANYWAY.
 *
 * Voice hears `speak` frames only, and those come from `reply`, which is
 * registered in Chat mode alone — on purpose: offered in both, 3 of 5 live
 * Agent turns called it AND wrote a closing recap, so the user got the same
 * answer twice, the second time in the third person.
 *
 * The tool is not what Agent mode was missing. Its plain text IS its answer.
 * This picks which part of it was the answer.
 */
describe('the spoken answer in an agent turn', () => {
  it('says nothing for a turn that wrote nothing', () => {
    // A turn of pure tool work genuinely has nothing to say, and inventing a
    // sentence for it is the failure this whole mechanism exists to avoid.
    expect(spokenAnswerFrom(undefined)).toBeNull();
    expect(spokenAnswerFrom('')).toBeNull();
    expect(spokenAnswerFrom('   \n\n  ')).toBeNull();
  });

  it('hands over what the turn said, tail first', () => {
    // It does not try to SELECT the answer out of the prose. The voice model
    // paraphrases whatever it is given, so a little narration riding along
    // costs a clause and a missing paragraph costs the answer.
    const buf = 'Let me check the tests.\n\nAll 212 pass.';
    expect(spokenAnswerFrom(buf)).toContain('All 212 pass.');
  });

  it('keeps an earlier finding AND the status line after it', () => {
    // The old rule chose between them and could choose wrong. Both fit under
    // the cap, so both go — the model decides what to say about them.
    const finding =
      'The 08:00 bulletin ran about eight minutes, so it was being cut roughly three minutes short.';
    const buf = `${finding}\n\nTranscription of the 9 chunks is running (~3 min)… waiting on it.`;
    const out = spokenAnswerFrom(buf) as string;
    expect(out).toContain('cut roughly three minutes short');
    expect(out).toContain('waiting on it');
  });

  it('does not drop a paragraph just because another one is longer', () => {
    const a = 'A paragraph about the first thing, of a perfectly normal length for prose.';
    const b = 'And the answer, which is shorter.';
    expect(spokenAnswerFrom(`${a}\n\n${b}`)).toContain(b);
  });

  it('stops at a sentence rather than starting mid-clause', () => {
    const long = `${'This is a sentence that goes on. '.repeat(80)}END.`;
    const out = spokenAnswerFrom(long) as string;
    expect(out.length).toBeLessThan(1300);
    expect(out).toContain('END.');
    expect(out.startsWith('This is')).toBe(true);
  });

  it('is a selection, never a composition', () => {
    // It must not summarise: the voice model paraphrases, and a server that
    // wrote its own sentence would be putting words in the agent's mouth.
    const buf = 'First part.\n\nThe actual answer is forty-two.';
    const out = spokenAnswerFrom(buf) as string;
    expect(buf).toContain(out);
  });
});

/**
 * A STOPPED TURN SAYS NOTHING. Claude reports an interrupted turn as
 * `turn-done ok:true` — it did stop cleanly — so `ok` cannot tell the two
 * apart, and without a separate flag the Agent-mode synthesis would read out
 * the scratchpad of a turn somebody deliberately cut short. The written chat
 * has guarded exactly this for ages (needsReplyFallback's `interrupted`).
 */
describe('what the server refuses to speak', () => {
  const WS = readFileSync(join(import.meta.dirname, 'ws.ts'), 'utf8');

  it('tracks Stop separately from turn failure', () => {
    expect(WS).toMatch(/stoppedThisTurn: boolean;/);
  });

  it('marks BOTH stop routes, not just the chat socket', () => {
    // `agentBridge.stop` is what `muxpad agent stop`, a cron and a supervisor
    // use. It did not set the flag, so a turn stopped from the CLI still had
    // its working-out read aloud.
    const marks = WS.match(/markStopped\(conn\)/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(2);
    const bridge = WS.slice(WS.indexOf('deps.agentBridge.stop = '));
    expect(bridge.slice(0, bridge.indexOf('};'))).toContain('markStopped(conn)');
  });

  it('does not let turn-start erase a Stop that beat it', () => {
    // A Stop can be issued before the runner's turn-start arrives — the send
    // is relayed, the user stops it a beat later, and the runner announces the
    // turn it is already cancelling. Clearing unconditionally erased it.
    expect(WS).toContain('conn.lastSendAt > conn.stoppedAt) conn.stoppedThisTurn = false');
  });

  it('clears it on a NEW SEND, not on a clock', () => {
    // The first fix used a five-second grace and bought a worse bug: stop A,
    // send B, and B's perfectly good answer was suppressed too because B
    // started inside A's window. A send is unambiguous evidence the user
    // wants to hear this one.
    expect(WS).not.toMatch(/stoppedAt > \d+_?\d*\)/);
  });

  it('gates the synthesis on it, not only on ok', () => {
    const i = WS.indexOf('spokenAnswerFrom(');
    const guard = WS.slice(Math.max(0, i - 1400), i);
    expect(guard).toContain('!conn.stoppedThisTurn');
    expect(guard).toContain('!conn.spokeThisTurn');
  });
});

/**
 * An answer that runs to several paragraphs arrives whole. The first version
 * sliced with `Math.max(i, length - 4)` and the selector ordinarily returns
 * the LAST paragraph, so the max always won and the allowance kept exactly
 * one — a three-paragraph explanation was spoken as its final sentence.
 */
describe('a multi-paragraph answer', () => {
  it('is not cut down to its last line', () => {
    const buf = [
      'Let me look at the build.',
      'The failure is a missing peer dependency, not your change.',
      'Install it with pnpm add -D vite-plugin-foo.',
      'Then retry the build.',
    ].join('\n\n');
    const out = spokenAnswerFrom(buf) as string;
    expect(out).toContain('missing peer dependency');
    expect(out).toContain('Then retry the build.');
  });

  it('cuts from the END when the turn is long, never from the answer', () => {
    // The answer is at the end of a turn, so an over-long buffer loses its
    // beginning.
    const long = `${'Narration that goes on and on. '.repeat(80)}THE ANSWER IS FORTY-TWO.`;
    const out = spokenAnswerFrom(long) as string;
    expect(out).toContain('THE ANSWER IS FORTY-TWO.');
    expect(out.length).toBeLessThan(1300);
  });
});
