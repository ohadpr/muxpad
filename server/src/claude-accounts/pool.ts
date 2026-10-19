import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

const accountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  configDir: z.string().refine(isAbsolute, 'configDir must be absolute'),
  priority: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
});
export const configSchema = z
  .object({
    version: z.literal(1),
    preferred: z.string(),
    accounts: z.array(accountSchema).min(1),
  })
  .superRefine((c, ctx) => {
    if (
      new Set(c.accounts.map((a) => a.id)).size !== c.accounts.length ||
      new Set(c.accounts.map((a) => a.configDir)).size !== c.accounts.length ||
      !c.accounts.some((a) => a.id === c.preferred && a.enabled)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Account IDs/directories must be unique and preferred must be enabled',
      });
    }
  });
export type Account = z.infer<typeof accountSchema>;
export type QuotaBlock = { scope: string; until: number; reason: string };
/** HOW FULL AN ACCOUNT IS, as the SDK last reported it.
 *
 * `quotaBlock` below answers "may this request proceed", which is a yes/no and
 * is all the pool needed while its only job was failover. It throws away the
 * number the same event carries — `utilization`, a percentage per window —
 * because a request that is merely 80% of the way through its week is not a
 * reason to do anything.
 *
 * It IS a reason to tell somebody. "How much of our quota have we used on each
 * subscription" had no answer anywhere: not in this database, not in the
 * config dirs, not in the server log. The number arrives on every turn and was
 * being dropped on the floor. */
