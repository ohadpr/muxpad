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
  // FROM THE END. The answer is at the end of a turn, so an over-long buffer
  // loses its beginning — and it starts at a sentence boundary so the model
  // is handed a whole thought rather than a severed clause.
  const tail = text.slice(-cap);
  const start = Math.max(tail.indexOf('. '), tail.indexOf('! '), tail.indexOf('? '));
  return (start >= 0 && start < cap * 0.6 ? tail.slice(start + 2) : tail).trimStart();
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
  // ── THE TAIL OF WHAT THE TURN SAID, AND NOTHING CLEVERER ───────────────
  //
  // Two attempts tried to SELECT the answer out of the prose with
  // `pickSpokenBlock`, the rule the chat client uses to promote a Chat-mode
  // turn. It is measured on whole assistant MESSAGES and it does not survive
  // paragraph granularity: it returns the last paragraph in the ordinary
  // case, so a three-paragraph explanation ending "Then retry the build." was
  // spoken as "Then retry the build." Slicing from its answer to the end did
  // not help, because its answer WAS the end.
  //
  // THE RULE DOES NOT NEED TO BE CLEVER, because the voice model paraphrases
  // whatever it is handed — it is given this as material, not read out
  // verbatim. So the asymmetry is lopsided: a little narration riding along
  // costs a clause, and a missing paragraph costs the answer. Take the tail.
  return trimToSentence(text, SPOKEN_CAP);
}
