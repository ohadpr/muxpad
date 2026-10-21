// Run in a visible muxpad shell pane. Tool-free live login + resume smoke test.
import { randomUUID } from 'node:crypto';
import { AccountPool, accountEnv } from '../server/dist/claude-accounts/pool.js';
import { query } from '../server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const pool = AccountPool.open();
const account = pool?.accounts().find((a) => a.id === (process.argv[2] ?? 'backup'));
if (!account) throw new Error('Account not configured');
const sid = randomUUID();
const marker = `backup-check-${randomUUID().slice(0, 8)}`;
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 60000);
try {
  for (const [index, prompt] of [
    `Remember this marker: ${marker}. Reply with only that marker.`,
    'What marker did I ask you to remember? Reply with only that marker.',
  ].entries()) {
    const session = query({
      prompt,
      options: {
        env: accountEnv(account),
        model: 'haiku',
        ...(index === 0 ? { sessionId: sid } : { resume: sid }),
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        abortController: abort,
      },
    });
    let result = '';
    try {
      for await (const msg of session) {
        if (msg.type === 'result') {
          if (msg.subtype !== 'success') throw new Error(`Probe failed: ${msg.subtype}`);
          result = msg.result;
        }
      }
    } finally {
      session.close();
    }
    if (result.trim() !== marker)
      throw new Error(`Account probe did not return its marker (turn ${index + 1})`);
    console.log(
      JSON.stringify({ account: account.id, session: sid, turn: index + 1, passed: true }),
    );
  }
  console.log('PASS: backup inference and persisted conversation resume');
} finally {
  clearTimeout(timer);
  pool.close();
}
