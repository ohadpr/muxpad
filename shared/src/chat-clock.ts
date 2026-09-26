/**
 * The chat CLOCK: how a chat ages, and when it becomes `done`.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 * A TOP-LEVEL chat carries a 4-day clock. Any message the user sends it resets
 * the clock to full. When the clock runs out the chat is DONE: it leaves the
 * live list, collapses into a `done` group, and comes back the moment you send
 * it another message. Nothing is ever deleted — `done` is a rendering state,
 * not a tombstone. Pinning stops the clock entirely.
 *
 * A SUB-CHAT has no clock and never reaches this file. It is a piece of work,
 * not a conversation: it retires the moment it delivers its result to its
 * parent. See server/src/tab-clock.ts for why, and for the sidebar full of
 * finished agents that settled the question.
 *
 * ── WHY THE MATH LIVES IN shared ─────────────────────────────────────────────
 * It does NOT live here so the client can re-derive lifecycle — the server
 * computes `done` and publishes it on the tab row precisely so nothing else
 * ever has to (muxpad already has a bug class where two surfaces disagree
 * about one value, and a decay clock evaluated in two places is exactly that
 * shape). It lives here because the SERVER is the only caller and the rules
 * are pure arithmetic worth testing without a database — and because a client
 * that wants to animate between polls must animate the same curve the server
 * publishes, not a second one it invented.
 *
 * The one question that is NOT answered here is WHETHER a chat has a clock at
 * all, and whether it has already retired. Both need the database and live in
 * server/src/tab-clock.ts.
 */
import { z } from 'zod';

/** The whole policy, in one number. No per-chat weighting, no half-lives, no
 *  "important chats live longer" — pinning is the only override, and it is a
 *  deliberate act rather than a heuristic that has to be right. */
export const CHAT_DECAY_DAYS = 4;

export const DAY_MS = 86_400_000;

export const CHAT_DECAY_MS = CHAT_DECAY_DAYS * DAY_MS;

/**
 * The clock as published on a tab row. Every field is DERIVED from one stored
 * timestamp (the effective clock start) plus `now`; none of it is stored.
 */
export const ChatClockSchema = z.object({
  /** Epoch ms the current clock started — for a child, its parent's. */
  started_at: z.number(),
  /** Epoch ms the chat becomes done. Null when the clock is stopped. */
  expires_at: z.number().nullable(),
  /** 0 → 1: how much of the chip's tile is buried. 0 while fresh, 1 at
   *  expiry. Continuous, because the fill is a continuous visual and the
   *  server should not be the thing that makes it jump. */
  fill: z.number(),
  /** Inside the final day — the chip drops its tile for a dashed outline. */
  last_day: z.boolean(),
  /** Pinned: the clock does not run, and this chat can never become done. */
  stopped: z.boolean(),
});
export type ChatClock = z.infer<typeof ChatClockSchema>;

/**
 * Derive the published clock from a start time.
 *
 * `pinned` is not folded into `started_at` (i.e. we do not keep re-stamping a
 * pinned chat's clock) because unpinning must resume from where it stopped
 * being meaningful, and because a stored timestamp that silently tracks `now`
 * is a lie the moment anyone reads the column directly.
 */
export function chatClock(opts: {
  started_at: number;
  now: number;
  pinned: boolean;
}): ChatClock {
  const { started_at, now, pinned } = opts;
  if (pinned) {
    return { started_at, expires_at: null, fill: 0, last_day: false, stopped: true };
  }
  const expires_at = started_at + CHAT_DECAY_MS;
  const elapsed = now - started_at;
  const fill = Math.max(0, Math.min(1, elapsed / CHAT_DECAY_MS));
  return {
    started_at,
    expires_at,
    fill,
    // `<=` rather than `<`: at exactly one day left the chat IS in its final
    // day. The boundary belongs to the louder state.
    last_day: expires_at - now <= DAY_MS,
    stopped: false,
  };
}

/** Has this clock run out? False for a stopped (pinned) clock, always. */
export function chatClockDone(clock: ChatClock, now: number): boolean {
  if (clock.stopped || clock.expires_at === null) return false;
  return now >= clock.expires_at;
}
