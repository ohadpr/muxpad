// ANSWERING AN AGENT QUESTION OUT LOUD.
//
// When the agent blocks — an `ask_user`, or the reversibility gate stopping on
// `git push` — the chat socket carries a `{t:'question'}` and the pane sits at
// `blocked` until an `{t:'answer'}` comes back. The voice session speaks the
// question (speak-bridge.ts). This module is the other half: turning what the
// user then SAYS into that answer frame.
//
// ═══ WHY THE CLIENT HAS TO DO THE MATCHING ═══
//
// It would be tidier to let the voice model pick the option — it has the labels
// in context and it is a language model. It cannot. A `session.delegation.created`
// event carries METADATA ONLY: an id and an `offset_ms`. The request text is
// RECONSTRUCTED by us from the user's own input transcript (transcript.ts), so
// the words that reach this module are the user's, verbatim, and no amount of
// prompting changes that. The model's only lever is WHETHER to delegate.
//
// ═══ THE SAFETY RULE, WHICH IS THE WHOLE DESIGN ═══
//
// The server's contract (reversibility.ts) is: ONLY the exact affirmative label
// is a yes; anything else — a different option, a typed sentence, a dismissal —
// is a no, and its text is forwarded to the agent as the reason. FAIL CLOSED.
//
// So this module never has to be a good classifier. It has to be a SAFE one:
//
//   - It recognises an utterance that essentially IS one of the labels, and
//     returns that label exactly.
//   - Everything else returns null, and the caller forwards the raw words. For
//     a gate that is a denial carrying the user's correction; for an `ask_user`
//     it is the same free-text answer the composer's "Other…" box sends. Both
//     are already-supported paths, and neither can approve anything.
//
// That is why matching is EXACT-after-normalisation and never substring.
// "Don't do it" CONTAINS "Do it", and a containment rule would approve a push
// the user just refused. The one transformation allowed before comparing is
// stripping affirmative and polite filler — "Yes, do it, please" is "do it" —
// and NEGATIVE words are deliberately not in that list, so "No, do it" fails to
// match and falls through to the safe path rather than being read as consent.

import type { VoiceQuestion } from './speak-bridge';

/** The open question, as the session remembers it between frames. */
export interface PendingQuestion {
  qid: string;
  questions: readonly VoiceQuestion[];
}

/**
 * Leading words that carry no instruction: agreement and politeness.
 *
 * NOTHING NEGATIVE BELONGS IN HERE. "no", "don't", "never" and friends are the
 * difference between consent and refusal; stripping them would turn "No, do it"
 * into "do it". A negated utterance must fail to match and take the safe path.
 */
const LEADING_FILLER =
  /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|alright|all right|so|well|um|uh|please)\b[\s,.!—-]*)+/i;

/** Politeness at the end, and any punctuation at either end. */
const TRAILING_FILLER = /[\s,.!?…—-]*(?:please|thanks|thank you)?[\s,.!?…—-]*$/i;

/**
 * Fold an utterance and a label onto common ground.
 *
 * Curly apostrophes matter here and are easy to miss: the gate's negative label
 * is literally `Don’t` (U+2019), and a speech transcript will say `Don't`
 * (U+0027). Comparing those raw fails every time, silently, and the only
 * symptom is a "no" that reads as an unparseable answer instead.
 */
export function normalizeAnswer(s: string): string {
  return s
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Strip the filler an option label would never contain. */
function core(s: string): string {
  return normalizeAnswer(s).replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim();
}

/**
 * Which option did the user name, if any?
 *
 * EXACT equality after normalisation, never containment — see the header. Null
 * means "they said something else", which is a legitimate answer in its own
 * right and is never an approval.
 */
export function matchOption(spoken: string, options: readonly { label: string }[]): string | null {
  const said = core(spoken);
  if (!said) return null;
  for (const o of options) {
    if (core(o.label) === said || normalizeAnswer(o.label) === said) return o.label;
  }
  return null;
}

/**
 * The `answers` payload for `{t:'answer'}`, in the shape the server validates
 * and the gate reads: one entry per question, each carrying a single answer.
 *
 * With several questions open at once there is no way to tell aloud which one a
 * sentence was meant for, so the same answer is given to each — exactly what
 * the composer does when free text is typed against a multi-question card. In
 * practice the gate and `ask_user` both raise one.
 */
export function answersFor(
  spoken: string,
  pending: PendingQuestion,
): Array<{ question: string; answers: string[] }> {
  return pending.questions.map((q) => ({
    question: q.question,
    answers: [matchOption(spoken, q.options) ?? spoken.trim()],
  }));
}

/** One line, spoken back, so a hands-free user knows the answer landed and what
 *  it was taken to mean. */
export function describeAnswer(spoken: string, pending: PendingQuestion): string {
  const first = pending.questions[0];
  const matched = first ? matchOption(spoken, first.options) : null;
  return matched ? `Answered: ${matched}.` : `Passed that back as your answer: ${spoken.trim()}`;
}
