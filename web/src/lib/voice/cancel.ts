// THE ONLY KILL SWITCH, AND WHY IT IS THIS SMALL.
//
// Voice mode used to stop the agent whenever the user spoke over a running
// turn. That is wrong, and it is the bug this module exists to retire: TALKING
// IS FREE. Asking "how's it going?", thinking aloud, adding a second task —
// none of those may throw away minutes of work. Exactly one thing may, and it
// is an unambiguous instruction to abandon what is running.
//
// THE ASYMMETRY THAT SETS THE THRESHOLD. A missed cancel costs the user one
// repetition ("no — STOP"). A false cancel costs minutes of real agent work and
// writes a durable interrupted notice into the transcript. The two are not
// close, so this errs hard toward not cancelling. WHEN IN DOUBT, DO NOT CANCEL.
//
// THE RULE, stated once so it can be argued with:
//
//   A whole utterance, with conversational filler stripped from both ends, must
//   be EXACTLY one of a small closed set of cancel imperatives. Nothing else
//   cancels — not a cancel word embedded in a sentence, not a cancel word with
//   an object we don't recognise, not a long utterance that happens to start
//   with "stop".
//
// So "stop" cancels, and "stop the agent" cancels, and "stop the dev server"
// does NOT — the remainder after "stop" is "the dev server", which is not in the
// set, so the utterance reads as a TASK, which is what it is. Likewise "cancel
// the cron job" is work, not a cancel; "never mind, let's do the other thing" is
// a new task (and the agent's current turn keeps running, which is the point of
// this whole change).
//
// WHAT IS DELIBERATELY NOT IN THE SET. "drop it", "leave it", "kill it" and
// friends all read as cancels in isolation and all have a second, ordinary
// meaning in a conversation about databases, processes and branches — "should I
// drop the index?" / "drop it." is a plausible exchange, and answering it by
// killing a turn is exactly the failure this module is built to avoid.
//
// THE SAME TEST, APPLIED BACK TO THE SET ITSELF. "forget it" and "never mind
// that" were in it, and they fail it: both are ordinary dismissals of a REMARK
// ("ugh, forget it") at least as often as they are instructions to abandon
// work. They are gone. The test for removing an entry rather than merely
// doubting it is that a near-identical entry survives — "forget that" and
// "forget about it" for the first, "never mind" for the second — so the user
// who genuinely means to cancel still lands it, and the worst case is the one
// repetition this file's asymmetry says is cheap. (By that test the whole
// forget/never-mind family is arguable and only these two are clear; shrinking
// it further would leave no spoken path at all for a real intent, which is a
// different and worse failure.)
//
// ENGLISH IS NOT THE ONLY LANGUAGE ANYONE SPEAKS AT THIS THING. The set was
// English-only, and the consequence was not "a foreign cancel is ignored" —
// it was that a Spanish or Hebrew "stop" fell through to `enqueue` and was
// SENT TO CLAUDE AS WORK. The user asking for the work to stop got a new agent
// turn instead, which is the worst of the three possible outcomes. A small,
// closed set of non-English cancel imperatives is below, held to exactly the
// same standard: whole utterance, no object we don't recognise, and nothing
// with an ordinary second meaning ("déjalo", "olvídalo", "עזוב" are all the
// "drop it" class and are all excluded for the same reason "drop it" is).
//
// This file is pure and synchronous. The DEBOUNCE — the part where you wait for
// the sentence to finish before judging it, so "stop" does not fire before "the
// dev server" has arrived — lives in session.ts, because it needs a clock.

/**
 * Filler that can precede a cancel without changing its meaning. Stripped
 * repeatedly from the front, so "okay, no, wait — stop" reduces to "stop".
 *
 * ═══ THIS LIST IS WHAT MAKES THE CLOSED SET USABLE, AND IT WAS ENGLISH-ONLY ═══
 *
 * The whole-utterance rule is strict by design, so an utterance only ever
 * matches if the filler around it has been removed first. With these two lists
 * speaking English and the closed set speaking four languages, the non-English
 * half matched the BARE imperative and nothing else — and attaching a
 * politeness particle to an imperative is not an edge case in Spanish or
 * Hebrew, it is the norm. "para, por favor" and "עצור בבקשה" are how people
 * actually say it.
 *
 * So the outcome was not "a foreign cancel is ignored". It was the exact thing
 * the header says the non-English set was added to prevent: the request to stop
 * fell through to `enqueue` and was dispatched to Claude AS A NEW AGENT TURN.
 *
 * STRIPPING CANNOT CREATE A CANCEL. It only ever removes words from the ends,
 * so the worst a wrong entry can do is expose a phrase that was already in the
 * closed set. A task keeps its object, and an object is what disqualifies it.
 */
