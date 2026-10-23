/**
 * ONE UTTERANCE OF AUDIO → ONE LINE OF TEXT.
 *
 * ─── Why this is a batch call and not the live voice session ───────────────
 *
 * The plan said to reuse the voice stack (§5.2), and the voice stack is a
 * conversational GPT-Live session: it SPEAKS BACK, it holds muxpad's one-session
 * lock, and it bills against the voice minute cap. Every one of those is wrong
 * for a review. You are talking to your screen, not to a model, and the worst
 * possible behaviour during a review is a voice in your ear answering the
 * instructions you are dictating for somebody else.
 *
 * What the plan was really right about is the SEGMENTATION — and that turned out
 * not to need the live session either. The page cuts on silence (segment.ts), so
 * what arrives here is already one utterance with measured start and end times.
 * A clip is exactly what the cheap batch transcription endpoints are for: no
 * SDP, no peer connection, no lock, no minute cap, no model with opinions.
 *
 * The one thing we give up is the live partial transcript. Notes land a second
 * or two after each sentence instead of as the words appear, which is invisible
 * in a workflow whose next step is "read the list and press send".
 *
 * THE KEY. Same key as voice, read at one call site and closed over — never put
 * on a config object, never logged. Upstream error text passes through
 * `redact` before it can reach a response body.
 */

import { VoiceError, redact } from '../voice/live.js';

/**
 * The transcription model. Chosen over `whisper-1` for accuracy at a lower
 * price; both accept a `prompt`, which is where the install's glossary goes so
 * "muxpad" does not come back as "Max pad".
 *
 * Overridable because a model name is the one thing in this file that can go
 * stale without any code being wrong.
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

export function transcribeModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUXPAD_REVIEW_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
}

/** An utterance is seconds of 16 kHz mono WAV — 32 KB/s, so a minute is 2 MB.
 *  Anything past this is not an utterance and we refuse before reading it. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface TranscribeRequest {
  audio: Blob;
  /** Names this install uses, to bias the recognizer. Same list voice gets. */
  prompt?: string;
}

/** The seam the network sits behind, so no test can reach OpenAI and the key
 *  exists in exactly one closure. */
export type Transcriber = (req: TranscribeRequest, signal: AbortSignal) => Promise<string>;

export const TRANSCRIBE_TIMEOUT_MS = 30_000;

export function openAiTranscriber(
  apiKey: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch; model?: string } = {},
): Transcriber {
  const base = opts.baseUrl ?? 'https://api.openai.com/v1';
  const doFetch = opts.fetchImpl ?? fetch;
  const model = opts.model ?? transcribeModel();

  return async (req, signal) => {
    const form = new FormData();
    form.append('file', req.audio, 'utterance.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    // The glossary. A recognizer with no vocabulary renders this user's world
    // as ordinary English — "crown schedule", "Max pad" — and a note about the
    // wrong noun is a note the agent cannot act on.
    if (req.prompt) form.append('prompt', req.prompt);

    let res: Response;
    try {
      res = await doFetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
    } catch (err) {
      throw new VoiceError(
        'voice_upstream',
        redact(err instanceof Error ? err.message : String(err), apiKey),
      );
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = redact(raw, apiKey).slice(0, 400).trim();
      throw new VoiceError(
        'voice_upstream',
        `OpenAI refused the transcription (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    let body: { text?: unknown };
    try {
      body = JSON.parse(raw) as { text?: unknown };
    } catch {
      throw new VoiceError('voice_upstream', 'OpenAI returned a non-JSON transcription');
    }
    return typeof body.text === 'string' ? body.text.trim() : '';
  };
}

/**
 * Noise that a recognizer hands back for a clip containing no speech.
 *
 * These are not hypothetical: a silent or near-silent clip reliably comes back
 * as one of a small set of stock phrases (Whisper-family models hallucinate
 * their training set's filler on silence), and every one of them would become a
 * note in somebody's chat. The page already drops clips too short to be speech;
 * this is the other end of the same filter.
 */
const EMPTY_TRANSCRIPT = [
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'okay',
  'ok',
  'uh',
  'um',
  'hmm',
  'mm',
  'yeah',
  '[blank_audio]',
  '[silence]',
  '[music]',
  'subtitles by the amara.org community',
];

/** Is this transcription worth making a note out of? */
export function meaningfulTranscript(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,…]+$/g, '')
    .trim();
  if (t.length < 2) return false;
  return !EMPTY_TRANSCRIPT.includes(t);
}
