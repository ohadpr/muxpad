#!/usr/bin/env node
import { isAuthFailureText } from '../server/dist/agent-runner/auth-heal.js';
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
        thinking: { type: 'disabled' },
        effort: 'low',
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
        // PRINT WHAT WAS RECORDED, not the field that is never populated.
        // Top-level `utilization` is undefined on every real event — the
        // numbers live in `unifiedWindows`, which is why `record` reads them
        // there — so this line printed "five_hour ?%" on every successful
        // probe and read like a failure in a log nobody could interpret.
        const windows = pool.usage(account.id);
        console.log(
          windows.length
            ? `${account.id}: ${windows.map((w) => `${w.scope} ${Math.ceil(w.utilization)}%`).join(', ')}`
            : `${account.id}: recorded (no window reported)`,
        );
      }
    }
    session.close?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${account.id}: ${message}`);
    // THE PROBE IS THE ONLY THING THAT ASKS AN IDLE ACCOUNT ANYTHING. When it
    // comes back "Not logged in", that is the earliest this machine can know a
    // subscription has stopped working — an hour or more before somebody opens
    // a pane and watches it fail. It used to end up in a log file instead, so
    // the account stayed preferred and the next session walked into it.
    if (isAuthFailureText(message.replace(/^Claude Code returned an error result:\s*/i, ''))) {
      pool.markCredential(account.id, 'dead', message);
      console.error(
        `${account.id}: marked signed out — run /login, then: muxpad claude-account status`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
  // A WINDOW IS PROOF OF A LOGIN. Nothing else clears the mark on an idle
  // account: no pane may run on it for days, and the mark does not expire.
  if (got) pool.markCredential(account.id, 'ok');
  if (!got) console.error(`${account.id}: no rate-limit event — nothing recorded`);
  asked += 1;
}
pool.close();
if (asked === 0) console.error('No matching account');