const LEAD_FILLER = new Set([
  'a',
  'ah',
  'actually',
  'alright',
  'and',
  'claude',
  'eh',
  'er',
  'hang on',
  'hey',
  'hold on',
  'hmm',
  'hm',
  'muxpad',
  'no',
  'oh',
  'ok',
  'okay',
  'please',
  'right',
  'so',
  'sorry',
  'uh',
  'um',
  'wait',
  'well',
  'yeah',
  'yo',
  // ── Spanish ────────────────────────────────────────────────────────────
  'a ver',
  'bueno',
  'espera',
  'oiga',
  'oye',
  'perdon',
  'pero',
  'vale',
  'y',
  // ── Hebrew ─────────────────────────────────────────────────────────────
  'אה',
  'אוקי',
  'אוקיי',
  'אז',
  'בסדר',
  'היי',
  'טוב',
  'לא',
  'סליחה',
  'רגע',
]);

/** Politeness that can follow a cancel without changing its meaning. */
const TRAIL_FILLER = new Set([
  'for now',
  'for me',
  'ok',
  'okay',
  'please',
  'right now',
  'thanks',
  'thank you',
  'yeah',
  // ── Spanish. "ya" is the one that matters: "basta ya" and "para ya" are
  //    the ordinary spoken forms, and neither reached the set without it.
  'ahora',
  'ahora mismo',
  'gracias',
  'por favor',
  'porfavor',
  'ya',
  // ── Hebrew ─────────────────────────────────────────────────────────────
  'בבקשה',
  'עכשיו',
  'תודה',
]);

/**
 * The closed set. Every entry means "abandon the work that is running" and
 * nothing else in any context a coding cockpit produces.
 *
 * Adding to this list is a decision to risk killing minutes of work on a
 * homonym. Read the header before you do.
 */
const CANCEL_PHRASES = new Set([
  'stop',
  'stop it',
  'stop that',
  'stop this',
  'stop there',
  'stop it there',
  'stop the agent',
  'stop the turn',
  'stop working',
  'stop working on it',
  'stop working on that',
  'stop what youre doing',
  'stop what you are doing',
  'cancel',
  'cancel it',
  'cancel that',
  'cancel this',
  'cancel the task',
  'cancel the request',
  'cancel that request',
  'abort',
  'abort it',
  'abort that',
  'abort the task',
  'never mind',
  'nevermind',
  'never mind it',
  'forget that',
  'forget about it',
  'forget about that',
  'scratch that',
  'abandon it',
  'abandon that',
  // ── Not English. See the header. ────────────────────────────────────────
  //
  // Held to the same rule, which is what keeps them safe: a WHOLE utterance,
  // and only forms whose bare use in a working session is unambiguous. A
  // Spanish "para" as an entire sentence is "stop"; embedded in one it is the
  // preposition, and an embedded match cannot happen here by construction.
  // Nothing from the "leave it / drop it" class in any language.
  //
  // Hebrew — stop / stop it / that's enough / cancel.
  'עצור',
  'תעצור',
  'עצור את זה',
  // The colloquial forms of the two above. `עצור את זה` was in the set and its
  // far more common spoken variant `תעצור את זה` was not, which is the same
  // "we listed the textbook form" gap the filler lists had.
  'תעצור את זה',
  'תפסיק את זה',
  'תפסיק',
  'די',
  'מספיק',
  'בטל',
  'תבטל',
  // Spanish — stop / that's enough / cancel it / stop yourself.
  'para',
  'basta',
  'cancela',
  'detente',
]);

/**
 * A hard ceiling on how long an utterance may be and still be read as a bare
 * cancel. The closed set already bounds this; the cap is a second, dumber belt
 * so that a transcript that glues a cancel onto the next sentence (the gap
 * heuristic in transcript.ts errs toward gluing, on purpose) cannot squeak
 * through some future looser phrase.
 */
const MAX_WORDS = 6;

/**
 * Lowercase, fold accents, de-curl, strip punctuation, collapse whitespace.
 *
 * LETTERS, NOT ASCII. This used to strip everything outside `[a-z0-9]`, which
 * deleted every Hebrew, Cyrillic, Greek and CJK character in the utterance —
 * so a Hebrew sentence normalised to the empty string and every question about
 * it was answered "no" by accident rather than on the evidence. Accents are
 * folded (NFD, then drop the combining marks) so "detente" and "deténte" are
 * the same utterance, which is the same courtesy the apostrophe rule extends
 * to contractions.
 */
