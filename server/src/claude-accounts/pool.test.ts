import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountPool,
  accountEnv,
  assertSharedHistory,
  assistantQuota,
  quotaBlock,
  readAccountConfig,
  readAccountConfigOrNull,
  resultQuota,
} from './pool.js';
const dirs: string[] = [];
const pools: AccountPool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'muxpad-accounts-'));
  dirs.push(dir);
  const primary = join(dir, 'primary');
  const backup = join(dir, 'backup');
  mkdirSync(join(primary, 'projects'), { recursive: true });
  mkdirSync(backup);
  symlinkSync(join(primary, 'projects'), join(backup, 'projects'));
  writeFileSync(
    join(dir, 'claude-accounts.json'),
    JSON.stringify({
      version: 1,
      preferred: 'primary',
      accounts: [
        { id: 'primary', label: 'Primary', configDir: primary, priority: 0 },
        { id: 'backup', label: 'Backup', configDir: backup, priority: 1 },
      ],
    }),
  );
  let now = 10000;
  const pool = new AccountPool(dir, () => now);
  pools.push(pool);
  return {
    pool,
    dir,
    advance: (n: number) => {
      now += n;
    },
  };
}
describe('shared Claude account pool', () => {
  it('shares exhaustion across independent runners, persists restart, and expires cooldown', () => {
    const { pool, dir, advance } = fixture();
    const second = new AccountPool(dir, () => 10000);
    pools.push(second);
    expect(pool.choose('pane-a', 'opus')?.id).toBe('primary');
    pool.block('primary', { scope: 'all', until: 20000, reason: 'quota' });
    expect(second.choose('pane-b', 'opus')?.id).toBe('backup');
    advance(11000);
    expect(pool.choose('pane-c', 'opus')?.id).toBe('primary');
    expect(pool.choose('pane-b', 'opus', new Set(), 'backup')?.id).toBe('backup');
  });
  /**
   * THE INCIDENT THIS CAME FROM. The preferred account's login died; the pool
   * knew nothing about logins, so it kept handing every new session to it, and
   * each one failed four times and gave up with a healthy account sitting idle
   * beside it. A dead credential is not a quota block and must not be stored
   * as one: it has no reset time, and it ends when a person runs /login.
   */
  it('skips a signed-out account, and keeps skipping it — no timer lifts this', () => {
    const { pool, advance } = fixture();
    expect(pool.choose('pane-a', 'opus')?.id).toBe('primary');
    pool.markCredential('primary', 'dead', 'Not logged in · Please run /login');
    expect(pool.choose('pane-b', 'opus')?.id).toBe('backup');
    // Not even the sticky assignment brings it back: the pane that was ON the
    // dead account is exactly the one that must move.
    expect(pool.choose('pane-a', 'opus', new Set(), 'primary')?.id).toBe('backup');
    advance(7 * 24 * 3600 * 1000);
    expect(pool.choose('pane-c', 'opus')?.id).toBe('backup');
  });

  it('comes back on evidence — a working turn or a probe, never on time passing', () => {
    const { pool } = fixture();
    pool.markCredential('primary', 'dead', 'Not logged in');
    expect(pool.choose('pane-a', 'opus')?.id).toBe('backup');
    expect(pool.credential('primary').state).toBe('dead');
    expect(pool.credential('primary').detail).toBe('Not logged in');
    pool.markCredential('primary', 'ok');
    expect(pool.choose('pane-b', 'opus')?.id).toBe('primary');
  });

  it('an account nobody has tried is a candidate, not a suspect', () => {
    const { pool } = fixture();
    expect(pool.credential('primary').state).toBe('ok');
    expect(pool.choose('pane-a', 'opus')?.id).toBe('primary');
  });

  it('a dead credential outranks a quota block, and survives it expiring', () => {
    const { pool, advance } = fixture();
    pool.block('primary', { scope: 'all', until: 20000, reason: 'quota' });
    pool.markCredential('primary', 'dead', 'Not logged in');
    advance(11000); // the quota block is over…
    expect(pool.choose('pane-a', 'opus')?.id).toBe('backup'); // …the logout is not
  });

  it('returns to primary when the sticky backup is exhausted after primary resets', () => {
    const { pool, advance } = fixture();
    pool.block('primary', { scope: 'all', until: 20000, reason: 'weekly quota' });
    expect(pool.choose('pane', 'opus')?.id).toBe('backup');
    advance(11000);
    pool.block('backup', { scope: 'all', until: 30000, reason: 'session quota' });
    expect(pool.choose('pane', 'opus', new Set(), 'backup')?.id).toBe('primary');
  });

  it('model quota does not block other models; exclusions cap retries', () => {
    const { pool } = fixture();
    pool.block('primary', { scope: 'opus', until: 20000, reason: 'opus quota' });
    expect(pool.choose('a', 'opus')?.id).toBe('backup');
    expect(pool.choose('b', 'sonnet')?.id).toBe('primary');
    expect(pool.choose('a', 'opus', new Set(['backup']))).toBeNull();
  });
  it('does not shorten a cooldown with stale reports', () => {
    const { pool } = fixture();
    pool.block('primary', { scope: 'all', until: 30000, reason: 'quota' });
    pool.block('primary', { scope: 'all', until: 11000, reason: 'stale' });
    expect(pool.db.prepare('SELECT until_ms FROM cooldowns').get()).toEqual({ until_ms: 30000 });
  });
  it('retains interrupted requests across connections and refuses different history roots', () => {
    const { pool, dir } = fixture();
    pool.savePending('pane', 'sid', 'continue saved work', 'quota');
    expect(pool.pending('pane')?.text).toBe('continue saved work');
    assertSharedHistory(pool.accounts());
    rmSync(join(dir, 'backup/projects'));
    mkdirSync(join(dir, 'backup/projects'));
    expect(() => assertSharedHistory(pool.accounts())).toThrow('same projects');
  });
  it('rejects duplicate account IDs and missing preferred account', () => {
    const { dir } = fixture();
    writeFileSync(
      join(dir, 'claude-accounts.json'),
      JSON.stringify({
        version: 1,
        preferred: 'missing',
        accounts: [{ id: 'a', label: 'A', configDir: dir, priority: 0 }],
      }),
    );
    expect(() => readAccountConfig(dir)).toThrow();
  });
  it('strips credential overrides without mutating the parent environment', () => {
    const { pool } = fixture();
    const parent = { ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', PATH: '/bin' };
    const env = accountEnv(pool.accounts()[1]!, parent);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(parent.ANTHROPIC_API_KEY).toBe('secret');
  });
});
describe('quota signals', () => {
  it('ignores warnings, overloads and allowed overage', () => {
    expect(quotaBlock({ status: 'allowed_warning' })).toBeNull();
    expect(quotaBlock({ status: 'rejected', overageStatus: 'allowed' })).toBeNull();
    expect(assistantQuota('overloaded', 'usage limit')).toBeNull();
    expect(assistantQuota(undefined, "You've hit your limit")).toBeNull();
  });
  it('recognizes provider denials and normalizes reset seconds', () => {
    expect(
      quotaBlock({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 5000 }, 1000),
    ).toMatchObject({ scope: 'opus', until: 5000000 });
    expect(
      quotaBlock({ status: 'rejected', overageDisabledReason: 'out_of_credits' }, 1000),
    ).toMatchObject({ scope: 'all', reason: 'out of credits', until: 301000 });
    expect(
      assistantQuota('rate_limit', "You've hit your limit · resets later", 1000),
    ).not.toBeNull();
    expect(assistantQuota('rate_limit', 'Too many requests per minute')).toBeNull();
  });
});

/**
 * HOW FULL EACH SUBSCRIPTION IS.
 *
 * The pool's only interest in `rate_limit_event` was failover: may this
 * request proceed, yes or no (`quotaBlock`). The same event carries
 * `utilization` — a percentage per window — and it was dropped, because a
 * request 80% of the way through its week is not a reason to switch accounts.
 *
 * It IS a reason to tell somebody, and "how much of our quota have we used on
 * each subscription" had no answer anywhere: not here, not in the config dirs,
 * not in the server log. These pin the number down so a card can read it.
 */
describe('utilisation, which failover never cared about', () => {
  it('records a reading that is NOT a denial — the whole point', () => {
    // `quotaBlock` returns null for this exact shape, so nothing about it
    // reached the database before.
    const { pool } = fixture();
    const info = { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.734 };
    expect(quotaBlock(info)).toBeNull();
    pool.record('primary', info);
    expect(pool.usage('primary')).toEqual([
      {
        scope: 'seven_day',
        utilization: 73.4,
        status: 'allowed',
        resetsAt: null,
        updatedAt: 10000,
      },
    ]);
  });

  it('keeps ONE row per window and overwrites it', () => {
    // The question is "how full is it now". A history would be a time series
    // nobody asked for, and the newest reading is the whole answer.
    const { pool, advance } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 });
    advance(60_000);
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42 });
    expect(pool.usage('primary')).toEqual([
      { scope: 'five_hour', utilization: 42, status: 'allowed', resetsAt: null, updatedAt: 70000 },
    ]);
  });

  it('keeps the windows apart, fullest first', () => {
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.12 });
    pool.record('primary', {
      status: 'allowed',
      rateLimitType: 'seven_day_opus',
      utilization: 0.88,
    });
    expect(pool.usage('primary').map((u) => [u.scope, u.utilization])).toEqual([
      ['seven_day_opus', 88],
      ['five_hour', 12],
    ]);
  });

  it('keeps the ACCOUNTS apart — the entire question is per-subscription', () => {
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.2 });
    pool.record('backup', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.9 });
    expect(pool.usage('primary')[0]?.utilization).toBe(20);
    expect(pool.usage('backup')[0]?.utilization).toBe(90);
  });

  it('DROPS a reading with no number rather than storing a zero', () => {
    // Older CLIs omit the field. "0%" is a claim about an empty quota that an
    // absent number does not support, and it is the claim most likely to be
    // believed — an empty bar reads as "plenty left".
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day' });
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day', utilization: null });
    expect(pool.usage('primary')).toEqual([]);
  });

  it('reads resetsAt in SECONDS, like every other field on this event', () => {
    // The SDK sends UNIX seconds; milliseconds are accepted for compatibility.
    // Same rule as quotaBlock, which had to learn it the same way.
    const { pool } = fixture();
    pool.record('primary', {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.05,
      resetsAt: 1_792_300_000,
    });
    expect(pool.usage('primary')[0]?.resetsAt).toBe(1_792_300_000_000);
    pool.record('backup', {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.05,
      resetsAt: 1_792_300_000_000,
    });
    expect(pool.usage('backup')[0]?.resetsAt).toBe(1_792_300_000_000);
  });

  it('records a DENIAL too, so a full window shows as full', () => {
    // Failover already blocks on this; the bar should also say 100-ish rather
    // than going blank at the one moment the number matters most.
    const { pool } = fixture();
    const info = { status: 'rejected', rateLimitType: 'seven_day_opus', utilization: 1 };
    expect(quotaBlock(info)).not.toBeNull();
    pool.record('primary', info);
    expect(pool.usage('primary')[0]).toMatchObject({ utilization: 100, status: 'rejected' });
  });

  it('says nothing about an account that has never run a turn', () => {
    // The number only exists once a turn reports it, so a fresh account is
    // empty rather than zero — see the drop rule above.
    const { pool } = fixture();
    expect(pool.usage('backup')).toEqual([]);
  });
});

