import { describe, expect, it } from 'vitest';
import { contextHeal, isContextOverflow } from './context-heal.js';

/**
 * The failure, verbatim from the report: a chat at 98% answering every send
 * with `Prompt is too long` — twice in a row, with no way out, because the
 * only thing that makes room is a message the chat can no longer accept.
 */
describe('isContextOverflow', () => {
  it('knows the string the user actually saw', () => {
    expect(isContextOverflow('Prompt is too long')).toBe(true);
    // As it really arrives: wrapped in the provider's envelope.
    expect(
      isContextOverflow('API Error: 400 {"type":"error","error":{"message":"prompt is too long"}}'),
    ).toBe(true);
  });

  it('knows the same failure under its other names', () => {
    for (const s of [
      'context_length_exceeded',
      'This model’s maximum context length is 200000 tokens',
      'input length and `max_tokens` exceed context limit',
      'Request too large for model',
    ])
      expect(isContextOverflow(s)).toBe(true);
  });

  it('is not fooled by other failures', () => {
    for (const s of [
      'Not logged in · Please run /login',
      'rate limit exceeded',
      'stop failed — turn state reset',
      '',
      null,
      undefined,
    ])
      expect(isContextOverflow(s)).toBe(false);
  });
});

describe('contextHeal', () => {
  const over = 'Prompt is too long';

  it('compacts and retries the message that failed', () => {
    const d = contextHeal({ error: over, pending: 'give me variants', alreadyTried: false });
    expect(d.act).toBe('compact');
    expect(d).toMatchObject({ retry: 'give me variants' });
    // It has to SAY it compacted. This is the user's history being spent.
    expect((d as { notice: string }).notice).toMatch(/compacted/i);
  });

  it('compacts for a turn nobody typed, with nothing to retry', () => {
    // A cron fire that hit the wall still has to leave a session the NEXT
    // fire can use.
    const d = contextHeal({ error: over, pending: null, alreadyTried: false });
    expect(d).toMatchObject({ act: 'compact', retry: '' });
  });

  it('gives up after ONE attempt, and says what to do instead', () => {
    const d = contextHeal({ error: over, pending: 'x', alreadyTried: true });
    expect(d.act).toBe('give-up');
    // A single message can be bigger than the window; compacting the history
    // again cannot fix that, and looping would spend the whole conversation.
    expect((d as { notice: string }).notice).toMatch(/fresh chat|as a file/i);
  });

  it('does nothing for any other failure', () => {
    expect(contextHeal({ error: 'rate limited', pending: 'x', alreadyTried: false })).toEqual({
      act: 'none',
    });
  });
});

describe('the loop it must not be', () => {
  it('never compacts in response to a failed /compact', () => {
    // The compaction is itself a turn. Healing it would compact again, and
    // again — a real model call each time against a conversation that is
    // never going to fit, which is the runaway version of the behaviour this
    // whole design exists to avoid.
    const d = contextHeal({
      error: 'Prompt is too long',
      pending: '/compact Preserve the specifics…',
      alreadyTried: false,
    });
    expect(d.act).toBe('give-up');
    expect((d as { notice: string }).notice).toMatch(/fresh chat/i);
  });

  it('…and the same for any other session command', () => {
    expect(
      contextHeal({ error: 'prompt is too long', pending: '/clear', alreadyTried: false }).act,
    ).toBe('give-up');
  });
});
