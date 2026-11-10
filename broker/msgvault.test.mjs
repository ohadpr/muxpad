import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES, capabilityOf } from './capabilities.mjs';
import { describeMsgvault, msgvaultArgv, validateMsgvault } from './msgvault.mjs';

const INSTALL = {
  binary: '/usr/local/libexec/msgvault/msgvault',
  agentUrl: 'http://127.0.0.1:8787',
  tokenFile: '/Library/muxpad-broker/msgvault-agent-token',
};
const argv = (a, p) => msgvaultArgv(a, validateMsgvault(a, p), INSTALL).args;

test('an action belongs to exactly one capability, by its prefix', () => {
  assert.equal(capabilityOf('msgvault.search').id, 'msgvault');
  assert.equal(capabilityOf('slack.post').id, 'slack');
  // Not a capability, not an object key games can reach.
  for (const a of ['nope.x', '__proto__.x', 'constructor.x', 'msgvault', '.search', 42, null])
    assert.equal(capabilityOf(a), undefined, String(a));
});

test('msgvault holds its writes back from the read scope', () => {
  // It used to have no writes, so the two scopes were one list and a timed
  // grant covered exactly what one approval would have. Drafting breaks that
  // on purpose: a duration is offered only for the READ scope (core.mjs), so
  // putting text in the owner's mailbox is always approve-once.
  const c = CAPABILITIES.msgvault;
  assert.deepEqual([...c.actions], [...c.readActions, ...c.writeActions]);
  assert.notEqual(c.readScope, c.fullScope);
  for (const w of c.writeActions) assert.ok(!c.readActions.includes(w), w);
  // …and its scope can never be mistaken for Slack's, which is what keeps a
  // grant for one from being spent on the other.
  assert.notEqual(c.readScope, CAPABILITIES.slack.readScope);
  assert.notEqual(c.readScope, CAPABILITIES.slack.fullScope);
});

test('the broker composes the command line; nothing is forwarded', () => {
  const a = argv('msgvault.search', { query: 'from:x@y.com newer_than:30d' });
  // The three flags that say who is asking come FIRST and are not the
  // caller's to set.
  assert.deepEqual(a.slice(0, 6), [
    '--agent-url',
    INSTALL.agentUrl,
    '--agent-token-file',
    INSTALL.tokenFile,
    '--agent-allow-insecure',
    '--no-log-file',
  ]);
  // Flags first, then `--`, then the positional. The order is load-bearing:
  // `--` before the flags makes THEM positionals too (verified: `show-message
  // -- --local --json` is "accepts 1 arg(s), received 2").
  assert.deepEqual(a.slice(6), [
    'search',
    '--limit',
    '50',
    '--json',
    '--',
    'from:x@y.com newer_than:30d',
  ]);
});

test('a value that looks like a flag is refused, and `--` guards the rest', () => {
  // THE EARLIER CLAIM HERE WAS FALSE, and a review disproved it at the
  // binary: msgvault is cobra/pflag, so a positional beginning with `-` is
  // parsed as a flag however tidy the argv array is. `search '--local'` came
  // back "provide a search query" — the query had been eaten. Asserting on
  // the array proved nothing about the program.
  //
  // Two defences now, and this checks both.
  assert.throws(() => validateMsgvault('msgvault.search', { query: '--account=x' }), /query/);
  assert.throws(() => validateMsgvault('msgvault.show-message', { id: '--local' }), /id/);

  // …and a query that is merely ALARMING, not flag-shaped, rides after `--`
  // as one argument. Verified against 0.22.0: this reaches the daemon with
  // the string intact.
  const a = argv('msgvault.search', { query: 'query SELECT * FROM messages' });
  assert.equal(a[a.length - 1], 'query SELECT * FROM messages');
  assert.equal(a[a.length - 2], '--');
  assert.equal(a[6], 'search');
  assert.equal(a.filter((x) => x === 'search').length, 1);
});

