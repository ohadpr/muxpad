import { describe, expect, it, vi } from 'vitest';
import { MAX_AUDIO_BYTES, type Transcriber, openAiTranscriber } from '../review/transcribe.js';
import { reviewRoutes } from './review.js';

// No test here reaches OpenAI: the transcriber is the seam, and the split pass
// is exercised through its own pure parser (review/split.test.ts). The ONE
// thing this suite must not do is import the Claude SDK, so no case takes the
// /split path that calls a model — `worthSplitting` short-circuits the short
// remark, which is the behaviour worth asserting anyway.

const KEY = 'sk-proj-THIS-IS-THE-SECRET-abcdef0123456789';

function wav(bytes = 2048): File {
  return new File([new Uint8Array(bytes)], 'utterance.wav', { type: 'audio/wav' });
}

async function post(
  app: ReturnType<typeof reviewRoutes>,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return app.fetch(new Request(`http://local${path}`, { method: 'POST', ...init }));
}

function audioForm(file: File = wav()): FormData {
  const fd = new FormData();
  fd.append('audio', file);
  return fd;
}

describe('/api/review with no key', () => {
  const app = reviewRoutes({});

  it('says it is off rather than 404ing — an old server and an unconfigured one must differ', async () => {
    const res = await app.fetch(new Request('http://local/status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  it('refuses a transcription with a sentence that says what to do', async () => {
    const res = await post(app, '/transcribe', { body: audioForm() });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('review_unconfigured');
    expect(body.error.message).toContain('MUXPAD_OPENAI_API_KEY');
  });
});

describe('/api/review/transcribe', () => {
  const app = (transcribe: Transcriber, glossary?: () => readonly string[]) =>
    reviewRoutes({ transcribe, ...(glossary ? { glossary } : {}) });

  it('hands back what the recognizer heard', async () => {
    const res = await post(
      app(async () => 'this button make it pink'),
      '/transcribe',
      {
        body: audioForm(),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'this button make it pink' });
  });

  it('passes the install vocabulary to the recognizer', async () => {
    const seen: string[] = [];
    const t: Transcriber = async (req) => {
      seen.push(req.prompt ?? '');
      return 'ok';
    };
    await post(
      app(t, () => ['muxpad', 'ptyd']),
      '/transcribe',
      { body: audioForm() },
    );
    expect(seen[0]).toContain('muxpad');
    expect(seen[0]).toContain('ptyd');
  });

  it('answers EMPTY for a clip of silence instead of "Thank you."', async () => {
    // Whisper-family models hallucinate stock filler on silence, and every one
    // of those would otherwise become a note in somebody's chat.
    const res = await post(
      app(async () => 'Thank you.'),
      '/transcribe',
      { body: audioForm() },
    );
    expect(await res.json()).toEqual({ text: '' });
  });

  it('refuses more audio than one utterance could be', async () => {
    // A REAL oversized body, because the per-file check reads the size of the
    // File the multipart parser rebuilt — a patched `size` on the one we sent
    // does not survive the round trip, which is how a previous version of this
    // test passed while the ceiling did nothing.
    const big = new File([new Uint8Array(MAX_AUDIO_BYTES + 1)], 'u.wav', { type: 'audio/wav' });
    const res = await post(
      app(async () => 'x'),
      '/transcribe',
      { body: audioForm(big) },
    );
    expect(res.status).toBe(413);
  });

  it('refuses a body with no audio in it', async () => {
    const res = await post(
      app(async () => 'x'),
      '/transcribe',
      { body: new FormData() },
    );
    expect(res.status).toBe(400);
  });

  it('turns an upstream refusal into its own status, not a 500', async () => {
    const { VoiceError } = await import('../voice/live.js');
    const res = await post(
      app(async () => {
        throw new VoiceError('voice_upstream', 'OpenAI refused the transcription (HTTP 401)');
      }),
      '/transcribe',
      { body: audioForm() },
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: { message: string } }).toMatchObject({
      error: { message: expect.stringContaining('401') },
    });
  });
});

describe('/api/review/split', () => {
  const app = reviewRoutes({ transcribe: async () => '' });

  it('does not call a model for a one-instruction remark', async () => {
    // If this ever reaches the model path the test fails by timing out or by
    // importing the SDK — both of which are the signal we want.
    const res = await post(app, '/split', {
      body: JSON.stringify({ text: 'make this bigger', frames: 2 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await res.json()).toEqual({ splits: [{ text: 'make this bigger', frame: null }] });
  });

  it('refuses an empty ask', async () => {
    const res = await post(app, '/split', {
      body: JSON.stringify({ text: '   ' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await post(app, '/split', { body: 'not json' });
    expect(res.status).toBe(400);
  });
});

describe('openAiTranscriber', () => {
  it('sends the clip as multipart and reads the text back', async () => {
    let seen: { url: string; model: string; prompt: string | null } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = {
        url,
        model: String(form.get('model')),
        prompt: form.get('prompt') === null ? null : String(form.get('prompt')),
      };
      return new Response(JSON.stringify({ text: ' make this pink ' }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = openAiTranscriber(KEY, { fetchImpl, baseUrl: 'https://api.test/v1' });
    const text = await t({ audio: wav(), prompt: 'Terms: muxpad.' }, new AbortController().signal);
    expect(text).toBe('make this pink');
    expect(seen).toMatchObject({
      url: 'https://api.test/v1/audio/transcriptions',
      prompt: 'Terms: muxpad.',
    });
  });

  it('NEVER puts the key in the error it reports', async () => {
    const fetchImpl = (async () =>
      new Response(`bad key: ${KEY}`, { status: 401 })) as unknown as typeof fetch;
    const t = openAiTranscriber(KEY, { fetchImpl });
    await expect(t({ audio: wav() }, new AbortController().signal)).rejects.toThrow(/redacted/);
  });

  it('reports an unreachable network as an upstream failure, not a crash', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.openai.com');
    }) as unknown as typeof fetch;
    const t = openAiTranscriber(KEY, { fetchImpl });
    await expect(t({ audio: wav() }, new AbortController().signal)).rejects.toThrow(/ENOTFOUND/);
  });

  it('refuses a non-JSON answer rather than inventing a transcript', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502</html>', { status: 200 })) as unknown as typeof fetch;
    const t = openAiTranscriber(KEY, { fetchImpl });
    await expect(t({ audio: wav() }, new AbortController().signal)).rejects.toThrow(/non-JSON/);
  });
});
