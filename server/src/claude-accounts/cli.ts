/**
 * `muxpad claude-account` — the whole surface of multi-subscription Claude.
 *
 * THE DEFAULT IS ONE ACCOUNT AND NO CONFIG FILE, and that is not an error
 * state. It used to be: with no `claude-accounts.json` every verb printed
 * "No Claude account pool configured" and exited 1, which tells somebody who
 * has never heard of the feature that something is broken, and tells somebody
 * who HAS no way to start. A single account is the ordinary case — your normal
 * Claude Code login, exactly as it works without muxpad — so `status` reports
 * it, says failover is off, and names the one command that turns it on.
 *
 * `add` is that command. The setup is four fiddly steps (a config dir, a
 * shared `projects` so a session survives a switch, shared skills/settings, a
 * JSON file with absolute paths) and every one of them is a way to get a
 * half-working pool. Doing them by hand is how this repo's own second account
 * was set up; this exists so nobody has to do it twice.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Account,
  AccountPool,
  accountDataDir,
  assertSharedHistory,
  readAccountConfig,
} from './pool.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const opt = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const positional = argv.filter((a) => !a.startsWith('--'));
const [verb = 'status', id] = positional;
const json = flags.has('--json');
const dir = accountDataDir();
const configPath = join(dir, 'claude-accounts.json');

const USAGE = `muxpad claude-account — run Claude Code panes across more than one subscription

  status [--json]          what accounts exist, how full each one is, what is cooling off
  add <id> [--label=…] [--dir=…]
                           create a second profile, share history with the first, enable failover
  remove <id>              drop an account from the pool (its profile directory is left alone)
  use <id|auto>            prefer one account for new sessions; auto restores priority order
  reset <id>               clear a recorded cooldown after you have fixed the account

With no accounts file muxpad uses your ordinary Claude Code login and nothing
else — one account, no failover, nothing to configure. 'add' is the step up.`;

/** The login every Claude Code user already has. It is implicit — there is no
 *  row for it anywhere until `add` writes one — so it is reconstructed here
 *  from the same environment variable the runner would use. */
function defaultAccount(): Account {
  return {
    id: 'primary',
    label: 'Primary',
    configDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    priority: 0,
    enabled: true,
  };
}

function write(config: { version: 1; preferred: string; accounts: Account[] }): void {
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
}

/** SHARE IT IF THE FIRST ACCOUNT HAS IT AND THE NEW ONE DOES NOT.
 *
 * `projects` is the load-bearing one: both profiles must resolve to a single
 * transcript root or a failover mid-conversation cannot resume the session,
 * and `assertSharedHistory` refuses to run at all. The rest are shared because
 * a second subscription is the same person doing the same work — it would be a
 * surprise for their skills and settings to vanish when a quota flipped.
 *
 * `.claude.json` is deliberately NOT in this list. It carries the account
 * identity; linking it would make the two profiles one login again. */
const SHARED = ['projects', 'skills', 'plugins', 'commands', 'settings.json'];

function shareProfile(from: string, to: string): string[] {
  const linked: string[] = [];
  for (const name of SHARED) {
    const src = join(from, name);
    const dst = join(to, name);
    if (name === 'projects') mkdirSync(src, { recursive: true });
    if (!existsSync(src)) continue;
    // lstat, not exists: a dangling symlink is "there" for the purpose of not
    // clobbering it, and existsSync follows the link and says no.
    try {
      lstatSync(dst);
      continue;
    } catch {
      /* not present — link it */
    }
    symlinkSync(src, dst);
    linked.push(name);
  }
  return linked;
}

function add(): void {
  if (!id || !/^[a-z][a-z0-9_-]*$/.test(id))
    throw new Error('Usage: muxpad claude-account add <id>   (lowercase letters, digits, - and _)');
  const existing = readAccountConfig(dir);
  const accounts = existing ? [...existing.accounts] : [defaultAccount()];
  if (accounts.some((a) => a.id === id)) throw new Error(`Account "${id}" already exists`);
  const first = accounts[0];
  if (!first) throw new Error('No first account to share history with');
  const configDir = resolve(opt('--dir') ?? join(dir, 'claude-accounts', id));
  if (accounts.some((a) => a.configDir === configDir))
    throw new Error(`Another account already uses ${configDir}`);

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const linked = shareProfile(first.configDir, configDir);
  const account: Account = {
    id,
    label: opt('--label') ?? id.charAt(0).toUpperCase() + id.slice(1),
    configDir,
    priority: Math.max(...accounts.map((a) => a.priority)) + 1,
    enabled: true,
  };
  accounts.push(account);
  assertSharedHistory(accounts);
  write({ version: 1, preferred: existing?.preferred ?? first.id, accounts });

  console.log(`Added "${id}" (${configDir}).`);
  if (linked.length) console.log(`Shares with ${first.id}: ${linked.join(', ')}.`);
  console.log('');
  console.log('IT HAS NO LOGIN YET. Sign it in — a DIFFERENT Anthropic account:');
  console.log('');
  console.log(`  CLAUDE_CONFIG_DIR=${configDir} claude auth login`);
  console.log('');
  console.log(
    `Then: muxpad claude-account status. New Claude panes prefer "${existing?.preferred ?? first.id}"`,
  );
  console.log('and fall back to this one when a usage window is refused.');
}