describe('unifiedWindows, which is where the numbers actually are', () => {
  it('records EVERY window from the map, not the top-level field', () => {
    // THE BUG THIS REPLACES. `utilization` is declared at the top level of
    // SDKRateLimitInfo and was absent from every real event observed; a probe
    // against a live account answered with the map instead:
    //
    //   {status:'allowed', rateLimitType:'five_hour', unifiedWindows:{
    //      five_hour:{utilization:0.41}, seven_day:{utilization:0.03}}}
    //
    // Reading only the top level recorded nothing, every time, while looking
    // like it worked — the card said "no reading yet" and the reason was a
    // field name, not an absence of data.
    const { pool } = fixture();
    pool.record('primary', {
      status: 'allowed',
      rateLimitType: 'five_hour',
      unifiedWindows: {
        five_hour: { utilization: 0.41, resetsAt: 1_792_401_600 },
        seven_day: { utilization: 0.03, resetsAt: 1_792_609_200 },
      },
    });
    expect(pool.usage('primary')).toEqual([
      {
        scope: 'five_hour',
        utilization: 41,
        status: 'allowed',
        resetsAt: 1_792_401_600_000,
        updatedAt: 10000,
      },
      {
        scope: 'seven_day',
        utilization: 3,
        status: 'allowed',
        resetsAt: 1_792_609_200_000,
        updatedAt: 10000,
      },
    ]);
  });

  it('still reads the top-level field when there is no map', () => {
    // Older CLIs, and the shape the type documents. Keeping both costs one
    // branch and means a version change cannot silently empty the card again.
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.12 });
    expect(pool.usage('primary')[0]).toMatchObject({ scope: 'seven_day', utilization: 12 });
  });

  it('skips a window with no number rather than storing a zero', () => {
    const { pool } = fixture();
    pool.record('primary', {
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.05 }, seven_day: { resetsAt: 1 } },
    });
    expect(pool.usage('primary').map((u) => u.scope)).toEqual(['five_hour']);
  });
});

