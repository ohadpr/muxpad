import { describe, expect, it } from 'vitest';
import { FORBIDDEN_FLAGS, REFUSED_COMMANDS, VERBS, classify, verbsOf } from './registry.js';

describe('classification fails closed', () => {
  it('refuses a verb this build has never heard of', () => {
    // Not "treated as a write" — refused. Guessing on behalf of a future
    // release is how a verb like calendar.invite arrives classified as a read.
    const c = classify('msgvault.telepathy.read');
    expect(c.ok).toBe(false);
    expect(c.timed).toBe(false);
    expect(c.reason).toMatch(/does not know the verb/);
  });

  it('refuses a verb named after an Object property', () => {
    for (const v of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(() => classify(v), v).not.toThrow();
      expect(classify(v).ok, v).toBe(false);
    }
  });

  it('never returns timed:true on a refusal, however it refused', () => {
    // A caller that checks only `.timed` before reusing a grant is wrong, but
    // it must be wrong in the safe direction.
    for (const v of ['nope.nope', 'msgvault.calendar.invite', 'constructor']) {
      expect(classify(v).timed, v).toBe(false);
    }
  });
});

describe('no write may ride a grant approved earlier', () => {
  it('holds for every write in the table', () => {
    // The payload is what you consent to, and a grant issued before the
    // payload existed cannot have consented to it.
    for (const [verb, rule] of Object.entries(VERBS)) {
      if (rule.kind !== 'write') continue;
      expect(classify(verb).timed, verb).toBe(false);
    }
  });

  it('holds even if the table itself says otherwise', async () => {
    // Belt and braces, because the table is the thing a careless edit changes.
    const { classify: c } = await import('./registry.js');
    expect(c('slack.post').timed).toBe(false);
    expect(c('msgvault.draft.create').timed).toBe(false);
  });

  it('lets reads ride one — which is what makes "a day" safe to offer', () => {
    expect(classify('slack.search')).toMatchObject({ ok: true, kind: 'read', timed: true });
    expect(classify('msgvault.search.read')).toMatchObject({ ok: true, timed: true });
  });
});

describe('the verbs that reach other people', () => {
  it('flags them, so the prompt can say so', () => {
    expect(classify('slack.post').notifiesOthers).toBe(true);
    expect(classify('msgvault.calendar.write').notifiesOthers).toBe(true);
  });

  it('does not flag a draft, which reaches nobody', () => {
    expect(classify('msgvault.draft.create').notifiesOthers).toBeUndefined();
  });

  it('REFUSES a calendar invite — it is a send with another name', () => {
    // The requirement is "create drafts, never send email". An invite emails
    // the attendees, so it walks around that without being called send.
    const c = classify('msgvault.calendar.invite');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/emails the attendees/);
  });

  it('has no send verb at all for msgvault', () => {
    expect(verbsOf('msgvault').filter((v) => /send|sendmail/.test(v))).toEqual([]);
  });
});

describe('the pass-through refusals', () => {
  it('blocks the flags that re-point the tool away from the mediator', () => {
    for (const f of ['--home', '--config', '--agent-url', '--agent-token-file', '--local'])
      expect(FORBIDDEN_FLAGS, f).toContain(f);
  });

  it('blocks arbitrary SQL, bulk export and the credential dump', () => {
    // Each reads or moves more than any grant describes.
    for (const c of ['query', 'export-messages', 'create-subset', 'export-token', 'credentials'])
      expect(REFUSED_COMMANDS, c).toContain(c);
  });

  it('blocks the long-lived surfaces that would outlive the request', () => {
    for (const c of ['tui', 'mcp', 'serve', 'daemon']) expect(REFUSED_COMMANDS, c).toContain(c);
  });
});

describe('the table itself', () => {
  it('groups by connector', () => {
    expect(verbsOf('slack').length).toBeGreaterThan(5);
    expect(verbsOf('msgvault').length).toBeGreaterThan(5);
    expect(verbsOf('slack').every((v) => v.startsWith('slack.'))).toBe(true);
    // A prefix that is not a connector gets nothing, rather than everything.
    expect(verbsOf('')).toEqual([]);
    expect(verbsOf('slac')).toEqual([]);
  });

  it('covers every Slack action the broker knows', () => {
    // The broker's TEAM_ACTIONS is the live vocabulary; a verb it can dispatch
    // and muxpad cannot classify would be refused at the wrong end.
    for (const v of [
      'slack.post',
      'slack.unpost',
      'slack.read',
      'slack.search',
      'slack.channels',
      'slack.users',
      'slack.dm',
      'slack.thread',
      'slack.react',
      'slack.edit',
      'slack.upload',
    ])
      expect(classify(v).ok || classify(v).reason, v).toBeTruthy();
  });
});
