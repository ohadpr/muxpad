// FITTING TEXT INTO A 500-TOKEN APPEND, WITHOUT LOSING ANY OF IT.
//
// Both append verbs cap at 500 tokens. An agent's reply routinely exceeds
// that, and multiple appends per delegation are explicitly supported — so the
// answer is to SPLIT, never to truncate. Truncating a reply mid-sentence and
// speaking the stump is the worst available outcome: it sounds like an answer
// and isn't one.
//
// THE COUNT IS AN ESTIMATE, AND IT ERRS HIGH ON PURPOSE. There is no tokenizer
// in this bundle and shipping one to count a handful of sentences would be
// absurd. `estimateTokens` therefore models BPE's actual failure mode rather
// than the comfortable "4 chars per token" average: punctuation and symbols
// are their own tokens, and a long word costs a token per ~4 characters.
// Overestimating costs an extra append boundary. Underestimating costs a
// rejected event and a silent agent, so the asymmetry decides the tuning.
//
// SPLITS PREFER MEANING: sentence boundary, then word boundary, then — only
// for a single unbroken run that is itself over the cap, which in practice
// means a URL or a base64 smear — a measured character cut. The model
// paraphrases whatever it is handed, so a clean sentence boundary is the
// difference between narration and word salad.

import { APPEND_TOKEN_CAP } from './protocol';

/**
 * A conservative token count.
 *
 * Word-ish runs cost ceil(len/4), which is right for short words (1) and
 * pessimistic for long ones. Every other non-space character costs 1, which is
 * how BPE really treats punctuation runs, emoji, and CJK. Whitespace is free —
 * it merges into its neighbour in every tokenizer worth the name.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/([A-Za-z0-9'’]+)|(\s+)|([^\sA-Za-z0-9'’])/g)) {
    if (m[1]) n += Math.ceil(m[1].length / 4);
    else if (m[3]) n += 1;
  }
  return n;
}

/** Sentence-ish pieces, each keeping its trailing punctuation and whitespace
 *  so that rejoining them is lossless. */
function sentences(text: string): string[] {
  return (text.match(/[^.!?。！？\n]*(?:[.!?。！？]+["')\]]?\s*|\n+|$)/g) ?? []).filter(Boolean);
}

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/**
 * Last resort: cut an unbreakable run into pieces that each MEASURE under the
 * cap. It re-measures rather than assuming a chars-per-token ratio, because
 * the runs that reach this function are exactly the ones the ratio is wrong
 * about — a 2000-character line of punctuation is 2000 tokens, not 500.
 *
 * Grows each slice by halving steps: coarse jumps while they still fit, then
 * finer ones, so a long input costs O(log n) measurements per piece instead of
 * one per character.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let step = Math.max(1, maxTokens * 4);
    while (step >= 1) {
      while (
        end + step <= text.length &&
        estimateTokens(text.slice(start, end + step)) <= maxTokens
      ) {
        end += step;
      }
      step = Math.floor(step / 2);
    }
    // A single character over the cap is not possible with this estimator, but
    // a zero-width advance would spin forever, so refuse to make no progress.
    if (end === start) end = start + 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * Split text into appends that each fit the cap.
 *
 * Nothing is dropped: concatenating the results (with a space between, since
 * each piece is trimmed) reproduces the input's words in order. An empty or
 * whitespace-only input yields NO appends rather than one empty one — sending
 * an empty append burns a round trip to say nothing.
 */
export function chunkForAppend(text: string, maxTokens: number = APPEND_TOKEN_CAP): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= maxTokens) return [trimmed];

  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };
  /** `piece` is already known to fit on its own. */
  const add = (piece: string) => {
    if (buf && estimateTokens(buf + piece) > maxTokens) flush();
    buf += piece;
  };

  for (const s of sentences(trimmed)) {
    if (estimateTokens(s) <= maxTokens) {
      add(s);
      continue;
    }
    for (const w of words(s)) {
      if (estimateTokens(w) <= maxTokens) {
        add(w);
        continue;
      }
      for (const h of hardSplit(w, maxTokens)) add(h);
    }
  }
  flush();
  return out;
}
