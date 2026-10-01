// RECONSTRUCTING WHAT WAS ASKED, from a stream that never says.
//
// `session.delegation.created` carries an id, a target, and an `offset_ms`.
// It does NOT carry the utterance. The only record of what the user said is
// `session.input_transcript.delta`, which arrives as bare fragments with
// `start_ms`/`end_ms` and NO item id and NO turn-completed event. So there is
// no boundary in the protocol; the boundary has to be inferred here.
//
// TWO INFERENCES, both cheap and both wrong in a knowable direction:
//
//   1. SILENCE SEGMENTS. A delta whose `start_ms` sits more than GAP_MS past
//      the previous delta's `end_ms` opens a new utterance. Too small a gap
//      chops one sentence in two (the delegation then gets a fragment); too
//      large glues a follow-up onto the request. GAP_MS is tuned toward
//      gluing, because an over-long request still contains the ask, while a
//      truncated one may have lost the verb.
//   2. OFFSET JOIN. A delegation's `offset_ms` is on the same session clock as
//      the deltas, so the utterance it refers to is the one containing that
//      offset — or, when the delegation beats the transcript (it does, often),
//      the one still open at that offset. `segmentAt` prefers containment,
//      then the nearest preceding segment, and only then the nearest
//      following one.
//
// Everything here is pure and synchronous. The WAITING — the part where you
// hold a delegation for a beat because the sentence isn't finished yet — is
// deliberately not in this file; it needs a clock, and a clock makes tests
// slow and flaky. session.ts owns the timer and re-asks this buffer once the
// transcript has gone quiet. `looksComplete` is the predicate it asks with.

import type { TranscriptChannel, TranscriptDeltaEvent } from './protocol';

/** Silence, in session-clock ms, that ends an utterance. */
export const GAP_MS = 1200;

/** One reconstructed utterance. `endMs` advances as deltas keep arriving, so
 *  an open segment is a live object in all but name — callers that need a
 *  stable value should read it at settle time, not hold it. */
export interface Utterance {
  channel: TranscriptChannel;
  text: string;
  startMs: number;
  endMs: number;
}

/** Does this read like a finished thought? Used to decide whether a
 *  delegation should be answered NOW or held for another beat of transcript.
 *  Deliberately generous about what counts as terminal punctuation — Whisper-
 *  class transcripts emit '?' and '.' reliably and little else. */
