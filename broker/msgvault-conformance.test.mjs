import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { CAPABILITIES } from './capabilities.mjs';
import { msgvaultArgv, validateMsgvault } from './msgvault.mjs';

/**
 * ── DOES THE TOOL ACTUALLY ACCEPT WHAT WE BUILD FOR IT? ───────────────────
 *
 * Every brokered verb is argv this repo writes by hand for a binary it
 * cannot run: the archive belongs to a service account, so nothing here can
 * execute a real call. The consequence was three shipped bugs in one day —
 * a verb msgvault refuses outright in delegated mode, flags it does not
 * have, a payload shape it rejects — each discovered only after an admin
 * install and a chat failing in front of the owner.
 *
 * None of that needed privileges to find. The CLI's own refusals are
 * CLIENT-SIDE: point it at a dead loopback port with an empty token and it
 * still parses argv, still checks what delegated mode allows, and says so —
 * without a daemon, without the archive, without touching one byte of mail.
 *
 * So this runs every verb the broker offers, exactly as the broker would
 * build it, and fails on the answers that mean "this can never work":
 *
 *   · `not available in agent-delegated mode` — the verb is refused for an
 *     agent however the broker is installed. (This is `export-attachment`'s
 *     story: shipped, installed by hand, dead on arrival.)
 *   · `unknown flag` / `unknown command` / `unknown shorthand` — the argv
 *     names something this version does not have.
 *
 * Anything that reaches the network and fails there is a PASS: argv was
 * accepted and the only thing missing is the daemon we deliberately did not
 * give it.
 */
const BINARY = '/usr/local/libexec/msgvault/msgvault';
/** Actions the runner performs over HTTP instead of argv — see
 *  msgvault-runner.mjs. They have a spec for validation only. */
const NOT_ARGV = new Set([
  'msgvault.export-attachment',
  // Its payload IS the argv, reviewed against msgvault's own help — see
  // msgvault-argv.test.mjs, which checks that gate against the real binary.
  'msgvault.run',
]);
/** One payload that satisfies every validator; each verb takes what it needs. */
const ANY = {
  query: 'dinner',
  id: '150889',
  limit: 5,
  hash: 'a'.repeat(64),
  body: 'text',
  to: ['someone@example.com'],
  subject: 'Subject',
  account: 'owner@example.com',
  event: 'abc123event',
  summary: 'An event',
  start: '2026-11-29T13:30',
  end: '2026-11-29T15:00',
  tz: 'America/Los_Angeles',
  revision: 1,
};
const DEAD = {
  binary: BINARY,
  // Port 1: nothing listens, and the refusal is instant.
  agentUrl: 'http://127.0.0.1:1',
  tokenFile: '/dev/null',
};
const FATAL = [
  /not available in agent-delegated mode/i,
  /unknown flag/i,
  /unknown command/i,
  /unknown shorthand/i,
  /accepts \d+ arg/i,
  // A flag msgvault REQUIRES that the typed argv never sends. cobra checks
  // it client-side, before the network — this is the answer
  // `draft-delete`/`draft-edit` gave for `--revision`, live, after shipping.
  /required flag\(s\)/i,
];

/**
 * ── OPT-IN, AND IT SAYS SO WHEN IT DOES NOT RUN ──────────────────────────
 *
 * This test EXECUTES the msgvault binary (against a dead daemon, but beyond
 * `--help`). Agent sessions on this machine are blocked from doing that by a
 * hook, so an agent running the broker suite either goes around the hook by
 * proxy or never runs this — and a green suite that never ran it read as
 * proof. So it runs only when a person asks for it, in their own terminal:
 *
 *   MSGVAULT_CONFORMANCE=1 node --test broker/msgvault-conformance.test.mjs
 *
 * and every other run reports SKIPPED with this reason, not a pass.
 */
function skipWhy() {
  if (process.env.MSGVAULT_CONFORMANCE !== '1')
    return 'NOT RUN: executes the msgvault binary, which agent sessions may not — run it yourself with MSGVAULT_CONFORMANCE=1';
  if (!existsSync(BINARY)) return 'NOT RUN: msgvault is not installed on this machine';
  return null;
}

function run(args) {
  try {
    execFileSync(BINARY, args, { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
    return '';
  } catch (e) {
    return String(e.stderr || e.stdout || e.message);
  }
}

test('every brokered verb is one this msgvault accepts from an agent', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const broken = [];
  for (const action of CAPABILITIES.msgvault.actions) {
    if (NOT_ARGV.has(action)) continue;
    const { args } = msgvaultArgv(action, validateMsgvault(action, ANY), DEAD);
    const out = run(args);
    const fatal = FATAL.find((re) => re.test(out));
    if (fatal) broken.push(`${action}: ${out.trim().split('\n')[0]}`);
  }
  assert.deepEqual(broken, [], `verbs this msgvault will never run:\n${broken.join('\n')}`);
});

test('the verbs we do NOT offer are the ones that are actually refused', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  // The mirror of the test above, so a capability that BECOMES available is
  // noticed rather than staying excluded out of habit. `export-attachment`
  // is here because the CLI refuses it — which is why the broker fetches
  // attachments over HTTP instead.
  const out = run([
    'export-attachment',
    '--agent-url',
    DEAD.agentUrl,
    '--agent-token-file',
    DEAD.tokenFile,
    '--agent-allow-insecure',
    '--no-log-file',
    '--json',
    '--',
    'a'.repeat(64),
  ]);
  assert.match(
    out,
    /not available in agent-delegated mode/i,
    'export-attachment is no longer refused — the HTTP path in msgvault-runner may be unnecessary',
  );
});
