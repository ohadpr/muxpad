/**
 * SCREEN REVIEW — the shapes that cross the wire.
 *
 * The feature: you share a window, talk while you point, and what comes back is
 * a queue of ADDRESSED NOTES — one instruction each, each carrying the frame
 * that was on screen when you said it. See
 * docs/plans/2026-10-22-screen-review-notes.md.
 *
 * Only two server calls exist, and both are stateless:
 *
 *   POST /api/review/transcribe   audio (one utterance) → text
 *   POST /api/review/split        text + its frames     → 1..n instructions
 *
 * The session itself lives in the PAGE, because the page is where the pixels
 * are: `getDisplayMedia` hands the stream to the page, and shipping every
 * sampled frame to a server so it can find a cursor would cost megabytes to
 * learn something the page already knows. What the page keeps is cheap to lose
 * — the frames it decides to KEEP are uploaded as ordinary attachments the
 * moment they are chosen, so a dropped tab truncates a review rather than
 * losing one.
 */

/** One instruction, with the frames that show what it is about. */
export interface ReviewNote {
  id: string;
  /** One instruction, after the split pass. Edited by nobody in v1. */
  text: string;
  /** Session-clock ms — the utterance this came from. */
  startMs: number;
  endMs: number;
  /** Attachment paths, in time order. Empty is legal (capture can fail). */
  frames: string[];
}

/** What the split pass answers with: the instruction, and WHICH of the frames
 *  it was handed belongs to it. An index out of range means "all of them",
 *  which is also what an unparseable answer degrades to. */
export interface ReviewSplit {
  text: string;
  frame: number | null;
}

export interface ReviewTranscribeResponse {
  text: string;
}

export interface ReviewSplitResponse {
  splits: ReviewSplit[];
}

/** The numbering in the composed message. Circled digits up to 20, then plain
 *  — a review with 30 notes has other problems, but it must still render. */
export function noteMark(index: number): string {
  const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  return index < 20 ? (circled[index] as string) : `${index + 1}.`;
}

/**
 * The message a review becomes.
 *
 * Deliberately the plainest thing that renders: the instruction, then its frame
 * paths one per line. muxpad's chat already interleaves text and attachment
 * paths (`splitMessageAttachments`), so this needs no new rendering anywhere —
 * and an agent reading the raw text sees numbered instructions with a picture
 * under each.
 */
export function composeReviewMessage(notes: readonly ReviewNote[]): string {
  const kept = notes.filter((n) => n.text.trim());
  if (kept.length === 0) return '';
  const head =
    kept.length === 1 ? 'From a screen review:' : `From a screen review — ${kept.length} things:`;
  const blocks = kept.map((n, i) => {
    const mark = kept.length === 1 ? '' : `${noteMark(i)} `;
    return [`${mark}${n.text.trim()}`, ...n.frames].join('\n');
  });
  return [head, ...blocks].join('\n\n');
}