describe('a rejection is a reading', () => {
  it('records a rejected window as FULL, not as nothing', () => {
    // "You've hit your weekly limit" states that the window is full. It does
    // not restate it as a number, and a rejected event carries no
    // `unifiedWindows` — so recording only numbers left the one account that
    // mattered showing an em dash on the day it ran out.
    const { pool } = fixture();
    pool.record('primary', {
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt: 1_792_612_800,
      overageDisabledReason: 'out_of_credits',
    });
    expect(pool.usage('primary')).toEqual([
      {
        scope: 'seven_day',
        utilization: 100,
        status: 'rejected',
        resetsAt: 1_792_612_800_000,
        updatedAt: 10000,
      },
    ]);
  });

  it('still records nothing for an ALLOWED event with no number', () => {
    // The drop rule stands where it was right: an allowed request that says
    // nothing about fullness is not evidence of an empty quota.
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour' });
    expect(pool.usage('primary')).toEqual([]);
  });

  it('a real number beats the rejection default', () => {
    const { pool } = fixture();
    pool.record('primary', { status: 'rejected', rateLimitType: 'seven_day', utilization: 0.97 });
    expect(pool.usage('primary')[0]?.utilization).toBe(97);
  });
});

describe('a refusal that arrives as a failed RESULT', () => {
  // THE SIX-HOUR BUG. `accountCompletion` watched `rate_limit_event` and
  // `assistant` messages; a quota refusal on the housekeeping path is neither.
  // It ends the query with an error result carrying the provider's sentence,
  // so nothing was blocked, nothing failed over, and the next call chose the
  // same dead account. One sub-chat ran thirteen rounds between 16:23 and
  // 22:28 and every report came back `failed` with zero characters, while the
  // other subscription sat at 0.04% of its week.
  it('reads the provider sentence the SDK hands back', () => {
    expect(
      resultQuota(
        "Claude Code returned an error result: You've hit your weekly limit · resets Oct 21 at 1pm",
      ),
    ).toMatchObject({ scope: 'all' });
    expect(resultQuota('out of credits')).not.toBeNull();
    expect(resultQuota('usage limit reached for this org')).not.toBeNull();
  });

  it('ignores an error that is not about quota', () => {
    // A transport failure must not cool an account down: the account is fine
    // and blocking it would move the outage to the other subscription.
    expect(resultQuota('error_during_execution')).toBeNull();
    expect(resultQuota('fetch failed: ECONNRESET')).toBeNull();
    expect(resultQuota('')).toBeNull();
  });

  it('and the pool then hands out the OTHER subscription', () => {
    // The half that was actually broken. Detecting the refusal is only useful
    // if it reaches `block`, which is what makes `choose` stop returning the
    // dead account — the step the result path skipped for six hours.
    const { pool } = fixture();
    const first = pool.choose('housekeeping', 'haiku');
    expect(first?.id).toBe('primary');
    const denied = resultQuota(
      "Claude Code returned an error result: You've hit your weekly limit · resets Oct 21 at 1pm",
    );
    expect(denied).not.toBeNull();
    pool.block(first?.id ?? '', denied as NonNullable<typeof denied>);
    expect(pool.choose('housekeeping', 'haiku', new Set([first?.id ?? '']))?.id).toBe('backup');
    // …and it stays blocked for the next caller, who has no `tried` set at all.
    expect(pool.choose('housekeeping', 'haiku')?.id).toBe('backup');
  });

  it('does NOT loosen the prose guard that assistantQuota keeps', () => {
    // assistantQuota demands a structured `error` field because a model
    // TALKING about limits must never switch accounts. That stays; this is a
    // separate door for a failure, not for a sentence.
    expect(assistantQuota(undefined, "You've hit your weekly limit")).toBeNull();
    expect(assistantQuota('rate_limit', "You've hit your weekly limit")).not.toBeNull();
  });
});

