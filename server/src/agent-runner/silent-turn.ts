/**
 * DID THIS TURN PUT ANYTHING IN THE CHAT?
 *
 * The sidebar's bold mark means "there is something new to read here". It was
 * set on every `turn-done`, which is wrong for the one kind of turn that
 * routinely has nothing to show: a scheduled fire that did its job quietly.
 *
 * Reported as *"the @Investing chat keeps showing as 'new message' but nothing
 * is happening there"*. That chat carries six crons — an hourly card refresh
 * among them, whose own prompt says "Say nothing" — so between 07:00 and 12:00
 * on a weekday the row went bold roughly every half hour, every time
 * promising something the log did not contain. A mark that is always on is not
 * a mark.
 *
 * ─── The three ways a turn speaks, and why one bit covers them ─────────────
 *
 * They arrive by three different routes and no single channel sees them all:
 *
 *   · PROSE — the model's own text, streamed as it is produced.
 *   · A REPLY — Chat mode's `reply` tool, which is a tool call, not prose.
 *   · `muxpad say` — a marker inside a Bash tool_result, lifted out at render
 *     time (shared/chat-events.ts). This is the one muxpad's own instructions
 *     tell a scheduled job to use when it DOES have something to report, so
 *     missing it would silence exactly the fire that mattered.
 *
 * The runner is the only party that sees all three, so it answers the question
 * and the server consumes the answer.
 *
 * ─── Why `human` is in the predicate ──────────────────────────────────────
 *
 * A turn somebody TYPED still marks the chat even when it ends quiet. They are
 * waiting on it; "it finished" is news in itself, and a silent answer to a
 * direct question is a thing you want to go and look at. This exists for work
 * nobody asked for in the moment — crons, wakeups, a background command
 * finishing — which is where silence is the normal, designed outcome.
 */
export interface TurnSpeech {
  /** Did a person type the message that started this turn? */
  human: boolean;
  /**
   * Something a reader would SEE reached the transcript during the turn.
   *
   * In Agent mode that includes the model's prose; in Chat mode it does not —
   * there, prose is the scratchpad and the chat renders the `reply` tool,
   * so counting it would call every thinking-out-loud fire "spoken". A
   * `muxpad say` counts in both.
   */
  said: boolean;
  /** Chat mode's `reply` tool calls this turn. */
  replies: number;
  /** The turn failed. An error is always news, whatever was or wasn't said. */
  failed?: boolean;
}

/**
 * True when the chat gained nothing a reader would open it for.
 *
 * Deliberately conservative: every uncertain case answers FALSE, because the
 * failure directions are not symmetric. An extra bold row is noise a glance
 * clears; a missing one loses news silently, and the user never learns there
 * was anything to miss.
 */
export function isSilentTurn(turn: TurnSpeech): boolean {
  if (turn.human) return false;
  if (turn.failed) return false;
  if (turn.said) return false;
  return turn.replies === 0;
}

/**
 * DOES THIS TURN'S PROSE COUNT AS SPEAKING?
 *
 * Prose is the commonest way a turn says something, and there are exactly two
 * situations where it is machinery instead — and both were already settled
 * elsewhere in the product before this function existed to say so:
 *
 *   · CHAT MODE, where the chat renders the `reply` tool and nothing else, so
 *     prose is the scratchpad. Counting it would call every thinking-out-loud
 *     fire "spoken".
 *
 *   · A CRON FIRE, for the same reason one step along. muxpad's instructions
 *     say a scheduled turn is machinery end to end — "everything you do inside
 *     a scheduled fire folds into one collapsed run … none of it reaches the
 *     conversation" — and the chat already implements that: `cron` is in
 *     MACHINE_TURN_VARIANTS (web/src/lib/chat-voice.ts), so a fire's prose is
 *     never promoted into the log. `muxpad say` is the one channel that
 *     speaks, which is exactly what the instructions tell a cron to use.
 *
 * The bug this fixes is the two channels disagreeing about one turn, which is
 * the SECOND time that has happened here. `nw-hourly` is a card refresher
 * whose prompt says "Say nothing", three different ways, and ends its turn
 * with "Card updated." anyway. The chat did the right thing and showed
 * nothing; the push read that same prose as news and buzzed a phone at 09:04,
 * every weekday hour. Reported with a screenshot of the notification.
 *
 * Asking a model to be silent is not a mechanism. If the conversation will not
 * show a fire's prose, nothing downstream may treat it as something said.
 *
 * `muxpad say`, a `reply`, an explicit `notify` and a FAILURE are all
 * untouched: each is a deliberate statement, and a cron that genuinely has
 * news still gets through.
 */
export function proseSpeaks(opts: { mode: string; cron: boolean }): boolean {
  if (opts.cron) return false;
  return opts.mode !== 'chat';
}