export type QuotaUse = {
  scope: string;
  utilization: number;
  status: string;
  resetsAt: number | null;
  updatedAt: number;
};
export function accountDataDir(): string {
  return process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');
}
export function readAccountConfig(dir = accountDataDir()) {
  const path = join(dir, 'claude-accounts.json');
  if (!existsSync(path)) return null;
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Shared WAL database: runners coordinate atomically without depending on an
 * HTTP server reconnect. Contains metadata/checkpoints, never credentials. */
export class AccountPool {
  readonly db: Database.Database;
  constructor(
    readonly dir: string,
    readonly now = Date.now,
  ) {
    this.db = new Database(join(dir, 'claude-accounts.sqlite'));
    chmodSync(join(dir, 'claude-accounts.sqlite'), 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cooldowns (
        account TEXT NOT NULL, scope TEXT NOT NULL, until_ms INTEGER NOT NULL,
        reason TEXT NOT NULL, PRIMARY KEY(account, scope));
      CREATE TABLE IF NOT EXISTS assignments (
        pane TEXT PRIMARY KEY, account TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (
        pane TEXT PRIMARY KEY, session TEXT NOT NULL, text TEXT NOT NULL,
        reason TEXT NOT NULL, updated_at INTEGER NOT NULL);
      -- ONE ROW PER WINDOW PER ACCOUNT, overwritten in place. A history of
      -- utilisation would be a time series nobody asked for; the question is
      -- "how full is it now", and the newest reading is the whole answer.
      CREATE TABLE IF NOT EXISTS utilization (
        account TEXT NOT NULL, scope TEXT NOT NULL, pct REAL NOT NULL,
        status TEXT NOT NULL, resets_at INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY(account, scope));
    `);
    // TWO RUNNERS OPEN THIS DATABASE AT ONCE. `CREATE TABLE IF NOT EXISTS` is
    // safe for that; a check-then-ALTER is not — both see the column missing,
    // both run the ALTER, and the loser throws `duplicate column name` out of
    // a constructor, which is a runner that failed to start. The check still
    // avoids the common no-op; the catch covers the interleaving.
    const columns = this.db.prepare('PRAGMA table_info(pending)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'requires_history')) {
      try {
        this.db.exec('ALTER TABLE pending ADD COLUMN requires_history INTEGER NOT NULL DEFAULT 1');
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
  }
  static open(dir = accountDataDir()): AccountPool | null {
    return readAccountConfig(dir) ? new AccountPool(dir) : null;
  }
  accounts(): Account[] {
    return readAccountConfig(this.dir)?.accounts ?? [];
  }
  private eligible(account: Account, model: string): boolean {
    if (!account.enabled) return false;
    const family = model.toLowerCase().includes('sonnet')
      ? 'sonnet'
      : model.toLowerCase().includes('haiku')
        ? 'haiku'
        : 'opus';
    return !this.db
      .prepare('SELECT 1 FROM cooldowns WHERE account = ? AND until_ms > ? AND scope IN (?, ?)')
      .get(account.id, this.now(), 'all', family);
  }
  choose(
    pane: string,
    model: string,
    excluded: ReadonlySet<string> = new Set(),
    current?: string,
  ): Account | null {
    return this.db
      .transaction(() => {
        const config = readAccountConfig(this.dir);
        if (!config) return null;
        const candidates = config.accounts.filter(
          (a) => !excluded.has(a.id) && this.eligible(a, model),
        );
        candidates.sort(
          (a, b) =>
            Number(b.id === current) - Number(a.id === current) ||
            Number(b.id === config.preferred) - Number(a.id === config.preferred) ||
            a.priority - b.priority,
        );
        const chosen = candidates[0];
        if (!chosen) return null;
        this.db
          .prepare('INSERT OR REPLACE INTO assignments VALUES (?, ?, ?)')
          .run(pane, chosen.id, this.now());
        return chosen;
      })
      .immediate();
  }
  /**
   * Record what the SDK just said about this account's windows.
   *
   * EVERY event, not just the rejections — that is the difference between this
   * and `block()`. An account at 73% of its week is not blocked and never will
   * be recorded by the failover path, and 73% is exactly what somebody wants
   * to see before starting a long job.
   *
   * A reading with no `utilization` is dropped rather than stored as zero:
   * older CLIs omit the field, and "0%" is a claim about an empty quota that
   * an absent number does not support.
   */
  record(id: string, info: Record<string, unknown>): void {
    const status = String(info.status ?? 'allowed');
    const write = this.db.prepare(
      `INSERT INTO utilization VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, scope) DO UPDATE SET
         pct = excluded.pct, status = excluded.status,
         resets_at = excluded.resets_at, updated_at = excluded.updated_at`,
    );
    // UNIX seconds; milliseconds accepted, never NaN. quotaBlock's rule.
    const ms = (raw: unknown) =>
      typeof raw === 'number' && Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : null;
    // EVERY WINDOW IS IN `unifiedWindows`, and that is where the numbers live.
    // The top-level `utilization` is declared on the type and was absent from
    // every real event observed — a probe against a live account answered
    //
    //   {status:'allowed', rateLimitType:'five_hour', unifiedWindows:{
    //      five_hour:{utilization:0.41,...}, seven_day:{utilization:0.03,...}}}
    //
    // so reading the top-level field alone recorded nothing, every time, while
    // looking like it worked. Both are read; the map wins where it overlaps,
    // because it is the one that names which window each number belongs to.
    const windows = info.unifiedWindows;
    if (windows && typeof windows === 'object') {
      for (const [scope, raw] of Object.entries(windows as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const w = raw as Record<string, unknown>;
        if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
        write.run(id, scope, w.utilization, status, ms(w.resetsAt), this.now());
      }
      return;
    }
    const scope = String(info.rateLimitType ?? 'all');
    const pct = info.utilization;
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      write.run(id, scope, pct, status, ms(info.resetsAt), this.now());
      return;
    }
    // A REJECTION IS A READING. "You've hit your weekly limit" states that the
    // window is full; it just does not restate it as a number, and a rejected
    // event carries no `unifiedWindows` at all. Recording nothing left the one
    // account that mattered showing an em dash — "we do not know" — on the day
    // it ran out, which is the opposite of what the reader needed.
    if (status === 'rejected') write.run(id, scope, 100, status, ms(info.resetsAt), this.now());
  }
  /** Every window this account has reported, fullest first. */
  usage(id: string): QuotaUse[] {
    return (
      this.db
        .prepare(
          'SELECT scope, pct, status, resets_at, updated_at FROM utilization WHERE account = ? ORDER BY pct DESC',
        )
        .all(id) as {
        scope: string;
        pct: number;
        status: string;
        resets_at: number | null;
        updated_at: number;
      }[]
    ).map((r) => ({
      scope: r.scope,
      utilization: r.pct,
      status: r.status,
      resetsAt: r.resets_at,
      updatedAt: r.updated_at,
    }));
  }
  block(id: string, block: QuotaBlock): void {
    this.db
      .prepare(`INSERT INTO cooldowns VALUES (?, ?, ?, ?) ON CONFLICT(account, scope)
      DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms), reason = excluded.reason`)
      .run(id, block.scope, block.until, block.reason);
  }
  savePending(
    pane: string,
    session: string,
    text: string,
    reason: string,
    requiresHistory = false,
  ): void {
    const previous = this.pending(pane);
    const required =
      requiresHistory || (previous?.session === session && !!previous.requiresHistory);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pending (pane, session, text, reason, updated_at, requires_history) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(pane, session, text, reason, this.now(), Number(required));
  }
  pending(
    pane: string,
  ): { session: string; text: string; reason: string; requiresHistory: number } | undefined {
    return this.db
      .prepare(
        'SELECT session, text, reason, requires_history AS requiresHistory FROM pending WHERE pane = ?',
      )
      .get(pane) as
      | { session: string; text: string; reason: string; requiresHistory: number }
      | undefined;
  }
  clearPending(pane: string): void {
    this.db.prepare('DELETE FROM pending WHERE pane = ?').run(pane);
  }
  close(): void {
    this.db.close();
  }
}

/** Histories and tool configuration must already be shared at enrollment.
 * Never silently start an empty conversation when an account changes. */
export function assertSharedHistory(accounts: Account[]): void {
  const roots = new Set(
    accounts.filter((a) => a.enabled).map((a) => realpathSync(join(a.configDir, 'projects'))),
  );
  if (roots.size > 1)
    throw new Error(
      'Claude account profiles must share the same projects directory before failover is enabled',
    );
}

export function accountEnv(
  account: Account,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, CLAUDE_CONFIG_DIR: account.configDir };
  // These override subscription login. Never accidentally charge an API key.
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_PROFILE',
  ])
    delete env[name];
  return env;
}

/** SDK rate_limit_event is authoritative. A rejected included allowance can
 * still allow overage; do not interrupt that successful request. */
export function quotaBlock(info: Record<string, unknown>, now = Date.now()): QuotaBlock | null {
  if (
    info.status !== 'rejected' ||
    info.overageStatus === 'allowed' ||
    info.overageStatus === 'allowed_warning'
  )
    return null;
  const type = String(info.rateLimitType ?? '');
  const scope = type === 'seven_day_opus' ? 'opus' : type === 'seven_day_sonnet' ? 'sonnet' : 'all';
  const rawReset = info.resetsAt;
  // SDK uses UNIX seconds. Accept milliseconds for compatibility, never NaN.
  const reset =
    typeof rawReset === 'number' && Number.isFinite(rawReset)
      ? rawReset < 1e12
        ? rawReset * 1000
        : rawReset
      : 0;
  return {
    scope,
    until: reset > now ? reset : now + 5 * 60_000,
    reason:
      info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits'
        ? 'out of credits'
        : `${type || 'subscription'} usage limit`,
  };
}

/**
 * A DENIAL THAT ARRIVES AS A FAILED RESULT, not as an event or an assistant turn.
 *
 * `accountCompletion` watched `rate_limit_event` and `assistant` messages, and
 * a quota refusal on the housekeeping path arrives as NEITHER: the SDK ends
 * the query with an error `result` carrying the provider's sentence. So
 * `denied` stayed null, nothing was blocked, nothing failed over, and the next
 * call chose the same dead account again.
 *
 * Measured on this install: one sub-chat ran thirteen rounds between 16:23 and
 * 22:28 and every report came back `failed` with zero characters, each logged
 * as `generation failed … You've hit your weekly limit · resets Oct 21 at 1pm`
 * — six hours of lost reports while the other subscription sat at 0.04% of its
 * week. It only started working when a PANE turn (which does see the real
 * event) finally wrote the cooldown.
 *
 * Text-only, unlike `assistantQuota` below, and deliberately: that one guards
 * against PROSE about quota and so demands a structured `error` field. A
 * failed result is not prose, it is the failure itself, so its sentence is
 * evidence. The phrase list is the same one.
 */
export function resultQuota(text: string, now = Date.now()): QuotaBlock | null {
  if (
    !/you(?:'|’)?ve (?:hit|reached) your (?:(?:weekly|daily|monthly|session) )?limit|usage limit|out of credits|credit balance.*(?:low|exhaust)|insufficient credits/i.test(
      text,
    )
  )
    return null;
  return { scope: 'all', until: now + 5 * 60_000, reason: text.slice(0, 200) };
}

/** Compatibility fallback only for provider-generated assistant errors.
 * Normal model prose about quota must NEVER trigger an account switch. */
export function assistantQuota(error: unknown, text: string, now = Date.now()): QuotaBlock | null {
  if (error !== 'rate_limit' && error !== 'billing_error') return null;
  if (
    !/you(?:'|’)?ve (?:hit|reached) your (?:(?:weekly|daily|monthly|session) )?limit|usage limit|out of credits|credit balance.*(?:low|exhaust)|insufficient credits/i.test(
      text,
    )
  )
    return null;
  return { scope: 'all', until: now + 5 * 60_000, reason: text.slice(0, 200) };
}