function remove(pool: AccountPool | null): void {
  const config = readAccountConfig(dir);
  if (!config) throw new Error('No accounts file — nothing to remove');
  const left = config.accounts.filter((a) => a.id !== id);
  if (left.length === config.accounts.length) throw new Error(`No such account: ${id}`);
  if (!left.length) throw new Error('At least one account must remain; delete the file instead');
  const first = left[0];
  if (!first) throw new Error('At least one account must remain');
  write({
    version: 1,
    preferred: left.some((a) => a.id === config.preferred) ? config.preferred : first.id,
    accounts: left,
  });
  pool?.db.prepare('DELETE FROM cooldowns WHERE account = ?').run(id);
  pool?.db.prepare('DELETE FROM utilization WHERE account = ?').run(id);
  console.log(`Removed "${id}" from the pool. Its profile directory was left in place.`);
}

/** THE NUMBER, IN WORDS. `--json` is what the quota card reads; this is what a
 *  person reads, and it is the default because a person is who types it. */
function report(pool: AccountPool | null): void {
  const config = readAccountConfig(dir);
  const accounts = config?.accounts ?? [defaultAccount()];
  const preferred = config?.preferred ?? accounts[0]?.id;
  const cooldowns = pool
    ? (pool.db
        .prepare('SELECT account, scope, until_ms, reason FROM cooldowns WHERE until_ms > ?')
        .all(Date.now()) as { account: string; scope: string; until_ms: number; reason: string }[])
    : [];
  if (json) {
    console.log(
      JSON.stringify(
        {
          configured: Boolean(config),
          preferred,
          accounts,
          cooldowns,
          assignments: pool?.db.prepare('SELECT * FROM assignments').all() ?? [],
          utilization: accounts.map((a) => ({ account: a.id, windows: pool?.usage(a.id) ?? [] })),
          pending: pool?.db.prepare('SELECT pane, session, reason, updated_at FROM pending').all() ?? [],
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const a of accounts) {
    const mark = a.id === preferred ? '*' : ' ';
    const use = pool?.usage(a.id)?.[0];
    const cool = cooldowns.find((c) => c.account === a.id);
    const state = cool
      ? `blocked until ${new Date(cool.until_ms).toLocaleString()} (${cool.reason})`
      : use
        ? `${Math.ceil(use.utilization)}% of ${use.scope}`
        : 'no reading yet';
    const signedIn = existsSync(join(a.configDir, '.claude.json')) ? '' : '  — NOT SIGNED IN';
    console.log(`${mark} ${a.id.padEnd(10)} ${state}${signedIn}`);
    console.log(`  ${' '.repeat(10)} ${a.configDir}`);
  }
  console.log('');
  if (!config) {
    console.log('One account, no failover — this is the ordinary setup and needs no config file.');
    console.log('Add a second subscription:  muxpad claude-account add backup');
    return;
  }
  const n = accounts.length;
  console.log(`* preferred for new sessions. ${n} account${n === 1 ? "" : "s"} in the pool.`);
  console.log('A refused usage window moves new work to the next eligible account.');
}

try {
  if (verb === 'help' || flags.has('--help') || flags.has('-h')) {
    console.log(USAGE);
  } else if (verb === 'add') {
    add();
  } else {
    // The pool only opens when a config file exists; every verb below treats a
    // missing one as "one account", not as a failure.
    const pool = AccountPool.open(dir);
    try {
      if (verb === 'status' || verb === 'list') report(pool);
      else if (verb === 'remove') remove(pool);
      else if (verb === 'use') {
        const config = readAccountConfig(dir);
        if (!config)
          throw new Error(
            'Only one account — nothing to prefer. Add a second: muxpad claude-account add backup',
          );
        const selected =
          id === 'auto'
            ? [...config.accounts]
                .filter((a) => a.enabled)
                .sort((a, b) => a.priority - b.priority)[0]
            : config.accounts.find((a) => a.id === id && a.enabled);
        if (!selected) throw new Error('Usage: muxpad claude-account use <account-id|auto>');
        assertSharedHistory(config.accounts);
        write({ version: 1, preferred: selected.id, accounts: config.accounts });
        console.log(
          `Preferred Claude account: ${selected.id}. Applies to new sessions; healthy running sessions keep their account.`,
        );
      } else if (verb === 'reset') {
        if (!pool) throw new Error('Only one account — there is no cooldown to clear');
        if (!pool.accounts().some((a) => a.id === id))
          throw new Error('Usage: muxpad claude-account reset <account-id>');
        pool.db.prepare('DELETE FROM cooldowns WHERE account = ?').run(id);
        console.log(`Cleared cooldown for ${id}. Blocked panes can use /retry.`);
      } else throw new Error(USAGE);
    } finally {
      pool?.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
