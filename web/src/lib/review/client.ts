// The three calls the page makes. Thin on purpose: every decision worth
// arguing about lives either in the controller (session.ts) or on the server
// (routes/review.ts), and this file is the wire.

import type { ReviewSplit } from '@muxpad/shared';
import { ApiError, req } from '../../api';

export interface ReviewStatus {
  configured: boolean;
}

/** Is review even possible on this server? null = the endpoint is unreachable,
 *  which is different from "no key" and the UI treats it differently: the first
 *  hides the control, the second shows it with a reason. */
export async function fetchReviewStatus(): Promise<ReviewStatus | null> {
  try {
    return await req<ReviewStatus>('/api/review/status');
  } catch {
    return null;
  }
}

/** One utterance of WAV → what was said. Empty string means "nothing was
 *  said" — a clip of silence, which the server filters rather than letting
 *  "Thank you." become somebody's note. */
export async function transcribeUtterance(audio: Blob, signal?: AbortSignal): Promise<string> {
  const fd = new FormData();
  fd.append('audio', audio, 'utterance.wav');
  const res = await req<{ text: string }>('/api/review/transcribe', {
    method: 'POST',
    body: fd,
    ...(signal ? { signal } : {}),
  });
  return res.text ?? '';
}

/**
 * One remark → the instructions it contains.
 *
 * NEVER THROWS. A failed split is not a failed note: the whole remark with all
 * its frames is a perfectly good note, and that is what the spike shipped. The
 * only thing a thrown error here could achieve is losing something the user
 * said out loud.
 */
export async function splitUtterance(text: string, frames: number): Promise<ReviewSplit[]> {
  try {
    const res = await req<{ splits: ReviewSplit[] }>('/api/review/split', {
      method: 'POST',
      body: JSON.stringify({ text, frames }),
    });
    return Array.isArray(res.splits) && res.splits.length > 0
      ? res.splits
      : [{ text, frame: null }];
  } catch {
    return [{ text, frame: null }];
  }
}

/** The sentence to show when review cannot start. */
export function reviewFailureMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === 'review_unconfigured')
    return 'Screen review needs an OpenAI key on this server.';
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
    return 'Screen sharing was cancelled.';
  if (e instanceof DOMException && e.name === 'NotFoundError')
    return 'No microphone — a review is you talking, so it needs one.';
  return e instanceof Error && e.message ? e.message : 'Screen review couldn’t start.';
}
