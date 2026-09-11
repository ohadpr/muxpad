import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import {
  VoiceUnavailableError,
  createVoiceSession,
  endVoiceSession,
  fetchVoiceStatus,
  minutesRemaining,
  refusalMessage,
  refusalOf,
} from './client';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Await a call that MUST be refused, and hand back the refusal. Fails loudly
 *  if it resolves — a test that silently passes because voice started when it
 *  shouldn't have is worse than no test. */
async function refused(p: Promise<unknown>): Promise<VoiceUnavailableError> {
  try {
    await p;
  } catch (e) {
    return e as VoiceUnavailableError;
  }
  throw new Error('expected the session to be refused, but it succeeded');
}

describe('refusalOf — the envelope code wins, the status is the fallback', () => {
  it('maps each documented code', () => {
    expect(refusalOf(new ApiError('x', 503, 'voice_unconfigured'))).toBe('unconfigured');
    expect(refusalOf(new ApiError('x', 429, 'voice_budget'))).toBe('budget');
    expect(refusalOf(new ApiError('x', 409, 'voice_busy'))).toBe('busy');
  });

  it('falls back to the status when the envelope carries no code', () => {
    expect(refusalOf(new ApiError('x', 503, null))).toBe('unconfigured');
    expect(refusalOf(new ApiError('x', 429, null))).toBe('budget');
    expect(refusalOf(new ApiError('x', 409, null))).toBe('busy');
  });

  it('prefers the code over a disagreeing status rather than landing on unknown', () => {
    expect(refusalOf(new ApiError('x', 500, 'voice_unconfigured'))).toBe('unconfigured');
  });

  it('is unknown for anything else', () => {
    expect(refusalOf(new ApiError('boom', 500, null))).toBe('unknown');
    expect(refusalOf(new Error('network'))).toBe('unknown');
    expect(refusalOf(null)).toBe('unknown');
  });
});

describe('refusalMessage — the only words the user reads when voice won’t start', () => {
  it('says what is wrong and implies what to do', () => {
    expect(refusalMessage('unconfigured')).toMatch(/no OpenAI key/i);
    expect(refusalMessage('budget')).toMatch(/cap/i);
    expect(refusalMessage('busy')).toMatch(/already running/i);
  });

  it('uses the server’s sentence for an unknown refusal, when there is one', () => {
    expect(refusalMessage('unknown', 'the daemon exploded')).toBe('the daemon exploded');
    expect(refusalMessage('unknown', '   ')).toBe('Voice couldn’t start.');
    expect(refusalMessage('unknown')).toBe('Voice couldn’t start.');
  });
});

describe('createVoiceSession', () => {
  it('returns the answer SDP on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          sessionId: 's1',
          sdp: 'v=0...',
          expiresAt: 123,
          voice: 'marin',
        }),
      ),
    );
    const a = await createVoiceSession('pane-1', 'offer-sdp');
    expect(a.sessionId).toBe('s1');
    expect(a.sdp).toBe('v=0...');
  });

  it('posts the pane id and the offer', async () => {
    const f = vi.fn(async () =>
      jsonResponse(200, { sessionId: 's1', sdp: 'x', expiresAt: 0, voice: 'v' }),
    );
    vi.stubGlobal('fetch', f);
    await createVoiceSession('pane-7', 'OFFER');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ paneId: 'pane-7', sdp: 'OFFER' });
  });

  // THE PATH THAT EXISTS ON A MACHINE WITH NO KEY, and therefore the one that
  // is actually provable here.
  it('turns a 503 into an unconfigured refusal with a human sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(503, {
          error: { code: 'voice_unconfigured', message: 'no key' },
        }),
      ),
    );
    await expect(createVoiceSession('p', 'sdp')).rejects.toBeInstanceOf(VoiceUnavailableError);
    const err = await refused(createVoiceSession('p', 'sdp'));
    expect(err.refusal).toBe('unconfigured');
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/no OpenAI key/i);
  });

  it('turns a 429 into a budget refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(429, { error: { code: 'voice_budget', message: 'capped' } })),
    );
    const err = await refused(createVoiceSession('p', 'sdp'));
    expect(err.refusal).toBe('budget');
  });

  it('turns a 409 into a busy refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(409, { error: { code: 'voice_busy', message: 'in use' } })),
    );
    const err = await refused(createVoiceSession('p', 'sdp'));
    expect(err.refusal).toBe('busy');
  });

  it('survives a route that does not exist yet (404) without pretending it is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    const err = await refused(createVoiceSession('p', 'sdp'));
    expect(err).toBeInstanceOf(VoiceUnavailableError);
    expect(err.refusal).toBe('unknown');
  });
});

describe('endVoiceSession is best-effort by design', () => {
  it('never throws, whatever the server says', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(endVoiceSession('s1')).resolves.toBeUndefined();
  });

  it('never throws when the network is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(endVoiceSession('s1')).resolves.toBeUndefined();
  });

  it('escapes the id into the path', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    await endVoiceSession('a b/c');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/voice/session/a%20b%2Fc');
  });
});

describe('fetchVoiceStatus', () => {
  it('returns the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, { configured: true, live: false, minutesToday: 4, capMinutes: 60 }),
      ),
    );
    expect(await fetchVoiceStatus()).toEqual({
      configured: true,
      live: false,
      minutesToday: 4,
      capMinutes: 60,
    });
  });

  it('returns NULL — not a fake unconfigured — when the endpoint is unreachable', async () => {
    // The distinction matters: unreachable must not disable the control, or a
    // hiccup on one route makes voice permanently unusable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    expect(await fetchVoiceStatus()).toBeNull();
  });
});

describe('minutesRemaining', () => {
  it('is null when there is no status yet — "we don’t know", not "unlimited"', () => {
    expect(minutesRemaining(null)).toBeNull();
  });

  it('is null rather than NaN if a server ever omits the cap', () => {
    expect(
      minutesRemaining({
        configured: true,
        live: false,
        minutesToday: 5,
      } as unknown as Parameters<typeof minutesRemaining>[0]),
    ).toBeNull();
  });

  it('reports zero left for an unconfigured install, which reports a zero cap', () => {
    expect(
      minutesRemaining({ configured: false, live: false, minutesToday: 0, capMinutes: 0 }),
    ).toBe(0);
  });

  it('counts down', () => {
    expect(
      minutesRemaining({ configured: true, live: false, minutesToday: 12, capMinutes: 60 }),
    ).toBe(48);
  });

  it('clamps at zero rather than showing a negative budget', () => {
    expect(
      minutesRemaining({ configured: true, live: false, minutesToday: 90, capMinutes: 60 }),
    ).toBe(0);
  });
});
