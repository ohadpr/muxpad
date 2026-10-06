import { z } from 'zod';

/**
 * CHAT CARDS — named, persistent blocks pinned at the top of a conversation.
 *
 * The transcript is append-only, which is right for a conversation and wrong
 * for a VALUE. A market snapshot twice a weekday, or a build's progress, is one
 * fact that keeps being restated: every update buries the last one, and the
 * current answer scrolls away. Measured on this install: 22 cron fires in the
 * Investing chat, each a separate turn, to carry one line that replaces itself.
 *
 * A card is that value, held still. Any writer sets one — an agent mid-task, a
 * cron, a person at a terminal — and the newest write is what you see.
 *
 * ─── WHAT MUXPAD DOES NOT DECIDE ────────────────────────────────────────────
 * The CONTENT. No slots, no fields, no progress type, no component library:
 * the writer sends text, markdown or html and owns the layout entirely. Two
 * reasons, and the second is the real one:
 *
 *   · every structure muxpad imposes is a structure some card has to fight;
 *   · an agent can already draw a better progress bar than a generic component
 *     can, because it knows what the work is.
 *
 * So a shared progress FORMAT is a convention we document, not a feature we
 * build (see agent-instructions.ts).
 *
 * ─── WHY NAMES, AND WHY MORE THAN ONE ───────────────────────────────────────
 * A chat holds any number of cards, keyed by name. Unrelated updates — a build
 * and a market snapshot — do not belong in one block merely because they share
 * a conversation. And two writers CAN share a card when they mean to: that is
 * what `get` is for, so the composing is theirs rather than ours.
 */

/** How a card's content should be rendered. */
export const CardFormatSchema = z.enum(['text', 'markdown', 'html']);
export type CardFormat = z.infer<typeof CardFormatSchema>;

/**
 * Cap on one card's content.
 *
 * Generous — a hand-written HTML card with inline styles is a few KB — and
 * bounded, because a card is re-sent to every connected device on every write
 * and is pinned where it cannot be scrolled past. A writer that wants a
 * megabyte wants `muxpad publish`.
 */
export const CARD_MAX_BYTES = 64 * 1024;

/** Cards per chat. A pinned stack taller than the transcript is not a card. */
export const CARD_MAX_PER_TAB = 12;

/**
 * A card's name: short, stable, and usable as a shell argument.
 *
 * It is an IDENTITY, not a title — `muxpad card set build …` twice updates one
 * card rather than making two — so it is restricted to the characters that
 * survive a command line without quoting.
 */
export const CARD_NAME_RE = /^[a-zA-Z0-9][\w.-]{0,39}$/;

export function isValidCardName(name: string): boolean {
  return CARD_NAME_RE.test(name);
}

export const ChatCardSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  name: z.string(),
  content: z.string(),
  format: CardFormatSchema,
  /**
   * How often this card EXPECTS to be rewritten, in ms. Null = no expectation.
   *
   * The point of a card is the current value, so the interesting failure is not
   * a wrong value — it is a card that stopped updating because the script
   * broke, the cron was disabled or the pane died. Nothing else in muxpad can
   * notice that: only the writer knows its own cadence, so only the writer can
   * declare it.
   */
  every_ms: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ChatCard = z.infer<typeof ChatCardSchema>;

/**
 * Is this card overdue?
 *
 * A grace multiplier rather than the bare cadence: a daily card written at
 * 06:42 and again at 06:43 the next day is not late, and flagging it would
 * train you to ignore the flag. Overdue means MISSED, not "a moment later than
 * last time".
 */
export const CARD_STALE_GRACE = 1.5;

export function cardIsStale(card: Pick<ChatCard, 'every_ms' | 'updated_at'>, now: number): boolean {
  if (card.every_ms === null || card.every_ms <= 0) return false;
  return now - card.updated_at > card.every_ms * CARD_STALE_GRACE;
}
