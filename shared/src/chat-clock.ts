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
 * Two kinds of tab have no clock and never reach this file. A SUB-CHAT is a
 * piece of work rather than a conversation: it retires the moment it delivers
 * its result to its parent. A TAB WITH NO AGENT IN IT — a terminal, a web view
 * — has no inbox, so "send it a message" is not a way back and decay would be
 * a one-way door. See server/src/tab-clock.ts (`hasDecayClock`) for both, and
 * for the sidebar full of finished agents that settled the first question.
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

/**
 * How far apart the one-time backfill spreads the clocks it starts.
 *
 * Three days, so an existing sidebar empties over days four to seven instead
 * of in a single minute. Not a policy anyone's chats live under afterwards —
 * the first message a chat receives puts it back on the plain
 * {@link CHAT_DECAY_DAYS} clock like everything else.
 */
export const CHAT_STAGGER_DAYS = 3;

export const CHAT_STAGGER_MS = CHAT_STAGGER_DAYS * DAY_MS;

/**
 * Where one chat's clock starts when the backfill hands every existing chat a
 * clock at once.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * One `Date.now()` for ninety rows means ninety rows expire in the same
 * minute. On the fourth morning the user's sidebar does not thin, it EMPTIES:
 * every untouched workspace becomes a collapsed `N done` header over nothing,
 * in one tick, with one `tab.updated` per row behind it (and `tab.updated`
 * costs every connected client a full uncoalesced workspace walk — see
 * server/src/tab-activity.ts). A list that clears itself in one sweep is the
 * failure that killed Google Inbox's bundles and Outlook's Clutter: the
 * mechanism may be correct and the user still reads it as data loss, and the
 * first thing they do is go looking for the off switch.
 *
 * ── WHY THE OFFSET IS FORWARD, NEVER BACKWARD ────────────────────────────────
 * The offset is always ≥ 0, so a backfilled clock expires no EARLIER than the
 * four days it would have anyway. That is the day-one guarantee, kept by
 * construction rather than by arithmetic anyone has to check: staggering can
 * only ever give a chat more time, never less. Spreading backwards would have
 * been the same size of change and would have put some chats a day from death
 * on the morning this ships — which is the outcome "everyone starts fresh" was
 * chosen to avoid.
 *
 * The visible cost is that a chat at the far end of the spread sits at 0% fill
 * for up to three days before its tile starts filling. That is not a lie: it
 * genuinely has more than four days left.
 *
 * ── WHY NOT RANK BY last_activity_at ─────────────────────────────────────────
 * Because that is the reading the user rejected, in the smaller. The backfill
 * deliberately does not look at activity (see migrations.ts v27: it measures
 * the terminal, not you), and ordering the spread by it would smuggle the same
 * signal back in — the chat you left tailing a log would outlive the chat you
 * actually finished with. This reads nothing but the id, so it stays strictly
 * inside the decision already made: everyone starts fresh, just not all in the
 * same minute.
 *
 * Derived from the id rather than randomised, for the reason
 * `fallbackTabIcon` is: a stored random number is indistinguishable from one
 * somebody meant, and a pure function is the same answer in a test, in a
 * re-run, and in a restore. FNV-1a, same as that sibling — it needs to be
 * well-spread, not cryptographic. ULIDs from one install share a long
 * timestamp prefix, so the hash must mix the whole string; FNV-1a does.
 */
export function staggeredClockStart(id: string, boot: number): number {
  return boot + staggeredClockOffset(id);
}

/**
 * The offset alone — `staggeredClockStart(id, boot) - boot`.
 *
 * Split out for ONE caller and it is worth naming why, because the caller is a
 * later migration reading this one's handwriting. v33 has to tell a
 * `clock_started_at` a USER set (a real message; the thing a recency order
 * wants) from one this backfill invented (an id hash; the thing that would put
 * an untouched chat at the top of a list, sometimes at a time in the future).
 * Subtracting this offset turns every backfilled row's clock back into the ONE
 * boot instant they were all stamped from — so they identify themselves as a
 * population, exactly, with no stored flag and no guessing.
 *
 * That only works while this is a pure function of the id, which it already had
 * to be (see above). The migration is therefore reading a property this
 * function already guaranteed, not asking it for a new one.
 */
export function staggeredClockOffset(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // >>> 0 keeps it an unsigned 32-bit value; Math.imul does the mod-2^32
    // multiply that plain `*` would lose precision on.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Math.floor((hash / 0x1_0000_0000) * CHAT_STAGGER_MS);
}
