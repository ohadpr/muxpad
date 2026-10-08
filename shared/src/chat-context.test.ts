import { describe, expect, it } from 'vitest';
import {
  type MentionedChat,
  hasMentionContext,
  stripMentionContext,
  withMentionContext,
} from './chat-context.js';

/**
 * The `@mention` as a handle. It replaced a rule that ROUTED the message to the
 * mentioned chat — "I wrote you a message and mentioned another tab, and what
 * you did was take what I wrote and send it to that tab."
 */
const chat = (over: Partial<MentionedChat> = {}): MentionedChat => ({
  name: 'Investing',
  tabId: 'T1',
  paneIds: ['P1', 'P2'],
  ...over,
});

describe('mention context', () => {
  it('leaves an ordinary message byte-for-byte alone', () => {
    // The overwhelmingly common message mentions nothing, and must not grow a
    // block for it.
    expect(withMentionContext('what time is it?', [])).toBe('what time is it?');
  });

  it('puts the handles AFTER the words', () => {
    // Their sentence is the message; this is an annotation on it. A block on
    // top reads as the instruction and demotes what they actually said.
    const out = withMentionContext('what did we decide?', [chat()]);
    expect(out.indexOf('what did we decide?')).toBeLessThan(out.indexOf('<muxpad-context'));
  });

  it('carries ids, not just a name', () => {
    // A name is guesswork the moment two chats are called "Main".
    const out = withMentionContext('x', [chat()]);
    expect(out).toContain('tab T1');
    expect(out).toContain('P1 P2');
    expect(out).toContain('@Investing');
  });

  it('says it is a reference and forbids forwarding', () => {
    // The whole point of the change: the agent decides, and must not re-enact
    // the router it replaced.
    const out = withMentionContext('x', [chat()]);
    expect(out).toMatch(/REFERENCE, not an instruction to forward/);
    expect(out).toMatch(/Do NOT forward the user's message/);
  });

  it('offers the cheap look first', () => {
    const out = withMentionContext('x', [chat()]);
    expect(out.indexOf('pane summarize')).toBeLessThan(out.indexOf('agent transcript'));
  });

  it('handles several mentions, and a chat with no panes', () => {
    const out = withMentionContext('x', [chat(), chat({ name: 'Main', tabId: 'T2', paneIds: [] })]);
    expect(out).toContain('count="2"');
    expect(out).toContain('(no panes)');
  });

  it('round-trips — the block can be removed to get the typed text back', () => {
    const typed = 'what did @Investing decide?';
    const sent = withMentionContext(typed, [chat()]);
    expect(hasMentionContext(sent)).toBe(true);
    expect(stripMentionContext(sent)).toBe(typed);
  });

  it('strips nothing from a message that has none', () => {
    expect(hasMentionContext('plain')).toBe(false);
    expect(stripMentionContext('plain')).toBe('plain');
  });

  it('only strips a TRAILING block, not a mention of one mid-message', () => {
    // Same rule the other markers use: text that merely talks about the tag is
    // prose.
    const prose = 'the <muxpad-context> block is how mentions work</muxpad-context> here';
    expect(hasMentionContext(prose)).toBe(false);
  });
});
