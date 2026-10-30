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

  it('takes the last block when the turn simply answers', () => {
    const buf = 'Let me check the tests.\n\nAll 212 pass.';
    expect(spokenAnswerFrom(buf)).toBe('All 212 pass.');
  });

  it('does not read out a status line over the finding it hid', () => {
    // The measured failure: a turn's final words are very often a status note
    // rather than its result.
    const finding = `The 08:00 bulletin ran about eight minutes, so it was being cut roughly three minutes short. ${'x'.repeat(400)}`;
    const buf = `${finding}\n\nTranscription of the 9 chunks is running (~3 min)… waiting on it.`;
    expect(spokenAnswerFrom(buf)).toContain('cut roughly three minutes short');
  });

  it('keeps the last block when the two are ordinary paragraphs', () => {
    // The thresholds must not fire on prose that is merely longer.
    const a = 'A paragraph about the first thing, of a perfectly normal length for prose.';
    const b = 'And the answer, which is shorter.';
    expect(spokenAnswerFrom(`${a}\n\n${b}`)).toBe(b);
  });

  it('stops at a sentence rather than reading an essay aloud', () => {
    // A long agent answer is a WRITTEN artifact — tables, paths, code — and
    // the screen keeps the rest.
    const long = `${'This is a sentence that goes on. '.repeat(80)}END.`;
    const out = spokenAnswerFrom(long) as string;
    expect(out.length).toBeLessThan(1300);
    expect(out.endsWith('.')).toBe(true);
    expect(out).not.toContain('END.');
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
