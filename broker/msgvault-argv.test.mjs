import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { argvIsRead, parseHelpFlags, reviewArgv } from './msgvault-argv.mjs';

/**
 * THE REVIEW IS THE WHOLE SECURITY SURFACE of the argv path, so it is tested
 * against msgvault's REAL help where that is available, and against fixtures
 * everywhere else so the rules hold on a machine with no msgvault at all.
 */
const HELP = {
  search: '--limit int\n--json\n--since string',
  'draft-reply': '--body string\n--all\n--json',
  'calendar create': '--summary string\n--from string\n--to string\n--tz string\n--attendees strings\n--account string\n--json',
  'calendar freebusy': '--from string\n--to string\n--tz string\n--account string\n--json',
  'calendar delete': '--scope string\n--account string\n--json',
  'add-account': '--json',
  stats: '--json',
};
const helpFor = (c) => HELP[c] ?? null;

test('a flag the subcommand does not have is refused', () => {
  // The gate that needs no maintenance, and the one the old verb table never
  // had: nothing checked that muxpad's hand-written flags existed.
  assert.deepEqual(reviewArgv(['search', '--limit', '5'], helpFor), { ok: true, command: 'search' });
  assert.match(reviewArgv(['search', '--deep'], helpFor).why, /search has no --deep/);
});

