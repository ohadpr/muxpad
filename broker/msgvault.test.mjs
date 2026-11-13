import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES, MSGVAULT, capabilityOf } from './capabilities.mjs';
import {
  OWNER_DRAFT_ACCOUNT,
  describeMsgvault,
  msgvaultArgv,
  validateMsgvault,
} from './msgvault.mjs';

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
      'msgvault.calendar-freebusy',
      'msgvault.calendar-conflicts',
      'msgvault.draft-reply',
      'msgvault.draft-compose',
      'msgvault.calendar-create',
      'msgvault.calendar-update',
      'msgvault.calendar-delete',
      'msgvault.run',
      'msgvault.draft-get',
      'msgvault.draft-edit',
      'msgvault.draft-delete',
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
      // The calendar QUERIES. `calendar.*` is in the agent-token permission
      // list above, and these two only ask questions of it — the tool is
      // passed `--read-only` as well, so it refuses a mutation itself.
      'msgvault.calendar-freebusy',
      'msgvault.calendar-conflicts',
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
  const anything = {
    // msgvault.run's payload IS the argv; the rest of the keys are ignored
    // by it, and it is ignored by the verbs that do not take args.
    // `stats` takes no --json: the review caught that in this very fixture,
    // which is the gate doing its job on the people who wrote it.
    args: ['stats'],
    query: 'q',
    id: 'i',
    body: 'b',
    hash: 'a'.repeat(64),
    to: ['a@b.com'],
    subject: 's',
    account: 'o@e.com',
    summary: 'Party',
    start: '2026-11-29T13:30',
    end: '2026-11-29T15:00',
    tz: 'America/Los_Angeles',
    event: 'evt1',
    revision: 3,
  };
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
test('composing a new email names its recipients, and still cannot send', () => {
  // This test asserted the OPPOSITE — that `draft-compose` appeared in no
  // command line this module could build — and it was right while
  // reply-only was the rule. The owner changed that after a chat could not
  // write to somebody there was no prior thread with, which is the case
  // reply-only cannot serve at all.
  //
  // What must still hold is the premise the whole approval model rests on:
  // a draft is created, never sent.
  const p = validateMsgvault('msgvault.draft-compose', {
    to: ['a@b.com', 'c@d.com'],
    subject: 'Hello',
    body: 'Text',
  });
  const { args } = msgvaultArgv('msgvault.draft-compose', p, INSTALL);
  assert.deepEqual(args.slice(6), [
    'draft-compose',
    '--json',
    '--account',
    'me@ohad.com',
    '--subject',
    'Hello',
    '--body',
    'Text',
    '--to',
    'a@b.com',
    '--to',
    'c@d.com',
  ]);
  // The identity a mail appears to come FROM is the owner's choice, never an
  // agent's: the broker names the mailbox, and only that one flag is set.
  assert.ok(!args.some((x) => ['--from', '--source-id'].includes(x)));
  // `draft` (the bare name) is still not a verb at all.
  assert.throws(() => validateMsgvault('msgvault.draft', { body: 'b' }), /Unsupported action/);
  // And NOTHING this module builds sends anything.
  for (const a of CAPABILITIES.msgvault.actions) {
    const { args: built } = msgvaultArgv(
      a,
      validateMsgvault(a, {
        // `stats` takes no --json: the review caught that in this very fixture,
        // which is the gate doing its job on the people who wrote it.
        args: ['stats'],
        query: 'q',
        id: '1',
        body: 'b',
        hash: 'a'.repeat(64),
        to: ['a@b.com'],
        subject: 's',
        account: 'o@e.com',
        summary: 'Party',
        start: '2026-11-29T13:30',
        end: '2026-11-29T15:00',
        tz: 'America/Los_Angeles',
        event: 'evt1',
        revision: 3,
      }),
      INSTALL,
    );
    assert.ok(!built.some((x) => /^send|^--send/.test(String(x))), `${a} -> ${built.join(' ')}`);
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

/**
 * ── DRAFT CRUD, UNDER ONE APPROVAL ────────────────────────────────────────
 *
 * "drop the requirement to reapprove drafts. CRUD for drafts should fall
 * under the blanket msgvault approval, these are just drafts they are not
 * sent automatically." The premise is checked here: there is still no send.
 */
test('the draft verbs build the argv msgvault documents', () => {
  const decl = { binary: '/bin/true', agentUrl: 'http://127.0.0.1:1', tokenFile: '/t' };
  const argvOf = (action, payload) =>
    msgvaultArgv(action, validateMsgvault(action, payload), decl).args.slice(6);
  assert.deepEqual(argvOf('msgvault.draft-get', { id: 'd1' }), ['draft-get', '--json', '--', 'd1']);
  assert.deepEqual(argvOf('msgvault.draft-delete', { id: 'd1', revision: 2 }), [
    'draft-delete',
    '--json',
    '--revision',
    '2',
    '--',
    'd1',
  ]);
  assert.deepEqual(argvOf('msgvault.draft-edit', { id: 'd1', body: 'new text', revision: 2 }), [
    'draft-edit',
    '--json',
    '--revision',
    '2',
    '--body',
    'new text',
    '--',
    'd1',
  ]);
});

test('a draft verb still refuses a missing id or body', () => {
  assert.throws(() => validateMsgvault('msgvault.draft-get', {}), /draft id/);
  assert.throws(() => validateMsgvault('msgvault.draft-edit', { id: 'd1', revision: 1 }), /body/);
  assert.throws(() => validateMsgvault('msgvault.draft-delete', { id: '--oops' }), /draft id/);
});

test('there is STILL no send verb — the whole premise of the blanket approval', () => {
  for (const name of ['msgvault.send', 'msgvault.draft-send', 'msgvault.draft-forward'])
    assert.throws(() => validateMsgvault(name, {}), /Unsupported action/);
});

test('a duration now covers drafts, and the write set names every write', () => {
  assert.equal(MSGVAULT.timedReadOnly, false);
  assert.deepEqual([...MSGVAULT.writeActions].sort(), [
    'msgvault.calendar-create',
    'msgvault.calendar-delete',
    'msgvault.calendar-update',
    'msgvault.draft-compose',
    'msgvault.draft-delete',
    'msgvault.draft-edit',
    'msgvault.draft-get',
    'msgvault.draft-reply',
    'msgvault.run',
  ]);
  // …and the reads are untouched by any of this.
  assert.ok(MSGVAULT.readActions.includes('msgvault.export-attachment'));
  // The two calendar QUERIES are reads: they answer "when are you busy" and
  // "what overlaps", and the tool is told `--read-only` as well.
  assert.ok(MSGVAULT.readActions.includes('msgvault.calendar-freebusy'));
});

/**
 * ── A CALENDAR EVENT THAT REACHES NOBODY ──────────────────────────────────
 *
 * msgvault can write live Google Calendar events. The flag that changes what
 * KIND of act that is — `--attendees` — is refused here, so an event created
 * through muxpad notifies no one and stays draft-shaped. Inviting people
 * remains something the owner does themselves.
 */
const EVENT = {
  account: 'ohad@example.com',
  summary: "Avery's 9th Birthday Party",
  start: '2026-11-29T13:30',
  end: '2026-11-29T15:00',
  tz: 'America/Los_Angeles',
};

test('a calendar event is created with no guests and no reminders', () => {
  const p = validateMsgvault('msgvault.calendar-create', { ...EVENT, location: 'The park' });
  const { args } = msgvaultArgv('msgvault.calendar-create', p, INSTALL);
  assert.deepEqual(args.slice(6), [
    'calendar',
    'create',
    'primary',
    '--json',
    '--account',
    'ohad@example.com',
    '--summary',
    "Avery's 9th Birthday Party",
    '--from',
    '2026-11-29T13:30',
    '--to',
    '2026-11-29T15:00',
    '--tz',
    'America/Los_Angeles',
    '--location',
    'The park',
  ]);
  assert.ok(!args.some((x) => ['--attendees', '--reminder', '--rrule'].includes(x)));
});

test('asking for guests is REFUSED, not quietly dropped', () => {
  // Dropping them silently would create the event and leave the agent
  // reporting that nine people were invited.
  assert.throws(
    () => validateMsgvault('msgvault.calendar-create', { ...EVENT, attendees: ['a@b.com'] }),
    /invite people yourself/,
  );
  assert.throws(
    () => validateMsgvault('msgvault.calendar-create', { ...EVENT, reminder: ['popup:10'] }),
    /Reminders/,
  );
});

test('a calendar event needs an account, a title, both ends and a zone', () => {
  for (const missing of ['account', 'summary', 'start', 'end', 'tz']) {
    const bad = { ...EVENT };
    delete bad[missing];
    assert.throws(() => validateMsgvault('msgvault.calendar-create', bad), /./, missing);
  }
  // A date that is not a date never reaches the tool.
  assert.throws(
    () => validateMsgvault('msgvault.calendar-create', { ...EVENT, start: 'next tuesday' }),
    /start time/,
  );
});

test('the dialog says what will appear in the calendar, and that nobody is told', () => {
  const d = describeMsgvault(
    'msgvault.calendar-create',
    validateMsgvault('msgvault.calendar-create', EVENT),
  );
  assert.match(d, /Avery/);
  assert.match(d, /no guests, no reminders/);
});

/**
 * WHICH MAILBOX A DRAFT GOES TO.
 *
 * A reply was found in a mailbox the owner had not looked in, and the dialog
 * that approved it had not named one. The owner's rule: "new emails - default
 * to me@ohad.com that's it; replies - obviously go on the thread/account the
 * email we are replying to came in to."
 */
test('a new email is drafted in the owner’s default mailbox, and the dialog names it', () => {
  assert.equal(OWNER_DRAFT_ACCOUNT, 'me@ohad.com');
  const p = validateMsgvault('msgvault.draft-compose', {
    to: ['a@b.com'],
    subject: 'Hi',
    body: 'Text',
  });
  const args = msgvaultArgv('msgvault.draft-compose', p, INSTALL).args;
  assert.equal(args[args.indexOf('--account') + 1], 'me@ohad.com');
  assert.match(describeMsgvault('msgvault.draft-compose', p), /in the me@ohad\.com mailbox/);
});

test('an agent cannot choose the mailbox or identity of a draft', () => {
  const sneaky = {
    to: ['a@b.com'],
    subject: 'Hi',
    body: 'Text',
    id: '150889',
    account: 'someone-else@example.com',
    from: 'ceo@example.com',
    sourceId: 7,
    source_id: 7,
  };
  for (const action of ['msgvault.draft-compose', 'msgvault.draft-reply']) {
    const p = validateMsgvault(action, sneaky);
    const args = msgvaultArgv(action, p, INSTALL).args;
    assert.ok(!args.includes('someone-else@example.com'), action);
    assert.ok(!args.includes('ceo@example.com'), action);
    assert.ok(!args.some((x) => ['--from', '--source-id'].includes(x)), action);
    assert.ok(!JSON.stringify(p).includes('someone-else'), action);
  }
  const c = validateMsgvault('msgvault.draft-compose', sneaky);
  assert.equal(c.account, OWNER_DRAFT_ACCOUNT);
});

test('a reply goes to the mailbox its message came in to — and the dialog says so', () => {
  // msgvault's own rule with no destination flag: the parent's source, and
  // for Gmail nothing else is permitted. So none is passed — a flag here
  // could only ever disagree with that.
  const p = validateMsgvault('msgvault.draft-reply', { id: '150889', body: 'Yes' });
  const args = msgvaultArgv('msgvault.draft-reply', p, INSTALL).args;
  assert.ok(!args.some((x) => ['--account', '--from', '--source-id'].includes(x)));
  assert.match(
    describeMsgvault('msgvault.draft-reply', p),
    /in the mailbox message 150889 came in to/,
  );
});

test('editing or deleting a draft forwards the revision msgvault requires', () => {
  // "draft-edit requires --revision and --body"; "draft-delete requires
  // --revision and no body" — both strings are in the installed binary.
  for (const action of ['msgvault.draft-edit', 'msgvault.draft-delete']) {
    assert.throws(
      () => validateMsgvault(action, { id: 'd1', body: 'b' }),
      /revision/,
      `${action} without a revision`,
    );
    for (const bad of [0, -1, 1.5, 'x', '--local', '1; rm'])
      assert.throws(
        () => validateMsgvault(action, { id: 'd1', body: 'b', revision: bad }),
        /revision/,
      );
    const p = validateMsgvault(action, { id: 'd1', body: 'b', revision: '4' });
    assert.equal(p.revision, 4);
    const args = msgvaultArgv(action, p, INSTALL).args;
    assert.equal(args[args.indexOf('--revision') + 1], '4');
    assert.match(describeMsgvault(action, p), /revision 4/);
  }
});
