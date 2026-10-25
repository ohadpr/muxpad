import { COMPACT_INSTRUCTIONS } from '@muxpad/shared';

/**
 * WHEN THE CONTEXT IS FULL AND THE CHAT CAN NO LONGER ACCEPT A MESSAGE.
 *
 * ─── How we got here ───────────────────────────────────────────────────────
 *
 * The harness compacts on its own when the window runs out, and did so
 * invisibly for as long as anybody had been using muxpad. Then, in two days:
 * a 200k window was imposed on a 1M model to cap a watcher's recurring bill
 * (which rewrote live threads — 216k → 4.7k on a deal thread), and the fix for
 * THAT turned compaction off altogether (which wedged a chat at the ceiling:
 * every send answering `Prompt is too long`, including the one that would ask
 * for a compaction).
 *
 * Both overrides are gone. The harness's own compaction is back, which is what
 * nobody ever had to think about.
 *
 * This module is what remains: the backstop for a send that fails for want of
 * room ANYWAY. It is not the primary mechanism and must not become one — the
 * harness compacts BEFORE the failure, and this only runs if something got
 * past that (a backend with no compaction of its own, a single message larger
 * than the window, a provider whose limit is lower than the harness thinks).
 *
 * ─── The distinction this module draws ─────────────────────────────────────
 *
 * muxpad itself still compacts nothing on a percentage. What it does here is
 * recover from a send that has ALREADY failed: exactly once per message, with
 * the instructions the Compact button uses, and it says so in the chat. That
 * is a recovery from a hard failure rather than a judgement about a
 * conversation that still works, and it is the one thing "never auto compact
 * on your own accord" was never about.
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
