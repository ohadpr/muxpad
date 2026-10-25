/**
 * WHAT A COMPACTION IS TOLD TO KEEP.
 *
 * One text, because there are two callers and they must not drift: the Compact
 * button the user presses (web/src/lib/context-pressure.ts) and the recovery
 * muxpad runs itself when a send has already failed for want of room
 * (server/src/agent-runner/context-heal.ts).
 *
 * The instructions are not decoration. `/compact` with no guidance answers with
 * a paragraph about the SHAPE of the conversation — "we discussed the pricing
 * and agreed on an approach" — standing where the numbers, the names, the file
 * paths and the decisions used to be. This is the one chance to say which of
 * those have to survive, and it is the user's own history being spent.
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
