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
  for (const dead of [
    'msgvault.list-senders',
    'msgvault.meetings',
    'msgvault.person',
    // Composing a new email. Measured 2026-11-10 against msgvault 0.22.0,
    // locally as `_msgvault` so the agent layer was not in the way: a Gmail
    // source answers `draft-compose` with `draft_disabled`, while
    // `draft-reply` created a real Gmail draft in the thread. A verb that
    // raises a dialog and then fails is worse than no verb.
    'msgvault.draft',
  ]) {
    assert.ok(!CAPABILITIES.msgvault.actions.includes(dead), dead);
    assert.throws(() => validateMsgvault(dead, {}), /Unsupported action/, dead);
  }
  assert.deepEqual(
    [...CAPABILITIES.msgvault.actions],
    [
      'msgvault.search',
      'msgvault.show-message',
      'msgvault.show-thread',
      'msgvault.export-attachment',
      'msgvault.stats',
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
    [
      'msgvault.search',
      'msgvault.show-message',
      'msgvault.show-thread',
      'msgvault.export-attachment',
      'msgvault.stats',
    ],
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
  const anything = { query: 'q', id: 'i', body: 'b', hash: 'a'.repeat(64) };
  for (const a of CAPABILITIES.msgvault.actions) {
    const d = describeMsgvault(a, validateMsgvault(a, anything));
    assert.ok(d.length > 10 && !d.startsWith('msgvault.'), `${a} -> ${d}`);
  }
  // A draft's description carries what you are agreeing to: which message it
  // answers, and whether it answers one person or all of them.
  const draft = describeMsgvault(
    'msgvault.draft-reply',
    validateMsgvault('msgvault.draft-reply', anything),
  );
  assert.match(draft, /message i/);
});

/**
 * THE ONE WRITE.
 *
 * A draft puts text an agent wrote into the owner's mailbox under their name.
 * These assertions are about the two things that keeps honest: every argument
 * is composed rather than forwarded, and the verb cannot become a send.
 */
test('there is no verb for composing a new email', () => {
  // Not "refused" — ABSENT. `draft-compose` must not appear in any command
  // line this module can build, for any action it accepts.
  assert.throws(
    () => validateMsgvault('msgvault.draft', { to: ['a@b.com'], subject: 's', body: 'b' }),
    /Unsupported action/,
  );
  for (const a of CAPABILITIES.msgvault.actions) {
    const p = validateMsgvault(a, { query: 'q', id: '1', body: 'b', hash: 'a'.repeat(64) });
    const { args } = msgvaultArgv(a, p, INSTALL);
    assert.ok(!args.includes('draft-compose'), `${a} -> ${args.join(' ')}`);
    // …and no recipient flags anywhere: with compose gone, nothing this
    // module builds addresses a new message to anybody.
    assert.ok(!args.some((x) => ['--to', '--cc', '--bcc', '--subject'].includes(x)), a);
  }
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

test('the write cannot be turned into a send, or into another flag', () => {
  for (const action of ['msgvault.draft-reply']) {
    const { args } = msgvaultArgv(
      action,
      validateMsgvault(action, { id: '1', body: 'b' }),
      INSTALL,
    );
    assert.ok(!args.some((a) => /send/i.test(a)), args.join(' '));
    // The verb is a constant and the only flags present are the ones this
    // module wrote — there is no slot for a caller's.
    assert.equal(args.filter((a) => a.startsWith('--account') || a.startsWith('--from')).length, 0);
  }
});

test('a reply refuses a flag-shaped or oversized body', () => {
  // The reason the whole file exists: msgvault is cobra/pflag, so free text
  // that begins with `-` is parsed as a flag at the binary however tidy the
  // argv array looks from here.
  assert.throws(
    () => validateMsgvault('msgvault.draft-reply', { id: '1', body: '--local' }),
    /body/i,
  );
  assert.throws(() => validateMsgvault('msgvault.draft-reply', { id: '1', body: '' }), /body/i);
  assert.throws(
    () => validateMsgvault('msgvault.draft-reply', { id: '1', body: 'x'.repeat(20001) }),
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

test('an attachment is fetched by content hash, to stdout, and never written by the broker', () => {
  const hash = '1a059e3ac41eb3743928854fc0ba8d0f9131a30903e548e46c46325caef749df';
  const { args } = msgvaultArgv(
    'msgvault.export-attachment',
    validateMsgvault('msgvault.export-attachment', { hash }),
    { binary: '/bin/msgvault', agentUrl: 'http://127.0.0.1:1', tokenFile: '/t' },
  );
  assert.deepEqual(args.slice(-4), ['export-attachment', '--json', '--', hash]);
  // `-o` would be a file written as the broker's account, at a path the agent chose.
  assert.ok(!args.includes('-o') && !args.includes('--output'));
  for (const bad of ['', 'ABC', '-'.repeat(64), `${hash}x`, hash.slice(1), '../../etc/passwd', 7])
    assert.throws(
      () => validateMsgvault('msgvault.export-attachment', { hash: bad }),
      /content_hash/,
    );
  // Only the checked field survives into the payload.
  assert.deepEqual(validateMsgvault('msgvault.export-attachment', { hash, out: '/tmp/x' }), {
    hash,
  });
  assert.match(
    describeMsgvault('msgvault.export-attachment', { hash }),
    /attachment \(1a059e3ac41e/,
  );
});