function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      // Combining marks only — the base letters survive, so this folds accents
      // and Hebrew niqqud without touching the words.
      .replace(/\p{M}+/gu, '')
      // Apostrophes are DELETED, not spaced: "you're" must become "youre", not
      // "you re", or the closed-set match below never fires on a contraction.
      .replace(/['’‘`´]/g, '')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Drop leading filler words, longest-phrase-first, until nothing matches. */
function stripLead(words: string[]): string[] {
  let out = words;
  for (;;) {
    if (out.length === 0) return out;
    const two = out.length >= 2 ? `${out[0]} ${out[1]}` : null;
    if (two && LEAD_FILLER.has(two)) {
      out = out.slice(2);
      continue;
    }
    const one = out[0] as string;
    if (LEAD_FILLER.has(one)) {
      out = out.slice(1);
      continue;
    }
    return out;
  }
}

/** Drop trailing politeness, longest-phrase-first, until nothing matches. */
function stripTrail(words: string[]): string[] {
  let out = words;
  for (;;) {
    if (out.length === 0) return out;
    const two = out.length >= 2 ? `${out[out.length - 2]} ${out[out.length - 1]}` : null;
    if (two && TRAIL_FILLER.has(two)) {
      out = out.slice(0, -2);
      continue;
    }
    const one = out[out.length - 1] as string;
    if (TRAIL_FILLER.has(one)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/**
 * Is this utterance, taken WHOLE, an instruction to abandon the running work?
 *
 * The caller must only ask this about an utterance that has finished arriving
 * (see session.ts's cancel probe) and that cleared the echo gate. Both of those
 * are load-bearing: judging a half-transcribed "stop the dev server" cancels on
 * the word "stop", and judging the model's own echo cancels on the model's own
 * voice.
 */
export function isExplicitCancel(text: string): boolean {
  const norm = normalize(text);
  if (!norm) return false;
  const words = norm.split(' ');
  if (words.length > MAX_WORDS) return false;
  const core = stripTrail(stripLead(words));
  if (core.length === 0) return false;
  return CANCEL_PHRASES.has(core.join(' '));
}

/**
 * WHAT TO DO WITH A REQUEST THAT ARRIVES WHILE THE AGENT IS BUSY.
 *
 * This has a name in two mature systems and the same shape in both: LangGraph
 * calls it `multitask_strategy` (`enqueue | reject | interrupt | rollback`),
 * RxJS calls it the flattening operator (`concatMap | exhaustMap | switchMap |
 * mergeMap`). The important part is not the vocabulary, it is that BOTH treat
 * it as a PER-ARRIVAL decision rather than a global constant — and that both,
 * having chosen a default, chose enqueue.
 *
 * muxpad shipped a hardcoded global `switchMap`: every arrival interrupted the
 * last. That is the bug. The default here is ENQUEUE, and interrupting is a
 * decision made about one specific utterance, on the evidence of that utterance
 * alone.
 *
 * The options NOT offered, and why:
 *   reject   — refusing to hear a second thing while the agent works is the
 *              behaviour of a system that is busy, and this one is not; the
 *              server queue makes enqueue free.
 *   rollback — undoing an agent's committed side effects is not something we
 *              can honestly offer, so we do not offer it.
 *   merge    — running two agent turns at once in one pane is not ours to
 *              choose: the server runs one turn per pane, deliberately.
 */
export type ArrivalPolicy =
  /** Queue behind whatever is running. The default, and the right answer for
   *  anything that is a task. */
  | 'enqueue'
  /** Abandon what is running. Reserved for an utterance that IS a cancel and
   *  nothing else, because it throws away minutes of the user's work. */
  | 'interrupt';

/**
 * The policy for one arriving utterance.
 *
 * Note what is NOT consulted: whether the agent is busy, how long it has been
 * working, how many tasks are queued. A cancel is a cancel and a task is a
 * task; making the classification depend on system state is how you get a
 * sentence that means one thing at 10 seconds and another at 90.
 */
export function arrivalPolicyFor(utterance: string): ArrivalPolicy {
  return isExplicitCancel(utterance) ? 'interrupt' : 'enqueue';
}

/** Exposed for tests and for anyone auditing what can kill a turn. */
export const CANCEL_VOCABULARY: readonly string[] = [...CANCEL_PHRASES].sort();
