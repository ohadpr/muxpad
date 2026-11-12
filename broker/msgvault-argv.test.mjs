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
