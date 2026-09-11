import { Hono } from 'hono';
import type { VoiceSessionManager } from '../voice/VoiceSessionManager.js';
import { MAX_SDP_CHARS, VoiceError } from '../voice/live.js';

/**
 * `/api/voice` — muxpad's only server-side involvement in a voice call.
 *
 *   POST   /api/voice/session        { paneId, sdp } → { sessionId, sdp, expiresAt, voice }
 *   DELETE /api/voice/session/:id    → 204
 *   GET    /api/voice/status         → { configured, live, minutesToday, capMinutes }
 *
 * The POST is a one-shot SDP offer→answer relay: the browser can't hold the
 * OpenAI key (this API has no ephemeral tokens), so the exchange happens here
 * and the audio itself goes browser↔OpenAI directly. See voice/live.ts.
 *
 * ALWAYS MOUNTED, even with no API key. An unconfigured install answers
 * `configured: false` on GET and 503 on POST, which is a thing the UI can render
 * ("voice is off, set a key"); a 404 is indistinguishable from an old server and
 * sends the client looking for a bug that isn't there.
 *
 * THE MONEY. This endpoint spends the user's money, and muxpad has no auth —
 * reachability is authorization (same-origin.ts). Every cap that makes that
 * acceptable is enforced in VoiceSessionManager, server-side, before the network
 * call: one live session, a per-session TTL, a persisted daily minute ceiling.
 * Nothing here trusts a field from the client except the SDP it is relaying.
 */
export function voiceRoutes(deps: { voice?: VoiceSessionManager | undefined }): Hono {
  const app = new Hono();

  const unconfigured = {
    error: {
      code: 'voice_unconfigured' as const,
      message: 'voice is off: set MUXPAD_OPENAI_API_KEY (or OPENAI_API_KEY) and restart muxpad',
    },
  };

  app.post('/session', async (c) => {
    const manager = deps.voice;
    if (!manager) return c.json(unconfigured, 503);
    // Refuse an absurd body BEFORE buffering it. The manager bounds the SDP it
    // will forward, but that check happens after `c.req.json()` has already read
    // the whole thing into memory — and this is an endpoint anyone who can reach
    // the port may call. A real offer is a few KB.
    const declared = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_SDP_CHARS * 2) {
      return c.json({ error: { code: 'bad_request', message: 'offer is too large' } }, 400);
    }
    let body: { paneId?: unknown; sdp?: unknown };
    try {
      body = (await c.req.json()) as { paneId?: unknown; sdp?: unknown };
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'expected a JSON body' } }, 400);
    }
    try {
      const started = await manager.start({ paneId: body.paneId, sdp: body.sdp });
      return c.json(started, 200);
    } catch (err) {
      // VoiceError carries its own status, so the contract's code→status mapping
      // lives with the failure rather than in a switch that can drift from it.
      if (err instanceof VoiceError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status);
      }
      return c.json(
        { error: { code: 'voice_upstream', message: 'could not start a voice session' } },
        502,
      );
    }
  });

  // Idempotent on purpose: this is the client's hang-up, including the one it
  // fires from a `pagehide` handler with no chance to read the response. An
  // unknown id is a session that is already closed, which is the outcome the
  // caller wanted. Never 404 — that only teaches a client to stop retrying the
  // one call that stops the meter.
  app.delete('/session/:id', (c) => {
    deps.voice?.stop(c.req.param('id'), 'client');
    return c.body(null, 204);
  });

  app.get('/status', (c) =>
    c.json(
      deps.voice?.status() ?? {
        configured: false,
        live: false,
        minutesToday: 0,
        capMinutes: 0,
      },
    ),
  );

  return app;
}
