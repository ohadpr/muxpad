import { pickSpokenBlock } from '@muxpad/shared';

/**
 * WHAT AN AGENT-MODE TURN SAYS OUT LOUD.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 *
 * A voice session hears one kind of frame: `speak`. Those are emitted by the
 * `reply` tool, and `reply` is registered in Chat mode alone — deliberately,
 * because when it was offered in both modes 3 of 5 live Agent turns called it
 * AND then wrote a closing recap for an audience they believed could not see
 * them, so the user got the same answer twice, the second time in the third
 * person. Describing a tool as "do not use me" is not a mechanism; not
 * offering it is.
 *
 * So Agent mode had no voice at all. It does not need the tool to have one:
 * its plain assistant text IS its answer — the mode's own contract says so in
 * those words — and the server already holds the whole turn's prose in the
 * stream buffer. This picks the sentence that was the ANSWER and hands it to
 * the voice session, which paraphrases it aloud like any other reply.
 *
 * ─── What it is NOT ───────────────────────────────────────────────────────
 *
 * Not a summary, and not a second written message. It selects; it never
 * composes. The voice model does the paraphrasing, which is its job and not
 * the server's, and a `speak` frame is read by the voice layer and by nothing
 * else — the chat UI has no branch for it, so Agent-mode prose cannot end up
 * on screen twice.
 */

/** Blocks are separated in the buffer by the blank line the runner emits
 *  between content blocks — and by the model's own paragraph breaks, which is
 *  the same unit for this purpose: a paragraph of status and a paragraph of
 *  answer are exactly what has to be told apart. */
const BLOCK_SPLIT = /\n{2,}/;

/**
 * How much of a turn's prose is worth speaking.
 *
 * A long Agent-mode answer is a WRITTEN artifact — tables, paths, code — and
 * reading the lot aloud is unbearable however well it is paraphrased. Past
 * this the spoken form stops at a sentence boundary and the screen keeps the
 * rest, which is where a reader would go for a table anyway.
 */
const SPOKEN_CAP = 1200;

/** Cut at the last sentence end before the cap, so the model is handed a
 *  whole thought rather than a severed clause. Falls back to the cap itself
 *  for prose with no punctuation in range. */
function trimToSentence(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return (stop > cap * 0.4 ? head.slice(0, stop + 1) : head).trimEnd();
}

/**
 * The answer in a turn's accumulated prose, or null when there is none.
 *
 * Null for an empty buffer and for a turn that wrote nothing — a turn of pure
 * tool work genuinely has nothing to say, and inventing a sentence for it is
 * the failure this whole mechanism exists to avoid.
 */
export function spokenAnswerFrom(buffer: string | undefined): string | null {
  const text = (buffer ?? '').trim();
  if (!text) return null;
  const blocks = text.split(BLOCK_SPLIT);
  // The same measured rule the chat client uses to promote a Chat-mode turn
  // that made no reply: the last block, unless an earlier one is materially
  // bigger (see pickSpokenBlock — a turn's final words are very often a status
  // note rather than its result).
  const i = pickSpokenBlock(blocks);
  if (i < 0) return null;
  const chosen = (blocks[i] ?? '').trim();
  return chosen ? trimToSentence(chosen, SPOKEN_CAP) : null;
}