test('every payload is checked before it is placed', () => {
  const refused = [
    ['msgvault.search', {}, /search query/],
    ['msgvault.search', { query: 'x', limit: 0 }, /1\.\.200/],
    ['msgvault.search', { query: 'x', limit: 201 }, /1\.\.200/],
    ['msgvault.search', { query: 'x', limit: 1.5 }, /1\.\.200/],
    ['msgvault.search', { query: 'x'.repeat(513) }, /search query/],
    ['msgvault.show-message', { id: 'a b' }, /message id/],
    ['msgvault.show-message', { id: '../../etc/passwd' }, /message id/],
    ['msgvault.show-message', {}, /message id/],
    ['msgvault.search', { query: '-x' }, /query/],
    ['msgvault.person', {}, /Unsupported/],
    ['msgvault.meetings', {}, /Unsupported/],
    ['msgvault.list-senders', {}, /Unsupported/],
    ['msgvault.nope', {}, /Unsupported/],
    ['slack.post', {}, /Unsupported/],
  ];
  for (const [action, payload, re] of refused)
    assert.throws(
      () => validateMsgvault(action, payload),
      re,
      `${action} ${JSON.stringify(payload)}`,
    );
});

test('a missing declaration refuses rather than guessing a path', () => {
  const p = validateMsgvault('msgvault.stats', {});
  for (const bad of [undefined, {}, { binary: '/b' }, { binary: '/b', agentUrl: 'u' }])
    assert.throws(() => msgvaultArgv('msgvault.stats', p, bad), /not declared/);
});

test('only verbs that work against 0.22.0 are offered', () => {
  // Verified offline against the real binary, dummy token, dead agent-url —
  // so each refusal is msgvault's own argument handling, not a daemon.
  // `list-senders` is refused by delegated mode; `meetings` and `person` are
  // parent commands with no positional and no --json. An action the broker
  // accepts and the tool refuses is a dialog asking for something that cannot
  // happen.
  for (const dead of ['msgvault.list-senders', 'msgvault.meetings', 'msgvault.person']) {
    assert.ok(!CAPABILITIES.msgvault.actions.includes(dead), dead);
    assert.throws(() => validateMsgvault(dead, {}), /Unsupported action/, dead);
  }
  assert.deepEqual(
    [...CAPABILITIES.msgvault.actions],
    [
      'msgvault.search',
      'msgvault.show-message',
      'msgvault.show-thread',
      'msgvault.stats',
      'msgvault.draft',
      'msgvault.draft-reply',
    ],
  );
  // The dead list again, this time as the SHAPE of the fix: `person` is
  // refused by delegated mode itself ("get is not available in
  // agent-delegated mode") and the agent-token permission set has no
  // contacts scope at all — search.read, message.read, attachment.read,
  // stats.read, draft.create/edit/delete, calendar.*. Contacts cannot be
  // delegated at this version, so muxpad does not pretend otherwise.
  assert.deepEqual(
    [...CAPABILITIES.msgvault.readActions],
    ['msgvault.search', 'msgvault.show-message', 'msgvault.show-thread', 'msgvault.stats'],
  );
});

test('the dialog names the thing being asked for, not just the verb', () => {
  // Approving "search" without its query is approving nothing.
  assert.match(describeMsgvault('msgvault.search', { query: 'tax 2025' }), /"tax 2025"/);
  assert.match(describeMsgvault('msgvault.show-message', { id: 'abc' }), /abc/);
  assert.match(describeMsgvault('msgvault.stats', {}), /no message content/);
  // EVERY action, including the writes — one payload that satisfies all of
  // them, so adding a verb without a description fails here rather than
  // showing a human the raw action name in a dialog.
  const anything = { query: 'q', id: 'i', to: ['a@b.com'], subject: 's', body: 'b' };
  for (const a of CAPABILITIES.msgvault.actions) {
    const d = describeMsgvault(a, validateMsgvault(a, anything));
    assert.ok(d.length > 10 && !d.startsWith('msgvault.'), `${a} -> ${d}`);
  }
  // A draft's description carries the two things you are agreeing to: who it
  // is addressed to, and what it is about.
  const draft = describeMsgvault('msgvault.draft', validateMsgvault('msgvault.draft', anything));
  assert.match(draft, /a@b\.com/);
  assert.match(draft, /"s"/);
});

/**
 * THE TWO WRITES.
 *
 * A draft puts text an agent wrote into the owner's mailbox under their name.
 * These assertions are about the two things that keeps honest: every argument
 * is composed rather than forwarded, and neither verb can become a send.
 */
