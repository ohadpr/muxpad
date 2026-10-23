import { Hono } from 'hono';
import {
  assignFrames,
  buildSplitPrompt,
  parseSplitReply,
  worthSplitting,
} from '../review/split.js';
import { MAX_AUDIO_BYTES, type Transcriber, meaningfulTranscript } from '../review/transcribe.js';
import { VoiceError } from '../voice/live.js';

/**
 * `/api/review` — the two stateless calls a screen review makes.
 *
 *   GET  /api/review/status      → { configured }
 *   POST /api/review/transcribe  one utterance of WAV → { text }
 *   POST /api/review/split       { text, frames } → { splits }
 *
 * THE SESSION IS NOT HERE, and that is the design. `getDisplayMedia` hands the
 * stream to the page, so the page is the only party that has pixels; shipping
 * every sampled frame to this process so it could find a cursor would cost
 * megabytes per minute to learn something the page already knows. What the page
 * decides to KEEP is uploaded through the ordinary attachments route the moment
 * it is chosen, so the durable half of a review is durable, and a dropped tab
 * truncates a review rather than losing one.
 *
 * ALWAYS MOUNTED, like voice: with no API key this answers `configured: false`
 * on GET and 503 on POST, which the UI can render as "review needs a key". A
 * 404 is indistinguishable from an old server.
 *
 * THE MONEY. Transcription bills per second of audio and the split pass burns a
 * Claude housekeeping turn. Both are per-utterance and both are bounded by
 * things the user is doing in real time (you cannot talk faster than you can
 * talk), so there is no runaway to cap here the way voice needed one — but the
 * audio ceiling below is still enforced before the body is read, because this
 * endpoint is reachable by anything that can reach the port.
 */
export function reviewRoutes(deps: {
  transcribe?: Transcriber | undefined;
  /** Install vocabulary, to bias the recognizer. The same list voice uses. */
  glossary?: (() => readonly string[]) | undefined;
}): Hono {
  const app = new Hono();

  const unconfigured = {
    error: {
      code: 'review_unconfigured' as const,
      message:
        'screen review is off: set MUXPAD_OPENAI_API_KEY (or OPENAI_API_KEY) and restart muxpad',
    },
  };

  app.get('/status', (c) => c.json({ configured: !!deps.transcribe }));

  app.post('/transcribe', async (c) => {
    const transcribe = deps.transcribe;
    if (!transcribe) return c.json(unconfigured, 503);
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES)
      return c.json(
        { error: { code: 'too_large', message: 'that is longer than one utterance' } },
        413,
      );
    let audio: File | null = null;
    try {
      const form = await c.req.formData();
      const file = form.get('audio');
      audio = file instanceof File ? file : null;
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'expected multipart audio' } }, 400);
    }
    if (!audio)
      return c.json({ error: { code: 'bad_request', message: 'audio is required' } }, 400);
    if (audio.size > MAX_AUDIO_BYTES)
      return c.json(
        { error: { code: 'too_large', message: 'that is longer than one utterance' } },
        413,
      );

    const terms = deps.glossary?.() ?? [];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const text = await transcribe(
        {
          audio,
          ...(terms.length > 0
            ? // The recognizer takes a free-text prompt, not a word list, and
              // the shape of the sentence matters: a bare comma-separated dump
              // biases it toward answering with the list. This phrasing is the
              // one voice already uses.
              { prompt: `Terms that may appear: ${terms.join(', ')}.` }
            : {}),
        },
        abort.signal,
      );
      // A clip of silence comes back as "Thank you." or "you" — stock filler a
      // Whisper-family model hallucinates on nothing. Answering empty text is
      // how the page knows to drop the note rather than put "Thank you." in
      // somebody's chat.
      return c.json({ text: meaningfulTranscript(text) ? text : '' });
    } catch (err) {
      if (err instanceof VoiceError)
        return c.json({ error: { code: err.code, message: err.message } }, err.status);
      return c.json(
        { error: { code: 'review_upstream', message: 'could not transcribe that' } },
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/split', async (c) => {
    let body: { text?: unknown; frames?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown; frames?: unknown };
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'expected a JSON body' } }, 400);
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const frames = Number.isFinite(body.frames) ? Math.max(0, Number(body.frames)) : 0;
    if (!text) return c.json({ error: { code: 'bad_request', message: 'text is required' } }, 400);

    // A short remark is one instruction. Deciding that here rather than in the
    // page keeps the policy in one place, and saves a model call on the
    // commonest utterance there is ("make this bigger").
    if (!worthSplitting(text)) return c.json({ splits: [{ text, frame: null }] });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25_000);
    let reply = '';
    try {
      const { accountCompletion } = await import('../claude-accounts/completion.js');
      const one = accountCompletion({
        prompt: buildSplitPrompt(text),
        options: {
          model: 'haiku',
          maxTurns: 1,
          settingSources: [],
          allowedTools: [],
          abortController: abort,
        },
      });
      for await (const m of one) {
        if (m.type === 'result' && m.subtype === 'success') reply = m.result;
      }
    } catch {
      // EVERY failure is "do not split", never an error to the page. An unsplit
      // note is what the spike shipped and it was useful; a review that refuses
      // to produce a note because a housekeeping model was rate-limited is not.
      reply = '';
    } finally {
      clearTimeout(timer);
    }
    return c.json({ splits: assignFrames(parseSplitReply(reply, text), frames) });
  });

  return app;
}
