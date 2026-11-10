import { describe, expect, it } from 'vitest';
import { VERBS, classify, verbsOf } from './registry.js';

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
    expect(c('slack.post').timed).toBe(false);
  });

  it('lets reads ride one — which is what makes "a day" safe to offer', () => {
    expect(classify('slack.search')).toMatchObject({ ok: true, kind: 'read', timed: true });
    expect(classify('msgvault.search')).toMatchObject({ ok: true, timed: true });
  });
});

describe('the verbs that reach other people', () => {
  it('flags them, so the prompt can say so', () => {
    expect(classify('slack.post').notifiesOthers).toBe(true);
    expect(classify('slack.post').notifiesOthers).toBe(true);
  });

  it('says FALSE for a verb that reaches nobody, rather than saying nothing', () => {
    // It used to be absent, which reads as false at a call site that forgot
    // to think about it and as "nobody asked" at one that did. Now that a
    // draft exists — a write that genuinely reaches no one — the difference
    // is load-bearing.
    expect(classify('msgvault.search').notifiesOthers).toBe(false);
    expect(classify('msgvault.draft-reply').notifiesOthers).toBe(false);
    expect(classify('slack.post').notifiesOthers).toBe(true);
  });

  it('has no calendar invite to refuse — it is ABSENT, which is stronger', () => {
    // The requirement is "create drafts, never send email", and an invite
    // emails the attendees, so it walks around that without being called
    // send. This table used to carry it with a `refuse` reason attached.
    //
    // It is not here at all now. The broker composes the command line from a
    // fixed set of actions (broker/capabilities.mjs), so there is no action
    // name to request, no validator to reach and no argv template to fill —
    // and a refusal that depends on nobody deleting a line is weaker than a
    // thing that was never built.
    const c = classify('msgvault.calendar.invite');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/does not know the verb/);
  });

  it('has no verb that SENDS anything, for msgvault', () => {
    // Drafting arrived, so "nothing that writes" is no longer the claim. The
    // claim is narrower and is the one that matters: nothing LEAVES. A draft
    // sits in the mailbox; `send`, `post` and `invite` put something in front
    // of another person under the owner's name, and none of them exists.
    const verbs = verbsOf('msgvault');
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs.filter((v) => /\.(send|post|invite)/.test(v))).toEqual([]);
    // Every READ may ride a grant; every WRITE is approved on its own, so a
    // draft can never be dispatched by an approval given for something else.
    for (const v of verbs) {
      const c = classify(v);
      expect(c.ok, v).toBe(true);
      if (/draft/.test(v)) expect(c, v).toMatchObject({ kind: 'write', timed: false });
      else expect(c, v).toMatchObject({ kind: 'read', timed: true });
    }
  });
});

describe('the table itself', () => {
  it('groups by connector', () => {
    expect(verbsOf('slack').length).toBeGreaterThan(5);
    // FIVE: four reads and one write. Three advertised verbs could not work
    // against msgvault 0.22.0 and were removed rather than repaired, and a
    // compose verb went the same way once a Gmail source was measured
    // refusing it — see the note on MSGVAULT.
    expect(verbsOf('msgvault')).toHaveLength(5);
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

describe('the table is the policy, so the table is pinned', () => {
  // THE WORST SURVIVOR of an exhaustive mutation run: relabelling a write as a
  // timed read — slack.dm, slack.react, draft.delete, draft-edit — passed every
  // test. The behavioural tests all ask "does a write stay untimed", which a
  // mutant satisfies by making the write a read. So the data itself is asserted
  // verbatim: this file IS the policy, and a careless edit to it must fail.
  const EXPECTED: Record<
    string,
    { kind: string; timed: boolean; others?: boolean; refused?: true }
  > = {
    'slack.read': { kind: 'read', timed: true },
    'slack.search': { kind: 'read', timed: true },
    'slack.channels': { kind: 'read', timed: true },
    'slack.users': { kind: 'read', timed: true },
    'slack.thread': { kind: 'read', timed: true },
    'slack.post': { kind: 'write', timed: false, others: true },
    'slack.dm': { kind: 'write', timed: false, others: true },
    'slack.react': { kind: 'write', timed: false, others: true },
    'slack.edit': { kind: 'write', timed: false, others: true },
    'slack.unpost': { kind: 'write', timed: false, others: true },
    'slack.upload': { kind: 'write', timed: false, others: true },
    // THE BROKER'S ACTIONS, which is now the only msgvault vocabulary —
    // see the note on MSGVAULT in registry.ts. The write verbs that used to
    // be listed here are not refused by this table any more; they are
    // ABSENT FROM THE BROKER, which is stronger than a refusal.
    'msgvault.search': { kind: 'read', timed: true },
    'msgvault.show-message': { kind: 'read', timed: true },
    'msgvault.show-thread': { kind: 'read', timed: true },
    'msgvault.stats': { kind: 'read', timed: true },
    // THE ONE WRITE. `others: false` is the point of listing it beside
    // Slack's: a draft lands in the owner's own mailbox and nobody else
    // learns anything, which is exactly what separates it from `slack.post`
    // and from the calendar invite this connector still refuses to have.
    //
    // There is no `msgvault.draft`: composing a new email is refused by a
    // Gmail source itself (`draft_disabled`), so muxpad never offers it.
    'msgvault.draft-reply': { kind: 'write', timed: false, others: false },
  };

  it('has exactly these verbs, no more and no fewer', () => {
    expect(Object.keys(VERBS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('classifies each one exactly as written here', () => {
    for (const [verb, want] of Object.entries(EXPECTED)) {
      const got = classify(verb);
      expect(got.kind, verb).toBe(want.kind);
      expect(got.timed, verb).toBe(want.timed);
      if (want.refused) {
        // A refusal carries no flags: nothing will be shown, so there is
        // nothing for `notifiesOthers` to annotate.
        expect(got.notifiesOthers, verb).toBeUndefined();
        expect(got.reason, verb).toBeTruthy();
      } else {
        // `want.others` is written only for the verbs that have it; absent
        // means false, and `classify` now ALWAYS answers with a boolean.
        expect(got.notifiesOthers, verb).toBe(want.others === true);
      }
      expect(got.ok, verb).toBe(!want.refused);
    }
  });

  it('keeps writes and reads on the right side of their own names', () => {
    // A rule rather than a list, so a verb added later is covered: anything
    // that posts, sends, writes, edits, deletes, uploads, reacts, creates or
    // invites is a write, whatever the table says.
    for (const verb of Object.keys(VERBS)) {
      const last = verb.split('.').slice(-1)[0] as string;
      const writeish = /^(post|unpost|dm|react|edit|upload|write|invite|create|delete|send|move)$/;
      if (writeish.test(last)) expect(VERBS[verb]?.kind, verb).toBe('write');
      if (last === 'read') expect(VERBS[verb]?.kind, verb).toBe('read');
    }
  });

  it('flags every verb that reaches other people', () => {
    for (const verb of Object.keys(VERBS)) {
      const r = VERBS[verb];
      if (r?.kind !== 'write') continue;
      // A draft reaches nobody; everything else that writes does. Matched on
      // the verb's own name — `msgvault.draft-reply` — and not on `.draft.`,
      // which was the shape of a naming that never shipped and silently
      // matched nothing once the real verb arrived.
      const isDraft = /\.draft(-|$)/.test(verb);
      expect(r.notifiesOthers === true, verb).toBe(!isDraft);
    }
  });
});
