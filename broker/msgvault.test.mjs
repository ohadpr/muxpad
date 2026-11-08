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

test('msgvault has no write set to hold back, so its two scopes are one list', () => {
  const c = CAPABILITIES.msgvault;
  assert.deepEqual([...c.actions], [...c.readActions]);
  assert.equal(c.readScope, c.fullScope);
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
  assert.deepEqual(a.slice(6), ['search', 'from:x@y.com newer_than:30d', '--limit', '50', '--json']);
});

test('a query that LOOKS like flags is still one argument', () => {
  // The whole reason for composing rather than filtering. As a string in an
  // argv array this can never become a flag — there is no shell and no
  // re-split. The filter this replaced was broken by exactly this shape:
  // `--log-file search query 'SELECT …'` ran SQL approved as a search.
  const a = argv('msgvault.search', { query: '--log-file x query SELECT * FROM messages' });
  assert.equal(a[7], '--log-file x query SELECT * FROM messages');
  assert.equal(a[6], 'search');
  // and the verb is a constant, so no payload can move it
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
    ['msgvault.person', { query: '' }, /name or address/],
    ['msgvault.nope', {}, /Unsupported/],
    ['slack.post', {}, /Unsupported/],
  ];
  for (const [action, payload, re] of refused)
    assert.throws(() => validateMsgvault(action, payload), re, `${action} ${JSON.stringify(payload)}`);
});

test('a missing declaration refuses rather than guessing a path', () => {
  const p = validateMsgvault('msgvault.stats', {});
  for (const bad of [undefined, {}, { binary: '/b' }, { binary: '/b', agentUrl: 'u' }])
    assert.throws(() => msgvaultArgv('msgvault.stats', p, bad), /not declared/);
});

test('the dialog names the thing being asked for, not just the verb', () => {
  // Approving "search" without its query is approving nothing.
  assert.match(describeMsgvault('msgvault.search', { query: 'tax 2025' }), /"tax 2025"/);
  assert.match(describeMsgvault('msgvault.show-message', { id: 'abc' }), /abc/);
  assert.match(describeMsgvault('msgvault.stats', {}), /no message content/);
  for (const a of CAPABILITIES.msgvault.actions) {
    const d = describeMsgvault(a, validateMsgvault(a, { query: 'q', id: 'i' }));
    assert.ok(d.length > 10 && !d.startsWith('msgvault.'), `${a} -> ${d}`);
  }
});
