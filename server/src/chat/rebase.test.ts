import { describe, expect, it } from 'vitest';
import { rebaseCorpus, rebasePrompt, wrapRebase } from './rebase.js';

/**
 * What goes INTO the briefing decides what the next session believes about a
 * piece of work it cannot see. That is worth checking against fixtures.
 */
const user = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asst = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

describe('the corpus a rebase reads', () => {
  it('takes the whole thing when it is short, and says so', () => {
    const raw = [user('build me a thing'), asst('done'), user('now fix it')].join('\n');
    const c = rebaseCorpus(raw, 'claude');
    expect(c.whole).toBe(true);
    // No separate opening: with no gap the tail IS the conversation, and a model
    // shown the same turns twice reports the opening as if it recurred at the end.
    expect(c.head).toBe('');
    expect(c.tail).toContain('build me a thing');
    expect(c.tail).toContain('now fix it');
  });

  it('takes both ends of a long one, and marks the gap', () => {
    const middle = Array.from({ length: 4000 }, (_, i) => asst(`step ${i}`));
    const raw = [user('THE ORIGINAL ASK'), ...middle, user('THE LATEST WORD')].join('\n');
    const c = rebaseCorpus(raw, 'claude');
    expect(c.whole).toBe(false);
    expect(c.head).toContain('THE ORIGINAL ASK');
    expect(c.tail).toContain('THE LATEST WORD');
    // The opening must NOT be in the tail: that is what makes the gap honest.
    expect(c.tail).not.toContain('THE ORIGINAL ASK');
  });

  it('labels the thread with the first thing the user asked', () => {
    const raw = [asst('hello'), user('port the broker to linux'), asst('ok')].join('\n');
    expect(rebaseCorpus(raw, 'claude').title).toBe('port the broker to linux');
  });

  it('survives a truncated or non-JSON line', () => {
    // A live transcript's last line is routinely half-written.
    const raw = [user('still here'), '{"type":"assis', ''].join('\n');
    expect(rebaseCorpus(raw, 'claude').tail).toContain('still here');
  });
});

describe('the prompt', () => {
  const c = rebaseCorpus([user('a'), asst('b')].join('\n'), 'claude');

  it('asks for the reasons behind decisions, not just the decisions', () => {
    // A decision whose reason is lost gets relitigated, which is the most
    // expensive thing a rebased chat can do.
    expect(rebasePrompt(c)).toMatch(/REASONS/);
    expect(rebasePrompt(c)).toMatch(/rejected/);
  });

  it('asks for the tool and environment talk to be LEFT OUT', () => {
    // The whole point: that half is stale, and the new session gets it fresh.
    const p = rebasePrompt(c);
    expect(p).toMatch(/EXCLUDE/);
    expect(p).toMatch(/tools, commands, flags/);
  });

  it('tells the model not to bridge a gap it cannot see', () => {
    const long = rebaseCorpus(
      [user('start'), ...Array.from({ length: 4000 }, (_, i) => asst(`s${i}`))].join('\n'),
      'claude',
    );
    expect(rebasePrompt(long)).toMatch(/Do not invent what happened in the gap/);
    // …and the short case must not claim a gap that does not exist.
    expect(rebasePrompt(c)).toMatch(/complete conversation follows/);
  });
});

describe('the wrapper', () => {
  it('says the history is gone from the window and the tools are the new ones', () => {
    // The single failure mode of this feature is a fresh agent that
    // half-remembers the old build.
    const w = wrapRebase('goal: ship it');
    expect(w).toContain('<muxpad-rebase>');
    expect(w).toMatch(/NOT in your window/);
    expect(w).toMatch(/CURRENT instructions/);
    expect(w).toContain('goal: ship it');
  });
});
