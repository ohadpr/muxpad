import { describe, expect, it } from 'vitest';
import { describeRequest, marksFor } from './approval-request';

describe('marks say what is read', () => {
  it('reads the mark from the verb for every live msgvault action', () => {
    expect(marksFor('msgvault.search')).toEqual(['gmail']);
    expect(marksFor('msgvault.show-message')).toEqual(['gmail']);
    expect(marksFor('msgvault.show-thread')).toEqual(['gmail']);
    // The one verb that genuinely spans the archive.
    expect(marksFor('msgvault.stats')).toEqual(['gmail', 'calendar', 'contacts']);
  });

  it('gives an unknown verb NO mark rather than a guessed one', () => {
    expect(marksFor('msgvault.something-new')).toEqual([]);
    expect(marksFor('nonsense')).toEqual([]);
  });

  it('never lets the payload change the mark', () => {
    // A query about a meeting is still a MAIL read. A mark inferred from the
    // text would be wrong the moment somebody emails about a standup.
    const calendarish = { query: 'standup invite calendar meeting' };
    expect(marksFor('msgvault.search')).toEqual(['gmail']);
    expect(describeRequest('msgvault.search', calendarish).title).toBe('Search your mail');
  });

  it('marks every Slack verb as Slack', () => {
    for (const a of ['slack.post', 'slack.read', 'slack.upload'])
      expect(marksFor(a)).toEqual(['slack']);
  });
});

describe('the headline is the verb with its object', () => {
  it('names the channel a post is going to', () => {
    expect(describeRequest('slack.post', { channel: 'eng', text: 'hi' }).title).toBe(
      'Post to #eng',
    );
    // An id is NOT dressed up as a name.
    expect(describeRequest('slack.post', { channel: 'C123', text: 'hi' }).title).toBe(
      'Post to C123',
    );
  });

  it('says a post goes out as you, with the prefix the broker adds', () => {
    expect(describeRequest('slack.post', { channel: 'eng', text: 'hi' }).qualifier).toBe(
      'as you, prefixed 🤖',
    );
    expect(
      describeRequest('slack.post', { channel: 'eng', text: 'hi', thread_ts: '1.1' }).qualifier,
    ).toContain('reply in thread');
  });

  it('says plainly that totals are not content', () => {
    expect(describeRequest('msgvault.stats', {}).qualifier).toBe(
      'counts only — no message content',
    );
  });

  it('carries the real limit into the qualifier', () => {
    expect(describeRequest('msgvault.search', { query: 'x', limit: 50 }).qualifier).toBe(
      'read-only · up to 50 results',
    );
    expect(describeRequest('msgvault.search', { query: 'x' }).qualifier).toBe('read-only');
  });

  it('does not invent a verb it has no rule for', () => {
    const d = describeRequest('slack.pin', { channel: 'eng' });
    expect(d.title).toBe('Slack · pin');
    expect(d.qualifier).toBeUndefined();
  });
});

describe('the whole payload is on screen', () => {
  it('promotes the field the decision turns on and keeps every other one', () => {
    const d = describeRequest('slack.post', {
      channel: 'C123',
      text: 'deploy is green',
      metadata: { keep: 'exact' },
    });
    expect(d.primary).toEqual({ key: 'text', value: 'deploy is green' });
    expect(d.rest).toEqual([
      ['channel', 'C123'],
      ['metadata', '{"keep":"exact"}'],
    ]);
  });

  it('shows a field it has no rule for, rather than dropping it', () => {
    const d = describeRequest('slack.pin', { channel: 'eng', ts: '1.1' });
    expect(d.primary).toBeUndefined();
    expect(d.rest).toEqual([
      ['channel', 'eng'],
      ['ts', '1.1'],
    ]);
  });

  it('never shows the same value twice', () => {
    const d = describeRequest('msgvault.search', { query: 'from:vuori', limit: 50 });
    expect(d.primary?.value).toBe('from:vuori');
    expect(d.rest.map(([k]) => k)).not.toContain('query');
  });

  it('drops empty values rather than printing a blank row', () => {
    expect(describeRequest('slack.read', { channel: 'eng', cursor: '' }).rest).toEqual([
      ['channel', 'eng'],
    ]);
  });

  it('survives a payload that is not an object', () => {
    expect(() =>
      describeRequest('msgvault.stats', undefined as unknown as Record<string, unknown>),
    ).not.toThrow();
  });
});
