import { COMPACT_INSTRUCTIONS } from '@muxpad/shared';

/**
 * WHEN THE CONTEXT IS FULL AND THE CHAT CAN NO LONGER ACCEPT A MESSAGE.
 *
 * ─── How we got here ───────────────────────────────────────────────────────
 *
 * muxpad turns the harness's automatic compaction OFF (`autoCompactEnabled:
 * false`, backends/claude.ts), and that was asked for in these words:
 *
 *   "don't auto-compact … but don't compact 1m down to 20k chars, be sensible.
 *    never auto compact on your own accord"
 *
 * The reason was good and still holds: compaction is lossy and irreversible,
 * and two automatic ones were measured dropping 372k tokens of a deal thread
 * nobody had agreed to lose. The comment on that option states the price it
 * accepted — "a session that runs to the real window ceiling now fails its
 * turn instead of silently compacting".
 *
 * That price has now been paid, and it is worse than it reads. At the ceiling
 * EVERY send fails with a bare `Prompt is too long`, so the chat is not
 * degraded, it is DEAD: you cannot ask it anything, including to compact
 * itself. Reported with a screenshot of two such failures in a row at 98%.
 *
 * ─── The distinction this module draws ─────────────────────────────────────
 *
 * Not compacting at 70% is a choice about a conversation that still works.
 * Not compacting at the wall is not a choice at all — the alternative to
 * compacting is a chat nobody can use again.
 *
 * So: nothing compacts on a percentage, ever. Compaction happens only AFTER a
 * send has actually failed for want of room, exactly once per message, and it
 * says so in the chat when it does. That is a recovery from a hard failure,
 * which is the one thing the user's instruction was never about.
 *
 * ─── And when compaction itself cannot help ────────────────────────────────
 *
 * A single message can be too large for the window on its own — a pasted log,
 * an enormous tool result — and no summary of the history fixes that. One
 * attempt per message is therefore the whole budget: the second failure stops
 * and says what to do instead, rather than compacting a conversation down to
 * nothing in a loop that cannot succeed.
 */

/**
 * The strings a provider uses when the request will not fit.
 *
 * `prompt is too long` is the one in the screenshot — the Anthropic API's own
 * phrasing, which arrives as the turn result's error rather than as assistant
 * prose. The rest are the same failure under other names: other providers, and
 * older/newer wording from this one.
 *
 * Matched case-insensitively on a substring because every one of these arrives
 * wrapped in something — `API Error: 400 {"type":"error",…}` — and the wrapper
 * is not stable enough to parse.
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds? the context (window|limit)/i,
  /input length and `?max_tokens`? exceed context limit/i,
  /too many (input )?tokens/i,
  /request too large/i,
];

/** Did this turn fail because the conversation no longer fits? */
export function isContextOverflow(error: string | undefined | null): boolean {
  if (!error) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(error));
}

/**
 * What muxpad asks for when IT decides to compact — the SAME words the Compact
 * button sends (shared/src/compaction.ts). If muxpad is going to spend the
 * user's history without being asked, it owes them the instruction that keeps
 * the parts they cannot get back.
 */
export const RECOVERY_COMPACT_INSTRUCTIONS = COMPACT_INSTRUCTIONS;

export type ContextHealDecision =
  /** Compact, then send `retry` again. */
  | { act: 'compact'; retry: string; notice: string }
  /** Nothing left to try — tell the user what to do instead. */
  | { act: 'give-up'; notice: string }
  /** Not this failure, or nothing to retry. */
  | { act: 'none' };

export interface ContextHealInput {
  /** The turn's error text. */
  error: string | undefined | null;
  /** The message that failed, so it can be sent again after the compaction.
   *  Null for a turn nobody typed (a cron fire, a background command). */
  pending: string | null;
  /** Has this message already had its one compaction? */
  alreadyTried: boolean;
}

/**
 * One decision, pure.
 *
 * A turn with NO pending text (a cron fire, a wakeup) still gets the
 * compaction — the next fire has to find a session it can use — but there is
 * nothing to send again, so it is not retried.
 */
export function contextHeal(input: ContextHealInput): ContextHealDecision {
  if (!isContextOverflow(input.error)) return { act: 'none' };
  // ── THE LOOP THIS CANNOT BE ──────────────────────────────────────────────
  //
  // The compaction is itself a turn (`/compact …`), and a session wedged hard
  // enough can fail THAT for the same reason. Healing it would compact again,
  // and again, each attempt a real model call against a conversation that is
  // never going to fit — the runaway version of the behaviour the user turned
  // off in the first place. A slash command is session management, never a
  // message to retry, so it ends the ladder instead of extending it.
  if (input.pending?.startsWith('/')) {
    return {
      act: 'give-up',
      notice:
        'This chat could not even be compacted — its history is past what the window can summarise. Start a fresh chat; this one stays readable.',
    };
  }
  if (input.alreadyTried) {
    return {
      act: 'give-up',
      notice:
        'Still too long after compacting. One message can be bigger than the whole window — if you just pasted something large, send it as a file instead; otherwise start a fresh chat and this one stays readable.',
    };
  }
  return {
    act: 'compact',
    retry: input.pending ?? '',
    notice:
      'This chat was full, so muxpad compacted it and is retrying. Nothing was dropped on a percentage — the send had already failed.',
  };
}
