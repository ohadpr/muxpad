import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AccountPool,
  type QuotaBlock,
  accountEnv,
  assistantQuota,
  quotaBlock,
  resultQuota,
} from './pool.js';

/** Tool-free housekeeping (headlines, summaries, titles) uses the same account
 * availability as panes. A rejected completion must not become a fake title. */
export async function* accountCompletion(args: {
  prompt: string;
  options: Options;
}): AsyncGenerator<SDKMessage> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const pool = AccountPool.open();
  const tried = new Set<string>();
  try {
    while (!args.options.abortController?.signal.aborted) {
      const account = pool?.choose('housekeeping', args.options.model ?? 'haiku', tried);
      if (pool && !account) throw new Error('All Claude accounts are unavailable');
      let denied: QuotaBlock | null = null;
      const session = query({
        prompt: args.prompt,
        options: {
          ...args.options,
          // Titles, labels and handoffs do not need extended reasoning.
          // Apply centrally so new housekeeping callers inherit the policy.
          thinking: { type: 'disabled' },
          effort: 'low',
          ...(account ? { env: accountEnv(account) } : {}),
          tools: [],
          allowedTools: [],
        },
      });
      try {
        for await (const message of session) {
          if (message.type === 'rate_limit_event') {
            const info = message.rate_limit_info as unknown as Record<string, unknown>;
            // Housekeeping turns burn the same subscription a pane does, so
            // they report its fullness too — see AccountPool.record.
            if (account) pool?.record(account.id, info);
            denied = quotaBlock(info);
          }
          if (message.type === 'assistant') {
            const text = message.message.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            denied ??= assistantQuota(message.error, text);
          }
          // THE SHAPE THIS PATH ACTUALLY GETS. A quota refusal here ends the
          // query with a FAILED RESULT carrying the provider's sentence — not
          // a rate_limit_event, not an assistant turn — so the two checks
          // above never fired and the account was never blocked. Six hours of
          // spawn reports were lost to it; see resultQuota.
          if (message.type === 'result' && message.subtype !== 'success') {
            // `errors: string[]` is the SDK's own field on a failed result —
            // the others are defensive, this one is the documented shape. It
            // was missing, so a refusal that arrived ONLY as an errors array
            // (no preceding rate_limit_event, no assistant error) blocked
            // nothing and the next housekeeping call picked the exhausted
            // account straight back up.
            const errors = (message as { errors?: unknown }).errors;
            const text = [
              (message as { result?: unknown }).result,
              (message as { subtype?: unknown }).subtype,
              (message as { error?: unknown }).error,
              ...(Array.isArray(errors) ? errors : [errors]),
            ]
              .map((v) => (typeof v === 'string' ? v : ''))
              .join(' ');
            denied ??= resultQuota(text);
          }
          if (denied && pool && account) {
            pool.block(account.id, denied);
            tried.add(account.id);
            break;
          }
          yield message;
        }
      } finally {
        session.close?.();
      }
      if (!denied || !pool) return;
    }
  } finally {
    pool?.close();
  }
}