test('a draft is composed from checked fields, never from the caller’s flags', () => {
  const p = validateMsgvault('msgvault.draft', {
    to: ['a@b.com', 'c@d.com'],
    cc: ['e@f.com'],
    subject: 'Dinner',
    body: 'Are you free Thursday?',
  });
  const { args } = msgvaultArgv('msgvault.draft', p, INSTALL);
  assert.deepEqual(args.slice(6), [
    'draft-compose',
    '--json',
    '--to',
    'a@b.com',
    '--to',
    'c@d.com',
    '--cc',
    'e@f.com',
    '--subject',
    'Dinner',
    '--body',
    'Are you free Thursday?',
  ]);
});

test('a reply names the message it answers, and says who it goes to', () => {
  const one = validateMsgvault('msgvault.draft-reply', { id: '150889', body: 'Yes' });
  assert.deepEqual(msgvaultArgv('msgvault.draft-reply', one, INSTALL).args.slice(6), [
    'draft-reply',
    '--json',
    '--body',
    'Yes',
    '--',
    '150889',
  ]);
  assert.match(describeMsgvault('msgvault.draft-reply', one), /to the sender of message 150889/);
  // Reply-all is OPT IN: answering nine people instead of one is exactly the
  // difference a person must approve knowingly.
  const all = validateMsgvault('msgvault.draft-reply', { id: '150889', body: 'Yes', all: true });
  assert.ok(msgvaultArgv('msgvault.draft-reply', all, INSTALL).args.includes('--all'));
  assert.match(describeMsgvault('msgvault.draft-reply', all), /to everyone on/);
  // …and anything other than `true` is not reply-all.
  for (const v of ['true', 1, {}, []])
    assert.equal(
      validateMsgvault('msgvault.draft-reply', { id: '1', body: 'x', all: v }).all,
      false,
      JSON.stringify(v),
    );
});

test('neither verb can be turned into a send, or into another flag', () => {
  for (const action of ['msgvault.draft', 'msgvault.draft-reply']) {
    const p =
      action === 'msgvault.draft'
        ? { to: ['a@b.com'], subject: 's', body: 'b' }
        : { id: '1', body: 'b' };
    const { args } = msgvaultArgv(action, validateMsgvault(action, p), INSTALL);
    assert.ok(!args.some((a) => /send/i.test(a)), args.join(' '));
    // The verb is a constant and the only flags present are the ones this
    // module wrote — there is no slot for a caller's.
    assert.equal(args.filter((a) => a.startsWith('--account') || a.startsWith('--from')).length, 0);
  }
});

test('a draft refuses a recipient that is not an address', () => {
  for (const to of [[], ['nope'], ['a@b'], ['-x@b.com'], 'a@b.com '.repeat(1), [1]])
    assert.throws(
      () => validateMsgvault('msgvault.draft', { to, subject: 's', body: 'b' }),
      /recipient|address/i,
      JSON.stringify(to),
    );
  // …and a flag-shaped subject or body, for the reason the whole file exists.
  assert.throws(
    () => validateMsgvault('msgvault.draft', { to: ['a@b.com'], subject: '--local', body: 'b' }),
    /subject/i,
  );
  assert.throws(
    () => validateMsgvault('msgvault.draft', { to: ['a@b.com'], subject: 's', body: '--local' }),
    /body/i,
  );
});

test('a draft is bounded — a caller cannot mail a hundred people a novel', () => {
  const many = Array.from({ length: 21 }, (_, i) => `a${i}@b.com`);
  assert.throws(
    () => validateMsgvault('msgvault.draft', { to: many, subject: 's', body: 'b' }),
    /Too many/,
  );
  assert.throws(
    () =>
      validateMsgvault('msgvault.draft', {
        to: ['a@b.com'],
        subject: 's',
        body: 'x'.repeat(20001),
      }),
    /body/i,
  );
});

test('a reply refuses a message id it could not have learned', () => {
  for (const id of ['', '../etc/passwd', '-x', 'a b', 'x'.repeat(129)])
    assert.throws(
      () => validateMsgvault('msgvault.draft-reply', { id, body: 'b' }),
      /message id/i,
      JSON.stringify(id),
    );
});
