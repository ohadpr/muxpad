/**
 * The OpenAI Live (GPT-Live-1) wire: one SDP offer → answer exchange, the
 * instructions we prime the model with, and the errors the route turns into
 * status codes.
 *
 * WHERE THE SERVER SITS. Audio never touches this process. The browser makes
 * the RTCPeerConnection, the browser talks to OpenAI, and the media is peer to
 * peer. muxpad is in the path for exactly one round trip: the browser POSTs its
 * SDP offer here, we forward it to `POST /v1/live/sessions` with the project API
 * key, and we hand the SDP answer back. That is the whole reason a server half
 * exists — this API has no ephemeral tokens (WebRTC auth is bound to the
 * negotiated peer connection), so the key cannot go to the browser, so the
 * exchange has to happen somewhere that holds it.
 *
 * WHAT THAT COSTS US, said plainly: because we are not in the media path, we
 * cannot unilaterally stop a stream. The documented close is client-initiated
 * (`session.close` on the data channel). Everything in VoiceSessionManager is
 * therefore accounting plus a best-effort remote close — see the comment on
 * {@link openAiVoiceTransport} for exactly how far the server's authority
 * reaches.
 *
 * THE KEY. This is the first real secret muxpad has ever held. It enters through
 * one function ({@link openAiVoiceTransport}), is closed over, and is never
 * stored on a config object, never returned, never logged. Anything derived from
 * an upstream response passes through {@link redact} before it can reach a
 * response body or a log line.
 */

/** The only model this speaks to. Not configurable: the request shape, the
 *  delegation mode and the transport are all specific to it. */
export const VOICE_MODEL = 'gpt-live-1';

/** Default TTS voice. Override with MUXPAD_VOICE_NAME. */
export const DEFAULT_VOICE = 'marin';

/**
 * The interruption line, verbatim from OpenAI's guide. Kept as a constant and
 * quoted exactly because the docs recommend this precise wording — paraphrasing
 * a prompt that a vendor has tuned is a silent regression nobody can see.
 */
export const INTERRUPTION_POLICY =
  'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.';

/** How long we wait on the SDP exchange. An offer/answer is one small HTTP
 *  round trip; if it hasn't landed in 15s the user is staring at a dead mic
 *  button and an honest failure beats a longer wait. */
export const EXCHANGE_TIMEOUT_MS = 15_000;

/** Best-effort remote close gets a short leash — nothing waits on it. */
export const CLOSE_TIMEOUT_MS = 5_000;

/** An SDP offer big enough to be a payload rather than a negotiation. Real
 *  offers measure a few KB; this is two orders of magnitude of headroom and
 *  still stops an unauthenticated endpoint from being a memory sink. */
export const MAX_SDP_CHARS = 256_000;

export type VoiceErrorCode =
  /** No API key configured — the feature is off, not broken. */
  | 'voice_unconfigured'
  /** The daily minute ceiling is spent. */
  | 'voice_budget'
  /** A session is already live; one per install. */
  | 'voice_busy'
  /** Malformed request (no paneId, no sdp, unknown pane, oversized offer). */
  | 'bad_request'
  /** OpenAI refused or could not be reached. */
  | 'voice_upstream';

const STATUS_FOR: Record<VoiceErrorCode, 400 | 409 | 429 | 502 | 503> = {
  voice_unconfigured: 503,
  voice_budget: 429,
  voice_busy: 409,
  bad_request: 400,
  voice_upstream: 502,
};

/** A voice failure carrying the code AND the status the route must answer with,
 *  so the contract lives in one place instead of in a switch at the route. */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly status: 400 | 409 | 429 | 502 | 503;
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
    this.status = STATUS_FOR[code];
  }
}

/**
 * Scrub a secret out of text that came from somewhere we don't control.
 *
 * Applied to every upstream error string before it can reach a response body or
 * a log line. OpenAI does not echo the key today; this costs one `includes` and
 * means a future version that does cannot turn into a leak here.
 */
export function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * The instructions the session starts with.
 *
 * The glossary is the whole reason this isn't a one-line prompt. muxpad already
 * builds one from this install's workspace / tab / pane / app names for
 * dictation cleanup (chat/glossary.ts) precisely because a general recognizer
 * renders "muxpad" as "Max pad" and "cron schedule" as "crown schedule". A live
 * voice model has exactly the same blind spot and the same fix, so it gets the
 * same list rather than a second, divergent one.
 */