describe('a config a human broke by hand', () => {
  /**
   * A POOL IS AN OPTIMISATION; LOSING IT MUST NOT COST THE APP.
   *
   * The runner reads this file at boot and on every send, through a parse that
   * threw. One typo, or a backup profile directory deleted by hand, therefore
   * crashed every Claude pane — and the respawn loop met the same file and
   * crashed again.
   */
  it('falls back to the default login instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mux-badcfg-'));
    writeFileSync(join(dir, 'claude-accounts.json'), '{ this is not json');
    expect(() => readAccountConfig(dir)).toThrow();
    expect(readAccountConfigOrNull(dir)).toBeNull();
    expect(AccountPool.open(dir)).toBeNull();
  });

  it('refuses a config whose accounts are secretly one directory', () => {
    // The schema compares configDir as TEXT, so a trailing "/." or a symlink
    // passed as two accounts while resolving to one profile — failover then
    // misattributes usage, and signing in to the "backup" replaces the login
    // it was supposed to stand beside.
    const dir = mkdtempSync(join(tmpdir(), 'mux-alias-'));
    const real = join(dir, 'profile');
    mkdirSync(join(real, 'projects'), { recursive: true });
    writeFileSync(
      join(dir, 'claude-accounts.json'),
      JSON.stringify({
        version: 1,
        preferred: 'primary',
        accounts: [
          { id: 'primary', label: 'P', configDir: real, priority: 0, enabled: true },
          { id: 'backup', label: 'B', configDir: `${real}/.`, priority: 1, enabled: true },
        ],
      }),
    );
    expect(() => readAccountConfig(dir)).toThrow(/same directory/);
    expect(readAccountConfigOrNull(dir)).toBeNull();
  });
});