export function looksComplete(text: string): boolean {
  return /[.!?。！？]["')\]]?\s*$/.test(text.trim());
}

/** Collapse transcript whitespace without touching the words. Deltas split at
 *  arbitrary points and the concatenation picks up doubled spaces at the
 *  seams; the agent should not have to read those. */
export function normalizeUtterance(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class TranscriptBuffer {
  private readonly segs: Record<TranscriptChannel, Utterance[]> = { input: [], output: [] };
  private readonly gapMs: number;

  constructor(gapMs: number = GAP_MS) {
    this.gapMs = gapMs;
  }

  /**
   * Fold one delta in. Returns the utterance it landed in.
   *
   * Deltas that arrive out of order — or that overlap the previous one, which
   * happens when a transcriber revises — extend the open segment rather than
   * opening a new one, because a negative gap is never silence.
   */
  push(channel: TranscriptChannel, d: Pick<TranscriptDeltaEvent, 'delta' | 'start_ms' | 'end_ms'>) {
    const list = this.segs[channel];
    const open = list[list.length - 1];
    const start = Number.isFinite(d.start_ms) ? d.start_ms : (open?.endMs ?? 0);
    const end = Number.isFinite(d.end_ms) ? d.end_ms : start;
    if (open && start - open.endMs <= this.gapMs) {
      open.text += d.delta;
      // Never let a revised/overlapping delta drag the end backwards; the end
      // is what the echo gate and the offset join both key off.
      open.endMs = Math.max(open.endMs, end);
      return open;
    }
    const seg: Utterance = { channel, text: d.delta, startMs: start, endMs: Math.max(start, end) };
    list.push(seg);
    return seg;
  }

  /** All utterances on a channel, oldest first, including the open one. */
  segments(channel: TranscriptChannel): readonly Utterance[] {
    return this.segs[channel];
  }

  /** The utterance still accepting deltas, if any. */
  open(channel: TranscriptChannel): Utterance | undefined {
    const list = this.segs[channel];
    return list[list.length - 1];
  }

  /**
   * The utterance a given session-clock offset refers to.
   *
   * Containment first. Then the nearest one that ENDED before the offset —
   * the common case, where the model decided to delegate a hair after the
   * user stopped talking. Then, only if nothing precedes it, the nearest one
   * that starts after: that covers the delegation beating its own transcript,
   * which the contract warns about explicitly.
   */
  segmentAt(channel: TranscriptChannel, offsetMs: number): Utterance | undefined {
    const list = this.segs[channel];
    let before: Utterance | undefined;
    let after: Utterance | undefined;
    for (const s of list) {
      if (offsetMs >= s.startMs && offsetMs <= s.endMs) return s;
      if (s.endMs < offsetMs) {
        if (!before || s.endMs > before.endMs) before = s;
      } else if (!after || s.startMs < after.startMs) {
        after = s;
      }
    }
    return before ?? after;
  }

  /**
   * Everything said on a channel within `windowMs` before an offset, oldest
   * first. Gives the agent the couple of exchanges around the request so a
   * pronoun-laden "do that one too" still resolves.
   */
  contextBefore(channel: TranscriptChannel, offsetMs: number, windowMs: number): Utterance[] {
    return this.segs[channel].filter((s) => s.endMs <= offsetMs && s.endMs >= offsetMs - windowMs);
  }

  reset() {
    this.segs.input = [];
    this.segs.output = [];
  }
}

/** How far back to look for conversational context around a delegation. */
export const CONTEXT_WINDOW_MS = 30_000;

/**
 * Model speech that is really OUR narration coming back at us.
 *
 * The context lead exists to catch the model's half of a split request — it
 * delegates mid-sentence ("sure, let me check — ") and without that half the
 * user's half is a bare "yeah, do it". It is NOT meant to catch the progress
 * updates we feed the model ourselves.
 *
 * MEASURED, not theorised. In a live session the lead picked up was
 * `(voice — you had just said: "Still waiting, 26 seconds in. Nothing back
 * yet.")`, which then went to Claude as the context for "also check the router
 * file" — our own heartbeat, laundered through the model's voice, prepended to
 * a request the user has to read in the chat pane. These patterns match the
 * strings session.ts generates, so this is a filter on our own output rather
 * than a guess about English.
 */
const OUR_NARRATION =
  /still (working|waiting)|seconds in|no answer yet|queued (that|behind)|starting the next one|on it —|this will take a moment|the agent has been interrupted|requests? (is|are) queued/i;

/**
 * Openers that mean "this sentence does not stand on its own".
 *
 * The context lead is for the utterance that cannot be read without the
 * model's half — "yeah, do it", "that one too", "the second one". A
 * self-contained instruction does not need it and is actively harmed by it.
 */
const ANAPHORIC_OPENERS = new Set([
  'yeah',
  'yes',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'please',
  'no',
  'nope',
  'nah',
  'do',
  'go',
  'that',
  'this',
  'those',
  'these',
  'it',
  'them',
  'both',
  'either',
  'same',
  'again',
  'first',
  'second',
  'third',
  'one',
]);

/**
 * Does this utterance need the model's previous line to make sense?
 *
 * WHY THIS IS A TEST AND NOT ALWAYS-ON. Context used to be attached to every
 * request, which was fine when the model's last line was a question it had just
 * asked. It stopped being fine the moment the session started narrating
 * progress: measured live, a perfectly self-contained "also check the router
 * file for me" reached Claude as
 *
 *   (voice — you had just said: "It's still running. I don't have any results
 *   yet, but I'll tell you as soon as they're in.")
 *   Also check the router file for me
 *
 * — a progress paraphrase prepended to the request, in the chat pane, where the
 * user reads it. Note that a string filter cannot fix this: the model PARAPHRASES
 * our heartbeat in its own words, so there is nothing fixed to match on. The
 * only reliable signal is the user's own sentence.
 *
 * Biased toward INCLUDING context: a needless lead is noise, a missing one can
 * make the request unanswerable.
 */
export function needsContext(asked: string): boolean {
  const words = asked
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  if (words.length <= 5) return true;
  return ANAPHORIC_OPENERS.has(words[0] as string);
}

export interface ReconstructOpts {
  /** The delegation's `offset_ms`. */
  offsetMs: number;
  /** Include recent model speech as context. */
  withContext?: boolean;
  contextWindowMs?: number;
}

export interface Reconstructed {
  /** What to send the agent. Empty when there is nothing usable. */
  text: string;
  /** The user utterance it came from, for staleness and logging. */
  utterance: Utterance | undefined;
  /** Did the utterance read as finished, at the moment we looked? */
  complete: boolean;
}

/**
 * Turn a delegation offset into a request for the agent.
 *
 * The model's own last line is included as context when it exists, prefixed
 * so the agent can tell the two speakers apart. That matters more than it
 * looks: GPT-Live routinely delegates in the middle of its own sentence
 * ("sure, let me check — "), and without its half the user's half is often a
 * bare "yeah, do it".
 */
export function reconstructRequest(buf: TranscriptBuffer, opts: ReconstructOpts): Reconstructed {
  const utterance = buf.segmentAt('input', opts.offsetMs);
  const asked = normalizeUtterance(utterance?.text ?? '');
  if (!asked) return { text: '', utterance, complete: false };
  const complete = looksComplete(asked);
  if (!opts.withContext || !needsContext(asked)) return { text: asked, utterance, complete };

  const window = opts.contextWindowMs ?? CONTEXT_WINDOW_MS;
  const said = buf
    .contextBefore('output', utterance?.startMs ?? opts.offsetMs, window)
    .map((s) => normalizeUtterance(s.text))
    .filter(Boolean)
    // Our own progress narration is not conversational context — see above.
    .filter((s) => !OUR_NARRATION.test(s));
  const lead = said[said.length - 1];
  const text = lead ? `(voice — you had just said: "${lead}")\n\n${asked}` : asked;
  return { text, utterance, complete };
}