test('administering the archive is refused, however valid the flags are', () => {
  assert.match(reviewArgv(['add-account', '--json'], helpFor).why, /owner's own work/);
  for (const c of ['agent-token', 'credentials', 'export-token', 'serve', 'tui', 'import-mbox'])
    assert.equal(reviewArgv([c], helpFor).ok, false, c);
});

test('flags that change WHO THIS IS are refused even when help lists them', () => {
  // `--home` and `--config` re-point the whole archive; `--agent-*` overrides
  // the grant itself. A help text that lists them is not permission.
  for (const flag of ['--home', '--config', '--agent-url', '--local'])
    assert.match(reviewArgv(['search', flag, 'x'], helpFor).why, /not something an agent sets/, flag);
});

test('flags that reach another person are refused', () => {
  assert.match(
    reviewArgv(['calendar', 'create', 'primary', '--attendees', 'a@b.com'], helpFor).why,
    /not something an agent sets/,
  );
});

test('…but a calendar still gets its --account and its --from TIME', () => {
  // The same flag name means identity on a draft and a time on a calendar.
  // Refusing it everywhere would have made the calendar unusable.
  assert.equal(
    reviewArgv(
      ['calendar', 'freebusy', 'primary', '--account', 'o@e.com', '--from', '2026-11-29T13:00'],
      helpFor,
    ).ok,
    true,
  );
});

test('a recurring series is never deleted wholesale', () => {
  assert.equal(reviewArgv(['calendar', 'delete', 'primary', '--scope', 'single'], helpFor).ok, true);
  assert.match(
    reviewArgv(['calendar', 'delete', 'primary', '--scope', 'all'], helpFor).why,
    /too broad/,
  );
  assert.match(
    reviewArgv(['calendar', 'delete', 'primary', '--scope=future'], helpFor).why,
    /too broad/,
  );
});

test('only a read may ride a duration; anything unrecognised counts as a write', () => {
  assert.equal(argvIsRead(['search', '--limit', '5']), true);
  assert.equal(argvIsRead(['calendar', 'freebusy', 'primary']), true);
  assert.equal(argvIsRead(['draft-reply', '--body', 'hi']), false);
  assert.equal(argvIsRead(['calendar', 'create', 'primary']), false);
  // A verb nobody has heard of is a write, which is the direction a mistake
  // should fall.
  assert.equal(argvIsRead(['frobnicate']), false);
});

test('the shape of the input is checked before anything else', () => {
  assert.match(reviewArgv([], helpFor).why, /Give the msgvault arguments/);
  assert.match(reviewArgv(['--json'], helpFor).why, /must be a command/);
  assert.match(reviewArgv(['search', 5], helpFor).why, /must be strings/);
  assert.match(reviewArgv(['nosuchcommand'], helpFor).why, /no command nosuchcommand/);
});

test('parseHelpFlags reads the real binary’s help, not a shape we imagined', (t) => {
  const bin = '/usr/local/libexec/msgvault/msgvault';
  if (!existsSync(bin)) return t.skip('msgvault is not installed on this machine');
  const help = execFileSync(bin, ['search', '--help'], { encoding: 'utf8' });
  const flags = parseHelpFlags(help);
  assert.ok(flags.has('--json'), [...flags].join(' '));
  assert.ok(flags.has('--limit'), [...flags].join(' '));
  assert.ok(!flags.has('--deep'));
});

/**
 * ── A REFUSAL IS ONLY USEFUL IF IT SURVIVES THE WALL ─────────────────────
 *
 * The broker answers every exception with a fixed `Request refused or
 * invalid`, and that is right for a fault: a stack or a path must not cross
 * it. But the review's own sentences — "search has no --deep" — are the
 * whole value of the review, and without them every refusal reads as
 * "msgvault is broken". So they are TAGGED, and only tagged errors repeat.
 */
test('the review refuses through fail(), which marks the error safe to repeat', async () => {
  const { validateMsgvault } = await import('./msgvault.mjs');
  for (const [args, expected] of [
    [['search', '--deep'], /search has no --deep/],
    [['add-account'], /administers the archive/],
    [['search', '--home', '/tmp'], /not something an agent sets/],
  ]) {
    try {
      validateMsgvault('msgvault.run', { args });
      assert.fail(`expected a refusal for ${args.join(' ')}`);
    } catch (e) {
      assert.match(e.message, expected);
      assert.equal(e.refusal, true, `${args.join(' ')} must be repeatable`);
    }
  }
});

test('a positional is not mistaken for a subcommand in the refusal', () => {
  // `search x --deep` refused with "search x has no --deep", naming the
  // user's own search term as if it were a verb. A subcommand is told apart
  // from a positional by ASKING: only a subcommand has its own help.
  assert.equal(reviewArgv(['search', 'dinner', '--deep'], helpFor).why, 'search has no --deep');
  // …and a real subcommand is still named in full.
  assert.equal(
    reviewArgv(['calendar', 'create', 'primary', '--nope'], helpFor).why,
    'calendar create has no --nope',
  );
});

/**
 * THE SHAPE A FLAG VALUE MUST ARRIVE IN.
 *
 * `--body hello` and `--body=hello` are the same thing to msgvault and NOT
 * the same thing to this gate: it derives the subcommand from the non-flag
 * tokens, so a split value becomes part of the command name. `--body hello`
 * was reviewed as the command `draft-edit hello`, and the help it fetched was
 * for a verb that does not exist.
 *
 * muxpad's CLI therefore forwards `--k=v` untouched (msgvault_run_argv), and
 * this is the test that says why.
 */
test('a JOINED flag value leaves the command alone', () => {
  const help = (cmd) => (cmd === 'draft-edit' ? '--body string\n--revision int\n--json' : '');
  const joined = reviewArgv(
    ['draft-edit', '--json', '--body=hello', '--revision=2', '--', 'draft-abc'],
    help,
  );
  assert.equal(joined.ok, true);
  // The command is the VERB, with no flag value dragged into it.
  assert.ok(!joined.command.includes('hello'), joined.command);
});

test('a SPLIT flag value is swallowed into the command, which is the bug', () => {
  // Documented rather than fixed here: the gate is the broker's and changing
  // how it parses is a root install. The CLI avoids the shape instead.
  const seen = [];
  const help = (cmd) => {
    seen.push(cmd);
    return '--body string\n--json';
  };
  reviewArgv(['draft-edit', '--json', '--body', 'hello', '--', 'draft-abc'], help);
  assert.ok(
    seen.some((c) => c.includes('hello')),
    'the value ended up in the command name',
  );
});

/** The two flags the drafts bug needed, and the three the gate refuses. */
test('draft-delete and draft-edit may carry --revision', () => {
  const help = () => '--revision int\n--body string\n--json';
  for (const a of [
    ['draft-delete', '--json', '--revision=1', '--', 'd1'],
    ['draft-edit', '--json', '--body=x', '--revision=2', '--', 'd1'],
  ])
    assert.equal(reviewArgv(a, help).ok, true, a[0]);
});

test('but an agent still may not choose the mailbox', () => {
  // `--account`, `--source-id` and `--from` change WHICH IDENTITY sends, and
  // the gate refuses all three whatever help says. That is deliberate, and it
  // is also why a misdirected draft cannot be steered from here — see the
  // report on the OceanWP draft.
  const help = () => '--account string\n--source-id int\n--from string\n--json';
  for (const f of ['--account=me@x.com', '--source-id=3', '--from=me@x.com']) {
    const r = reviewArgv(['draft-reply', '--json', f, '--', '1'], help);
    assert.equal(r.ok, false, f);
    assert.match(r.why, /not something an agent sets/);
  }
});
