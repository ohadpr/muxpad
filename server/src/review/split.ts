/**
 * ONE BREATH, SEVERAL INSTRUCTIONS.
 *
 * The measured example, from the spike's successful run — one utterance, twelve
 * seconds, no pause anywhere in it:
 *
 *   "this video should be smaller this button make it Pink and these two
 *    buttons combine them together with little icons and the thyroid script
 *    should be full with"
 *
 * That is four instructions about four different things, and an agent handed it
 * whole does the first one. So after the audio has been cut on silence
 * (web/src/lib/review/segment.ts) there is still a split to do — not because the
 * segmentation is weak, but because people say three things in one breath.
 *
 * ─── Why this pass does not get the images ─────────────────────────────────
 *
 * The plan's §3.1.4 noted that a model looking at the frame can repair a
 * mishearing ("thyroid script" → "diarized transcript"). True — but the thing
 * that READS the note is a coding agent that receives the text AND the picture,
 * so the repair happens anyway, at the place where it matters, for free. Paying
 * image tokens here to fix a word that the next reader fixes itself buys
 * nothing, so v1 splits on text alone and stays cheap enough to run on every
 * utterance.
 *
 * ─── The failure mode to design against is INVENTION ───────────────────────
 *
 * A model asked to "split this into instructions" will happily tidy, expand or
 * explain. Every one of those is worse than not splitting: the user reviews the
 * note list before it is sent (the panel), and a tidied instruction reads
 * plausible, so it is the one kind of error that survives review. Hence
 * `parseSplitReply` is a suspicious parser — it drops anything that does not
 * look like a piece of what went in, and on any doubt returns the utterance
 * unsplit, which is always safe.
 */

import type { ReviewSplit } from '@muxpad/shared';

/** Under this many words there is nothing to split — one remark, one note. Saves
 *  a model call on the common case ("make this bigger"). */
export const MIN_WORDS_TO_SPLIT = 8;

/** More instructions than this out of one breath is the model inventing. */
export const MAX_SPLITS = 8;

/** A split longer than its input cannot be a piece of it. */
export const MAX_SPLIT_CHARS = 400;

export const SPLIT_INSTRUCTIONS = [
  'You are splitting ONE spoken remark into the separate instructions it contains.',
  'The speaker was pointing at things on their screen while talking, so a single',
  'breath often holds several unrelated asks.',
  '',
  'Rules:',
  '- Output one instruction per line. No numbering, no bullets, no commentary.',
  '- Use the speaker’s OWN WORDS. Do not tidy, expand, explain or merge.',
  '- Keep the original order. Every word of the input belongs to exactly one line.',
  '- Drop filler that is not an instruction ("okay", "so", "um", "let me see").',
  '- If the remark is a single instruction, output it unchanged on one line.',
  '- Speech-to-text errors stay as they are. Someone else repairs those.',
].join('\n');

export function buildSplitPrompt(text: string): string {
  return [SPLIT_INSTRUCTIONS, '', 'The remark:', text.trim()].join('\n');
}

/** Normalise one candidate line: strip the numbering and bullets a model adds
 *  even when told not to, and the quotes it wraps things in. */
function cleanLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*•]|\d+[.)]|[①-⑳])\s*/, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

/** Words shared with the input, as a fraction of the candidate's own words. A
 *  line the model wrote rather than heard scores low. */
function overlap(candidate: string, source: string): number {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const src = new Set(words(source));
  const cand = words(candidate);
  if (cand.length === 0) return 0;
  let hit = 0;
  for (const w of cand) if (src.has(w)) hit++;
  return hit / cand.length;
}

/** Below this, the line is the model's prose, not the user's instruction. */
export const MIN_OVERLAP = 0.7;

/**
 * Read the reply. Every doubt resolves to "one note, unsplit".
 *
 * That default is not timidity: an unsplit note is exactly what the spike
 * produced, and it was still useful — the agent got the whole remark with the
 * right frames. A WRONG split, by contrast, hands an agent half a sentence as
 * if it were the whole ask.
 */
export function parseSplitReply(reply: string, source: string): ReviewSplit[] {
  const whole: ReviewSplit[] = [{ text: source.trim(), frame: null }];
  const lines = reply
    .split('\n')
    .map(cleanLine)
    .filter((l) => l.length > 0)
    // A model that explains itself does it in a sentence ABOUT THE TASK —
    // and the patterns have to be narrow, because "these two buttons" is an
    // instruction and an early version of this filter ate it.
    .filter(
      (l) =>
        !/^(here (are|is)|these are the|i (found|have|split|see)|the (remark|instructions?|speaker) )/i.test(
          l,
        ),
    );
  if (lines.length === 0 || lines.length > MAX_SPLITS) return whole;
  if (lines.some((l) => l.length > MAX_SPLIT_CHARS)) return whole;
  if (lines.some((l) => overlap(l, source) < MIN_OVERLAP)) return whole;
  return lines.map((text) => ({ text, frame: null }));
}

/** Is this remark even worth a model call? */
export function worthSplitting(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS_TO_SPLIT;
}

/**
 * Give each instruction a frame.
 *
 * PROPORTIONAL BY POSITION IN THE SPOKEN REMARK, because that is what the clock
 * says: the third of four things you mentioned was on screen about three
 * quarters of the way through the sentence. Frames arrive in time order and are
 * all from inside this utterance's span, so the arithmetic is the whole
 * algorithm — no model, no timestamps per word, nothing to get subtly wrong.
 *
 * A single instruction keeps ALL the frames (`frame: null`), which is right: the
 * note is about the whole span, and the agent should see everything that was on
 * screen while it was being said.
 */
export function assignFrames(splits: readonly ReviewSplit[], frameCount: number): ReviewSplit[] {
  if (splits.length <= 1 || frameCount <= 1)
    return splits.map((s) => ({ text: s.text, frame: null }));
  const lengths = splits.map((s) => Math.max(1, s.text.length));
  const total = lengths.reduce((a, b) => a + b, 0);
  let seen = 0;
  return splits.map((s, i) => {
    const mid = seen + (lengths[i] as number) / 2;
    seen += lengths[i] as number;
    const at = Math.round((mid / total) * (frameCount - 1));
    return { text: s.text, frame: Math.max(0, Math.min(frameCount - 1, at)) };
  });
}
