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
    const info = { status: 'allowed', rateLimitType: 'seven_day', utilization: 73.4 };
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
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour', utilization: 10 });
    advance(60_000);
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour', utilization: 42 });
    expect(pool.usage('primary')).toEqual([
      { scope: 'five_hour', utilization: 42, status: 'allowed', resetsAt: null, updatedAt: 70000 },
    ]);
  });

  it('keeps the windows apart, fullest first', () => {
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'five_hour', utilization: 12 });
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 88 });
    expect(pool.usage('primary').map((u) => [u.scope, u.utilization])).toEqual([
      ['seven_day_opus', 88],
      ['five_hour', 12],
    ]);
  });

  it('keeps the ACCOUNTS apart — the entire question is per-subscription', () => {
    const { pool } = fixture();
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day', utilization: 20 });
    pool.record('backup', { status: 'allowed', rateLimitType: 'seven_day', utilization: 90 });
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
      utilization: 5,
      resetsAt: 1_792_300_000,
    });
    expect(pool.usage('primary')[0]?.resetsAt).toBe(1_792_300_000_000);
    pool.record('backup', {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 5,
      resetsAt: 1_792_300_000_000,
    });
    expect(pool.usage('backup')[0]?.resetsAt).toBe(1_792_300_000_000);
  });

  it('records a DENIAL too, so a full window shows as full', () => {
    // Failover already blocks on this; the bar should also say 100-ish rather
    // than going blank at the one moment the number matters most.
    const { pool } = fixture();
    const info = { status: 'rejected', rateLimitType: 'seven_day_opus', utilization: 100 };
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
        utilization: 0.41,
        status: 'allowed',
        resetsAt: 1_792_401_600_000,
        updatedAt: 10000,
      },
      {
        scope: 'seven_day',
        utilization: 0.03,
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
    pool.record('primary', { status: 'allowed', rateLimitType: 'seven_day', utilization: 12 });
    expect(pool.usage('primary')[0]).toMatchObject({ scope: 'seven_day', utilization: 12 });
  });

  it('skips a window with no number rather than storing a zero', () => {
    const { pool } = fixture();
    pool.record('primary', {
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 5 }, seven_day: { resetsAt: 1 } },
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
    pool.record('primary', { status: 'rejected', rateLimitType: 'seven_day', utilization: 97 });
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