describe('the single saved-request slot', () => {
  it('keeps the message the user was PROMISED was saved', () => {
    // "Request saved; use /retry after an account resets." Then they send
    // something else while still blocked, and INSERT OR REPLACE quietly threw
    // the promised one away. They come back after the reset, type /retry, and
    // get the wrong message — with nothing to say the first ever existed.
    const dir = mkdtempSync(join(tmpdir(), 'mux-pending-'));
    const pool = new AccountPool(dir);
    pool.savePending('pane', 'sid', 'the original request', 'no accounts');
    pool.savePending('pane', 'sid', 'something else entirely', 'no accounts');
    expect(pool.pending('pane')?.text).toBe('the original request');
    pool.close();
  });

  it('still takes a new request for a DIFFERENT session', () => {
    // The slot is per pane, and a pane whose conversation was replaced has no
    // business holding the old session's request: /retry refuses a checkpoint
    // from another session anyway, so keeping it would strand the slot.
    const dir = mkdtempSync(join(tmpdir(), 'mux-pending2-'));
    const pool = new AccountPool(dir);
    pool.savePending('pane', 'old-session', 'stale', 'no accounts');
    pool.savePending('pane', 'new-session', 'fresh', 'no accounts');
    expect(pool.pending('pane')?.text).toBe('fresh');
    pool.close();
  });

  it('is idempotent for the same request', () => {
    // Recovery can save the same text more than once as it walks the accounts.
    const dir = mkdtempSync(join(tmpdir(), 'mux-pending3-'));
    const pool = new AccountPool(dir);
    pool.savePending('pane', 'sid', 'same', 'first reason');
    pool.savePending('pane', 'sid', 'same', 'second reason');
    expect(pool.pending('pane')?.text).toBe('same');
    pool.close();
  });
});

