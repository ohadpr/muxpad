import { describe, expect, it, vi } from 'vitest';
import {
  DELEGATION_POLICY,
  INTERRUPTION_POLICY,
  VOICE_MODEL,
  VoiceError,
  buildVoiceInstructions,
  openAiVoiceTransport,
  redact,
} from './live.js';

// The fetch implementation is injected in every case — this suite never
// reaches api.openai.com.

const KEY = 'sk-proj-THIS-IS-THE-SECRET-abcdef0123456789';

const jsonResponse = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('buildVoiceInstructions', () => {
  it('carries the glossary verbatim, so the model knows this install s names', () => {
    const out = buildVoiceInstructions(['muxpad', 'ptyd', 'Acme GTM', 'nimbus']);
    expect(out).toContain('muxpad, ptyd, Acme GTM, nimbus');
  });

  it('includes the documented interruption policy, word for word', () => {
    expect(buildVoiceInstructions([])).toContain(INTERRUPTION_POLICY);
    expect(INTERRUPTION_POLICY).toBe(
      'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
    );
  });

  it('degrades to "(none)" rather than an empty list on a fresh install', () => {
    expect(buildVoiceInstructions([])).toContain('(none)');
  });

  it('tells the model to say something before it goes quiet for minutes', () => {
    // There are no built-in fillers in this API. A delegation with no spoken
    // hand-off is indistinguishable, on a phone, from a dropped call.
    const out = buildVoiceInstructions([]);
    expect(out).toContain(DELEGATION_POLICY);
    expect(DELEGATION_POLICY).toMatch(/never hand off in silence/);
    expect(DELEGATION_POLICY).toMatch(/MINUTES/);
  });
});

describe('redact', () => {
  it('scrubs the key wherever it appears', () => {
    expect(redact(`error: bad key ${KEY} rejected`, KEY)).toBe(
      'error: bad key [redacted] rejected',
    );
  });
  it('leaves text alone when there is nothing to scrub', () => {
    expect(redact('plain message', KEY)).toBe('plain message');
    expect(redact('plain message', undefined)).toBe('plain message');
  });
});

describe('openAiVoiceTransport', () => {
  const capture = () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(201, {
        session: { id: 'live_abc' },
        transport: { type: 'webrtc', sdp: 'v=0 answer' },
      });
    });
    return { calls, impl: impl as unknown as typeof fetch };
  };

  it('POSTs the documented body to /live/sessions with the key as a bearer token', async () => {
    const { calls, impl } = capture();
    const t = openAiVoiceTransport(KEY, { baseUrl: 'https://api.test/v1', fetchImpl: impl });
    const answer = await t.exchange(
      {
        sdp: 'v=0 offer',
        session: {
          model: VOICE_MODEL,
          audio: { output: { voice: 'marin' } },
          instructions: 'be brief',
          delegation: { type: 'client' },
        },
      },
      new AbortController().signal,
    );
    expect(answer).toEqual({ sessionId: 'live_abc', sdp: 'v=0 answer', expiresAt: null });
    const call = calls[0];
    if (!call) throw new Error('the transport never called fetch');
    expect(call.url).toBe('https://api.test/v1/live/sessions');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      session: {
        model: 'gpt-live-1',
        audio: { output: { voice: 'marin' } },
        instructions: 'be brief',
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: 'v=0 offer' },
    });
  });

  const exchangeWith = (impl: typeof fetch) =>
    openAiVoiceTransport(KEY, { baseUrl: 'https://api.test/v1', fetchImpl: impl }).exchange(
      {
        sdp: 'v=0 offer',
        session: {
          model: VOICE_MODEL,
          audio: { output: { voice: 'marin' } },
          instructions: 'x',
          delegation: { type: 'client' },
        },
      },
      new AbortController().signal,
    );

  it('turns an upstream refusal into voice_upstream, keeping the reason', async () => {
    const impl = (async () =>
      jsonResponse(401, { error: { message: 'Incorrect API key provided' } })) as typeof fetch;
    await expect(exchangeWith(impl)).rejects.toMatchObject({
      code: 'voice_upstream',
      status: 502,
    });
    await expect(exchangeWith(impl)).rejects.toThrow(/HTTP 401/);
    await expect(exchangeWith(impl)).rejects.toThrow(/Incorrect API key/);
  });

  it('never lets the key reach the error message, even when upstream echoes it', async () => {
    // The failure mode this guards: a vendor that helpfully quotes the
    // credential it rejected, straight into a body we relay to the browser.
    const impl = (async () =>
      jsonResponse(401, { error: { message: `key ${KEY} is revoked` } })) as typeof fetch;
    const err = await exchangeWith(impl).catch((e) => e as VoiceError);
    expect(err).toBeInstanceOf(VoiceError);
    expect((err as VoiceError).message).not.toContain(KEY);
    expect((err as VoiceError).message).toContain('[redacted]');
  });

  it('keeps the key out of the message when the network itself fails', async () => {
    const impl = (async () => {
      throw new Error(`connect ECONNREFUSED (auth ${KEY})`);
    }) as typeof fetch;
    const err = await exchangeWith(impl).catch((e) => e as VoiceError);
    expect((err as VoiceError).message).not.toContain(KEY);
  });

  it('refuses a 201 that carries no session id or no answer', async () => {
    const noId = (async () =>
      jsonResponse(201, { session: {}, transport: { sdp: 'v=0' } })) as typeof fetch;
    await expect(exchangeWith(noId)).rejects.toThrow(/no id or no answer/);
    const noSdp = (async () =>
      jsonResponse(201, { session: { id: 'live_1' }, transport: {} })) as typeof fetch;
    await expect(exchangeWith(noSdp)).rejects.toThrow(/no id or no answer/);
    const notJson = (async () => jsonResponse(201, 'not json')) as typeof fetch;
    await expect(exchangeWith(notJson)).rejects.toThrow(/non-JSON/);
  });

  it('honours an upstream expiry if one ever appears, converting seconds to ms', async () => {
    const impl = (async () =>
      jsonResponse(201, {
        session: { id: 'live_abc', expires_at: 1_800_000_000 },
        transport: { sdp: 'v=0 answer' },
      })) as typeof fetch;
    await expect(exchangeWith(impl)).resolves.toMatchObject({ expiresAt: 1_800_000_000_000 });
  });

  it('closes best-effort and never throws, whatever upstream does', async () => {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      throw new Error('no such endpoint');
    }) as unknown as typeof fetch;
    const t = openAiVoiceTransport(KEY, { baseUrl: 'https://api.test/v1', fetchImpl: impl });
    await expect(t.close('live_abc', new AbortController().signal)).resolves.toBeUndefined();
    expect(calls[0]).toBe('https://api.test/v1/live/sessions/live_abc');
  });
});
