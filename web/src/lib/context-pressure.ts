import { COMPACT_INSTRUCTIONS } from '@muxpad/shared';
/**
 * HOW FULL IS THIS CONVERSATION — AND WHO IS SUPPOSED TO CARE.
 *
 * Not the reader, any more. muxpad compacts automatically again (see
 * server/src/agent-runner/auto-compact.ts, which fires at 90% of the model's
 * real window, between turns, with the instructions below), so the chat shows
 * no percentage, no warning cell and no colour change: "I don't want the user
 * to be thinking about compaction. Compaction should just happen."
 *
 * The meter did not disappear with the cell — it is in the session menu with
 * the token counts and a Compact button, for the moments somebody does want to
 * know. What is gone is the part that volunteered itself.
 *
 * WHAT IS LEFT HERE is the thing both compactions — the automatic one and the
 * button — have to agree on: what a compaction must keep.
 */

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
// THE SAME WORDS THE SELF-HEAL USES. Moved to shared the day muxpad gained a
// second caller (server/src/agent-runner/context-heal.ts, the recovery after a
// send has already failed): two copies of the instruction that decides what
// survives a compaction is exactly the thing that drifts unnoticed.
export { COMPACT_INSTRUCTIONS };

/** The sentence under the Compact button. Says what it costs, because the
 *  thing it costs is irreversible. */
export function compactionBlurb(tokens: number, max: number): string {
  const pct = max > 0 ? Math.round((tokens / max) * 100) : 0;
  return `Summarizes the older part of this chat into the context, keeping specifics and recent turns. It cannot be undone — currently ${pct}% full.`;
}
