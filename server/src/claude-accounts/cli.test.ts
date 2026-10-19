import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * THE FIRST RUN IS THE ONE THAT HAS TO WORK.
 *
 * Every assertion here is about somebody who has never configured anything.
 * The CLI used to answer them with `No Claude account pool configured` and
 * exit 1 — an error message for the state that 100% of installs start in,
 * which reads as a broken muxpad and offers no way forward. These tests pin
 * the two halves of the fix: a single account is a REPORTABLE state, and
 * `add` is one command that leaves a working pool behind.
 *
 * Run against the TypeScript source through tsx so a stale `dist` cannot make
 * them pass. The real CLI is this file with `node dist/...`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX = resolve(HERE, '..', '..', 'node_modules', '.bin', 'tsx');

let home: string;
let data: string;

/** A clean machine: an ordinary Claude Code profile, no muxpad account file. */
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'mux-accounts-'));
  home = join(root, 'home');
  data = join(root, 'data');
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(home, '.claude', '.claude.json'), '{}');
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  mkdirSync(data, { recursive: true });
});

function run(...args: string[]) {
  const r = spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      MUXPAD_DATA_DIR: data,
      // The runner reads this too; an inherited one would silently point every
      // test at the developer's own profile.
      CLAUDE_CONFIG_DIR: undefined as unknown as string,
    },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 0 };
}

const config = () => JSON.parse(readFileSync(join(data, 'claude-accounts.json'), 'utf8'));

describe('one account, nothing configured', () => {
  it('reports the single login instead of failing', () => {
    const { out, code } = run('status');
    expect(code).toBe(0);
    // The account nobody wrote down: reconstructed from the same place the
    // runner would look, so the path printed is the profile actually in use.
    expect(out).toContain(join(home, '.claude'));
    expect(out).not.toMatch(/No Claude account pool configured/);
  });

  it('names the command that adds a second one', () => {
    // Discoverability IS the feature here. A user who has never heard of
    // multi-account support should learn it exists from the only verb they
    // would ever type blind.
    expect(run('status').out).toContain('muxpad claude-account add');
  });

  it('writes no config file just for being asked', () => {
    run('status');
    expect(existsSync(join(data, 'claude-accounts.json'))).toBe(false);
  });

  it('says there is nothing to prefer, rather than crashing on `use`', () => {
    const { err, code } = run('use', 'backup');
    expect(code).toBe(1);
    expect(err).toContain('add backup');
  });
});

describe('add', () => {
  it('bootstraps the pool from the login that was already there', () => {
    const { out, code } = run('add', 'backup');
    expect(code).toBe(0);
    const c = config();
    expect(c.accounts.map((a: { id: string }) => a.id)).toEqual(['primary', 'backup']);
    // The EXISTING login stays preferred. Adding a spare is not a request to
    // start using it.
    expect(c.preferred).toBe('primary');
    expect(out).toContain('claude auth login');
  });

  it('shares the transcript root, because a failover mid-session must resume', () => {
    // A transcript written under the FIRST account has to be readable through
    // the second one's profile, or a switch mid-conversation resumes nothing.
    writeFileSync(join(home, '.claude', 'projects', 'session.jsonl'), 'first');
    run('add', 'backup');
    const link = join(data, 'claude-accounts', 'backup', 'projects');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, 'session.jsonl'), 'utf8')).toBe('first');
  });

  it('shares skills and settings but never the identity file', () => {
    run('add', 'backup');
    const dir = join(data, 'claude-accounts', 'backup');
    expect(lstatSync(join(dir, 'skills')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'settings.json')).isSymbolicLink()).toBe(true);
    // `.claude.json` carries WHO the profile is logged in as. Linking it would
    // quietly collapse the two subscriptions back into one.
    expect(existsSync(join(dir, '.claude.json'))).toBe(false);
  });

  it('refuses a duplicate id and a duplicate directory', () => {
    run('add', 'backup');
    expect(run('add', 'backup').code).toBe(1);
    expect(run('add', 'third', `--dir=${join(data, 'claude-accounts', 'backup')}`).code).toBe(1);
  });

  it('refuses an id the config schema would reject', () => {
    // Better here than as a zod error on the next read, which would fail some
    // unrelated command later.
    expect(run('add', 'Backup').code).toBe(1);
    expect(existsSync(join(data, 'claude-accounts.json'))).toBe(false);
  });
});

describe('the pool, once there is one', () => {
  it('marks the account that is not signed in', () => {
    run('add', 'backup');
    expect(run('status').out).toContain('NOT SIGNED IN');
  });

  it('keeps --json machine-readable, because the quota card parses it', () => {
    run('add', 'backup');
    const parsed = JSON.parse(run('status', '--json').out);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.utilization.map((u: { account: string }) => u.account)).toEqual([
      'primary',
      'backup',
    ]);
  });

  it('hands preference back to a survivor when the preferred one is removed', () => {
    run('add', 'backup');
    run('use', 'backup');
    expect(config().preferred).toBe('backup');
    run('remove', 'backup');
    expect(config().preferred).toBe('primary');
  });

  it('will not remove the last account', () => {
    run('add', 'backup');
    run('remove', 'backup');
    expect(run('remove', 'primary').code).toBe(1);
  });
});
