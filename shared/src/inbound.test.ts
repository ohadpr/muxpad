import { describe, expect, it } from 'vitest';
import { inboundTextKey } from './inbound.js';

describe('inboundTextKey', () => {
  it('is stable for the same text', () => {
    expect(inboundTextKey('go and check the PRs')).toBe(inboundTextKey('go and check the PRs'));
  });

  it('ignores surrounding whitespace, because submitSend trims before it relays', () => {
    // The server trims on the way in (ws.ts submitSend), so the text that
    // reaches the transcript is the trimmed form — a heredoc's trailing newline
    // must not cost the message its card.
    expect(inboundTextKey('  a brief\n')).toBe(inboundTextKey('a brief'));
  });

  it('separates texts that differ only at the end', () => {
    expect(inboundTextKey('run the suite')).not.toBe(inboundTextKey('run the suites'));
  });

  it('separates texts of the same length', () => {
    expect(inboundTextKey('abcd')).not.toBe(inboundTextKey('abce'));
  });

  it('survives a message far longer than any bubble', () => {
    // The case this exists for: a coordinator's several-hundred-line brief.
    const brief = `${'a long paragraph about the work. '.repeat(400)}end`;
    expect(inboundTextKey(brief)).toBe(inboundTextKey(brief));
    expect(inboundTextKey(brief)).not.toBe(inboundTextKey(`${brief}x`));
  });

  it('is a plain token — safe in a URL and as a map key', () => {
    expect(inboundTextKey('hello world')).toMatch(/^[0-9a-z]+\.[0-9a-z]+$/);
  });
});
