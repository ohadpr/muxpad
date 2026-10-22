/**
 * HOW FULL IS THIS CONVERSATION, AND WHAT DOES THE CHAT SAY ABOUT IT.
 *
 * muxpad does not compact anything on its own any more. The runner sets
 * `autoCompactEnabled: false`, which replaced a 200k window that was quietly
 * rewriting people's threads — measured on one of them, two automatic
 * compactions in three hours, 372k tokens of verbatim history dropped without
 * anybody being asked. A compaction cannot be undone from inside the session,
 * so it is a decision, and decisions belong to the person reading the chat.
 *
 * That trade only works if the chat can SEE the pressure coming, which is what
 * this module is for: the thresholds, and the words that go with them.
 */

export type ContextLevel = 'ok' | 'warn' | 'high';

/** Below this the meter stays in the session menu where it has always lived —
 *  a number nobody needs to watch should not be on screen. */
export const CONTEXT_WARN_PCT = 70;
/** Past this the chat is close enough to the ceiling that the next long turn
 *  could hit it, and the cell says so in the danger colour. */
export const CONTEXT_HIGH_PCT = 88;

export function contextLevel(pct: number | undefined): ContextLevel {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'ok';
  if (pct >= CONTEXT_HIGH_PCT) return 'high';
  if (pct >= CONTEXT_WARN_PCT) return 'warn';
  return 'ok';
}

/**
 * What the compaction must keep — sent as `/compact <instructions>`.
 *
 * WITHOUT THIS, a long thread becomes a paragraph. The observed default on a
 * deal thread was 216k tokens in and 4,663 out: a summary that keeps the SHAPE
 * of the conversation and loses the things it was made of — who owns which
 * account, which number was agreed, which question is still open. Those are
 * exactly the parts that are not recoverable from the repo or the files, so
 * they are what the instructions name.
 *
 * Deliberately not a token budget: the CLI's compactor decides length, and a
 * number here would be a request it has no contract to honour. Naming the
 * CONTENT is a thing it can actually act on.
 */
export const COMPACT_INSTRUCTIONS = [
  'Preserve the specifics, not just the shape of the conversation.',
  'Keep verbatim: names, roles and who owns what; numbers, prices, dates and deadlines;',
  'file paths, ids, urls and commands; decisions taken and the reasoning given for them;',
  'every question still open and every commitment made to someone.',
  'Keep the most recent exchanges in full.',
  'Drop: superseded drafts, tool output that can be re-read from disk, and repetition.',
  'When in doubt about a detail that cannot be recovered from files or the repo, keep it.',
].join(' ');

/** The sentence under the Compact button. Says what it costs, because the
 *  thing it costs is irreversible. */
export function compactionBlurb(tokens: number, max: number): string {
  const pct = max > 0 ? Math.round((tokens / max) * 100) : 0;
  return `Summarizes the older part of this chat into the context, keeping specifics and recent turns. It cannot be undone — currently ${pct}% full.`;
}
