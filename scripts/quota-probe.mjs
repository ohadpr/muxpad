#!/usr/bin/env node
/**
 * ASK EACH CLAUDE SUBSCRIPTION HOW FULL IT IS, now, without waiting for work.
 *
 * `AccountPool.record` keeps the `utilization` the SDK reports — but only on a
 * turn that actually runs, so a card drawn before anybody worked says "no
 * reading yet", which is true and useless.
 *
 * The transcripts cannot answer it either, and that is worth writing down: the
 * two accounts SHARE ~/.claude/projects by symlink (assertSharedHistory
 * requires it, so resume works across a failover), so a rate-limit payload on
 * disk cannot be attributed to the account that received it. The only way to
 * get a number per subscription is to ask under that subscription's
 * credentials, which is what this does.
 *
 * One haiku turn, no tools, one turn max. The answer rides on an event the
 * request produces anyway.
 */
import { AccountPool, accountEnv } from '../server/dist/claude-accounts/pool.js';

const pool = AccountPool.open();
if (!pool) {
  console.error('No Claude account pool configured');
  process.exit(1);
}
const { query } = await import('../server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const only = process.argv[2];
let asked = 0;

/** Accounts the pool is already refusing. Probing one spends a turn to be told
 *  what the cooldown row already says, and the answer comes back wearing an
 *  auth error ("Not logged in") rather than a quota one, which reads like a
 *  different fault entirely. The card draws these from the cooldown. */
const cooling = new Set(
  pool.db
    .prepare('SELECT account FROM cooldowns WHERE until_ms > ?')
    .all(Date.now())
    .map((r) => r.account),
);

for (const account of pool.accounts().filter((a) => a.enabled)) {
  if (only && account.id !== only) continue;
  if (cooling.has(account.id) && !only) {
    console.log(`${account.id}: in cooldown — not probed`);
    asked += 1;
    continue;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 45_000);
  let got = false;
  try {
    const session = query({
      prompt: 'Reply with the single character: .',
      options: {
        env: accountEnv(account),
        model: 'haiku',
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        abortController: abort,
      },
    });
    for await (const msg of session) {
      if (msg.type === 'rate_limit_event') {
        const info = msg.rate_limit_info;
        pool.record(account.id, info);
        got = true;
        console.log(`${account.id}: ${info.rateLimitType ?? 'all'} ${info.utilization ?? '?'}%`);
      }
    }
    session.close?.();
  } catch (error) {
    console.error(`${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!got) console.error(`${account.id}: no rate-limit event — nothing recorded`);
  asked += 1;
}
pool.close();
if (asked === 0) console.error('No matching account');