it('converts existing fractional readings without waiting for another model request', () => {
  const { pool } = fixture();
  pool.db
    .prepare('INSERT INTO utilization VALUES (?, ?, ?, ?, ?, ?)')
    .run('backup', 'seven_day', 0.54, 'allowed', null, 10000);
  expect(pool.usage('backup')[0]?.utilization).toBe(54);
});

it('does not show an expired window as still exhausted or pretend its new usage is zero', () => {
  const { pool, advance } = fixture();
  pool.record('backup', {
    status: 'rejected',
    rateLimitType: 'five_hour',
    utilization: 1,
    resetsAt: 11,
  });
  expect(pool.usage('backup')[0]?.utilization).toBe(100);
  advance(2000);
  expect(pool.usage('backup')).toEqual([]);
});

it('does not round a floating-point 7% reading up to 8% on the card', () => {
  const { pool } = fixture();
  pool.record('backup', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.07 });
  expect(Math.ceil(pool.usage('backup')[0]?.utilization ?? 0)).toBe(7);
});

/**
 * ── A PROFILE DIRECTORY IS NOT WHERE THE TOKEN LIVES ─────────────────────
 *
 * On macOS the CLI keeps the subscription token in the KEYCHAIN, under an item
 * it names from CLAUDE_SECURESTORAGE_CONFIG_DIR — falling back to a hash of
 * CLAUDE_CONFIG_DIR only when the first is undefined. So the namespace is
 * chosen by which variable happens to be set, and a login done with one can
 * land on a different item from a read done with the other.
 *
 * Measured on this machine: a second account logged in with CLAUDE_CONFIG_DIR
 * alone wrote the right email and account uuid into its profile and still
 * answered "Failed to authenticate: OAuth session expired and could not be
 * refreshed" on its first real call.
 */
describe('the credential namespace travels with the profile', () => {
  const account = { id: 'backup', configDir: '/tmp/muxpad-acct-backup', priority: 2 };

  it('sets BOTH variables to the same directory', () => {
    const env = accountEnv(account as never, {});
    expect(env.CLAUDE_CONFIG_DIR).toBe(account.configDir);
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(account.configDir);
  });

  it('does not let a parent env leak another account’s namespace', () => {
    // The whole failure mode is one variable pointing somewhere the other
    // does not, so inheriting a stale one is exactly the bug.
    const env = accountEnv(account as never, {
      CLAUDE_CONFIG_DIR: '/somewhere/else',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/somewhere/else',
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(account.configDir);
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(account.configDir);
  });

  it('still refuses every variable that would bill an API key instead', () => {
    const env = accountEnv(account as never, {
      ANTHROPIC_API_KEY: 'sk-x',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
