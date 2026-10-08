import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const MUXPAD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');

/**
 * SLACK SENDING IS ALLOWLISTED BY PROJECT, AND IT FAILS CLOSED.
 *
 * "Never allow a project that is using personal files/data to send slack
 *  messages, never ever ever ever. It should fail."
 *
 * An allowlist rather than a denylist, because a denylist fails OPEN for
 * everything nobody thought of — and the personal tree already holds health,
 * investing, land, notes and reading, and gains folders. A project is silent
 * until it is named.
 *
 * These run the real script with its real guard. No network: every case here
 * is refused before any API call, and the allowed case fails later on a
 * channel that does not exist, which is itself the proof it got past the gate.
 */
let dir: string;
let data: string;
const run = (cwd: string) =>
  execFileAsync(MUXPAD, ['slack', 'post', '#nope', 'hi'], {
    cwd,
    env: { ...process.env, MUXPAD_DATA_DIR: data, SLACK_SECRETS: '/dev/null' },
  }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: e.code ?? 1,
      out: (e.stdout ?? '') + (e.stderr ?? ''),
    }),
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slackguard-'));
  data = mkdtempSync(join(tmpdir(), 'slackdata-'));
  for (const d of ['work', 'work/sub', 'work-personal', 'personal']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe('the Slack project allowlist', () => {
  it('refuses EVERYTHING when no allowlist exists', async () => {
    rmSync(join(data, 'slack-allowed-roots'), { force: true });
    const r = await run(join(dir, 'work'));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no project is allowed to post yet');
  });

  it('allows a named root and its subdirectories', async () => {
    writeFileSync(join(data, 'slack-allowed-roots'), `${join(dir, 'work')}\n`);
    for (const d of ['work', 'work/sub']) {
      const r = await run(join(dir, d));
      // Past the gate — it now fails on the channel, which is the proof.
      expect(r.out, d).not.toContain('refusing to post');
      expect(r.out, d).not.toContain('no project is allowed');
    }
  });

  it('refuses a LOOKALIKE sibling — the match is on a path boundary', async () => {
    // `/work` must not admit `/work-personal`. A plain prefix test would.
    writeFileSync(join(data, 'slack-allowed-roots'), `${join(dir, 'work')}\n`);
    const r = await run(join(dir, 'work-personal'));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refusing to post');
  });

  it('refuses the PARENT of an allowed root', async () => {
    writeFileSync(join(data, 'slack-allowed-roots'), `${join(dir, 'work')}\n`);
    const r = await run(dir);
    expect(r.code).not.toBe(0);
  });

  it('refuses an unlisted project outright', async () => {
    writeFileSync(join(data, 'slack-allowed-roots'), `${join(dir, 'work')}\n`);
    const r = await run(join(dir, 'personal'));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refusing to post');
  });

  it('resolves BOTH sides of the comparison the same way', async () => {
    // On macOS /tmp is /private/tmp. The cwd goes through `pwd -P` and the
    // allowlist entry must too, or the two spellings never match — measured:
    // all four test directories refused, including the allowed one.
    writeFileSync(join(data, 'slack-allowed-roots'), `${join(dir, 'work')}\n`);
    const r = await run(join(dir, 'work'));
    expect(r.out).not.toContain('refusing to post');
  });

  it('ignores blanks and comments in the file', async () => {
    writeFileSync(join(data, 'slack-allowed-roots'), `# a comment\n\n   \n${join(dir, 'work')}\n`);
    const r = await run(join(dir, 'work'));
    expect(r.out).not.toContain('refusing to post');
  });
});

describe('one identity, and it says a machine wrote it', () => {
  it('reads no bot token anywhere in the script', () => {
    // Not "prefers the user token" — does not read the other one at all. A bot
    // DM lands in the recipient's separate conversation with "muxpad", which
    // the sender cannot see; having the option available is what let a DM use
    // it by accident.
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(code.filter((l) => /\$\{?SLACK_BOT_TOKEN/.test(l))).toEqual([]);
  });

  it('offers no way to ask for a bot', () => {
    expect(SRC).not.toContain('--as-bot');
  });

  it('prefixes every post with the robot, and does not double it', () => {
    const body = SRC.slice(SRC.indexOf('cmd_slack_post() {'));
    expect(body).toMatch(/text="🤖 \$text"/);
    // Already-prefixed text is left alone, so a relayed message is not 🤖 🤖.
    expect(body).toMatch(/"🤖"\*\)/);
  });

  it('guards before the credentials are even read', () => {
    // `slack_load` SOURCES the secrets file. A project that may not post has no
    // business holding the token in its environment, so the gate comes first —
    // and a refusal must not depend on getting the usage right either.
    // CODE ONLY. The comment above the call explains the ordering and mentions
    // `slack_load` by name, so matching raw source compares against prose —
    // which is how this assertion first failed on a correctly-ordered script.
    const body = SRC.slice(SRC.indexOf('cmd_slack_post() {'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const guard = body.indexOf('slack_guard_cwd');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('slack_load'));
    expect(guard).toBeLessThan(body.indexOf('usage: muxpad slack post'));
  });

  it('guards unpost too', () => {
    expect(SRC.slice(SRC.indexOf('cmd_slack_unpost() {'))).toContain('slack_guard_cwd');
  });
});