export function buildVoiceInstructions(glossary: readonly string[]): string {
  const terms = glossary.length > 0 ? glossary.join(', ') : '(none)';
  return [
    'You are muxpad’s voice. muxpad is the user’s development cockpit: workspaces of',
    'tabs, tabs of panes, panes running terminals, coding agents, or web views.',
    'You are talking to its owner, hands-free, usually from a phone.',
    '',
    'Speak the way a sharp colleague talks, not the way a document reads: short sentences,',
    'no preamble, no bullet lists read aloud, no restating the question. If you do not know,',
    'say so.',
    '',
    INTERRUPTION_POLICY,
    '',
    // Same reasoning as chat/clean-transcript.ts: the multi-word mishearings are
    // the ones that need naming, because each word is ordinary English and only
    // looks wrong once you know the vocabulary.
    'Names and terms from this user’s world. Speech recognition mangles them into ordinary',
    'words — "Max pad" for muxpad, "crown schedule" for "cron schedule", "heart effect" for',
    '"artifact". When something you heard plausibly SOUNDS like one of these, it is one:',
    terms,
    '',
    'Pronounce those names as written when you say them back.',
  ].join('\n');
}

/** What we send OpenAI as `session`. Serialized straight into the request. */
export interface VoiceSessionConfig {
  model: string;
  voice: string;
  instructions: string;
  /**
   * `client` delegation: the browser drives the conversation over the data
   * channel. The alternative (`responses`) would make OpenAI call a second model
   * server-side on our dime with no muxpad in the loop — wrong shape and a
   * second, unmetered cost centre.
   */
  delegation: { type: 'client' };
}

export interface SdpOffer {
  sdp: string;
  session: VoiceSessionConfig;
}

export interface SdpAnswer {
  sessionId: string;
  sdp: string;
  /** Epoch ms, when upstream states one. It does not today, so this is
   *  effectively always null and our own TTL is the deadline the client gets. */
  expiresAt: number | null;
}

/**
 * The seam the network sits behind. ONE function, so tests inject a fake and no
 * suite can reach OpenAI — and so the API key exists in exactly one closure.
 */
export type SdpExchange = (offer: SdpOffer, signal: AbortSignal) => Promise<SdpAnswer>;

/** Best-effort remote close. Resolves whether or not it worked; nothing in the
 *  request path waits on it. */
export type SessionCloser = (sessionId: string, signal: AbortSignal) => Promise<void>;

export interface VoiceTransport {
  exchange: SdpExchange;
  close: SessionCloser;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The production transport, bound to a key.
 *
 * ON `close`, HONESTLY: OpenAI documents no server-side session-delete endpoint
 * — the documented teardown is the client sending `session.close` on the data
 * channel, or simply dropping the peer connection. We try a DELETE anyway,
 * best-effort and silent on failure, because it is one cheap request and it is
 * the ONLY server-side stop that could work in the case that actually leaks
 * money: a backgrounded phone whose tab is frozen and can neither honour the
 * deadline it was given nor send `session.close`. Do not read a successful
 * return as "billing stopped" — read it as "we asked". The load-bearing
 * controls are the ones in VoiceSessionManager, which do not depend on anyone
 * else's cooperation: one session at a time, a TTL past which we will not
 * hand out another, and a daily ceiling that survives restarts.
 */
export function openAiVoiceTransport(
  apiKey: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): VoiceTransport {
  const base = opts.baseUrl ?? 'https://api.openai.com/v1';
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${apiKey}` };

  const exchange: SdpExchange = async (offer, signal) => {
    let res: Response;
    try {
      res = await doFetch(`${base}/live/sessions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          session: offer.session,
          transport: { type: 'webrtc', sdp: offer.sdp },
        }),
        signal,
      });
    } catch (err) {
      throw new VoiceError('voice_upstream', redact(errText(err), apiKey));
    }
    const raw = await res.text().catch(() => '');
    if (res.status !== 201 && res.status !== 200) {
      // Upstream's message is genuinely useful ("insufficient_quota",
      // "invalid_api_key") and is what the user needs to see — redacted, capped,
      // and with the status so a 401 doesn't read as a network blip.
      const detail = redact(raw, apiKey).slice(0, 400).trim();
      throw new VoiceError(
        'voice_upstream',
        `OpenAI refused the session (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    let body: {
      session?: { id?: unknown; expires_at?: unknown };
      transport?: { sdp?: unknown };
    };
    try {
      body = JSON.parse(raw);
    } catch {
      throw new VoiceError('voice_upstream', 'OpenAI returned a non-JSON session response');
    }
    const sessionId = typeof body.session?.id === 'string' ? body.session.id : '';
    const sdp = typeof body.transport?.sdp === 'string' ? body.transport.sdp : '';
    if (!sessionId || !sdp) {
      throw new VoiceError('voice_upstream', 'OpenAI returned a session with no id or no answer');
    }
    // Undocumented today; read defensively so a future field is honoured
    // instead of ignored. Seconds → ms, the unit the rest of muxpad uses.
    const exp = body.session?.expires_at;
    const expiresAt =
      typeof exp === 'number' && Number.isFinite(exp) ? Math.round(exp * 1000) : null;
    return { sessionId, sdp, expiresAt };
  };

  const close: SessionCloser = async (sessionId, signal) => {
    try {
      await doFetch(`${base}/live/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: auth,
        signal,
      });
    } catch {
      // Best effort, by construction. See the block comment above.
    }
  };

  return { exchange, close };
}
