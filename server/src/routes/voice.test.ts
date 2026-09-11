import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { openDb } from '../store/db.js';
import {
  VOICE_USAGE_KEY,
  VoiceSessionManager,
  type VoiceSessionManagerDeps,
  dayKey,
} from '../voice/VoiceSessionManager.js';
import { type SdpExchange, openAiVoiceTransport } from '../voice/live.js';
import { voiceRoutes } from './voice.js';

// The exchange is faked in every case — this suite never reaches OpenAI.

const KEY = 'sk-proj-THIS-IS-THE-SECRET-abcdef0123456789';
const TTL = 10 * 60_000;

describe('/api/voice', () => {
  let db: Database.Database;
  let globals: GlobalsStore;
  let logs: string[];

  beforeEach(() => {
    db = openDb(':memory:');
    globals = new GlobalsStore(db);
    logs = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T10:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const manager = (over: Partial<VoiceSessionManagerDeps> = {}) =>
    new VoiceSessionManager({
      globals,
      exchange: vi.fn(async () => ({
        sessionId: 'live_123',
        sdp: 'v=0 answer',
        expiresAt: null,
      })) as SdpExchange,
      instructions: () => 'muxpad, ptyd',
      sessionTtlMs: TTL,
      dailyCapMinutes: 60,
      log: (l) => logs.push(l),
      ...over,
    });

  /** The error code in a refusal envelope. */
  const codeOf = async (res: Response) =>
    ((await res.json()) as { error?: { code?: string } }).error?.code;

  const post = (app: ReturnType<typeof voiceRoutes>, body: unknown) =>
    app.request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('POST returns the answer, the session id, our deadline and the voice', async () => {
    const app = voiceRoutes({ voice: manager({ voice: 'marin' }) });
    const res = await post(app, { paneId: 'pane-1', sdp: 'v=0 offer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 'live_123',
      sdp: 'v=0 answer',
      expiresAt: Date.now() + TTL,
      voice: 'marin',
    });
  });

  it('POST 503s with voice_unconfigured when there is no API key', async () => {
    const app = voiceRoutes({ voice: manager({ exchange: undefined }) });
    const res = await post(app, { paneId: 'pane-1', sdp: 'v=0 offer' });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('voice_unconfigured');
  });

  it('POST 503s the same way when no manager was wired at all', async () => {
    const res = await post(voiceRoutes({ voice: undefined }), { paneId: 'p', sdp: 'v=0' });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('voice_unconfigured');
  });

  it('POST 409s with voice_busy when a session is already live', async () => {
    const app = voiceRoutes({ voice: manager() });
    expect((await post(app, { paneId: 'pane-1', sdp: 'v=0' })).status).toBe(200);
    const second = await post(app, { paneId: 'pane-2', sdp: 'v=0' });
    expect(second.status).toBe(409);
    expect(await codeOf(second)).toBe('voice_busy');
  });

  it('POST 429s with voice_budget once the daily ceiling is spent', async () => {
    globals.set(
      VOICE_USAGE_KEY,
      JSON.stringify({ day: dayKey(Date.now()), seconds: 60 * 60, open: null }),
    );
    const res = await post(voiceRoutes({ voice: manager() }), { paneId: 'pane-1', sdp: 'v=0' });
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe('voice_budget');
  });

  it('POST 400s on a malformed body or a missing field', async () => {
    const app = voiceRoutes({ voice: manager() });
    expect((await post(app, 'not json')).status).toBe(400);
    expect((await post(app, { sdp: 'v=0' })).status).toBe(400);
    expect((await post(app, { paneId: 'pane-1' })).status).toBe(400);
  });

  it('POST refuses an absurd body on the declared length, before buffering it', async () => {
    const exchange = vi.fn();
    const app = voiceRoutes({ voice: manager({ exchange: exchange as unknown as SdpExchange }) });
    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '99000000' },
      body: JSON.stringify({ paneId: 'pane-1', sdp: 'v=0' }),
    });
    expect(res.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('DELETE closes the session, stops the meter, and is idempotent', async () => {
    const m = manager();
    const app = voiceRoutes({ voice: m });
    await post(app, { paneId: 'pane-1', sdp: 'v=0' });
    vi.advanceTimersByTime(120_000);

    const res = await app.request('/session/live_123', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(m.status().live).toBe(false);
    const stopped = m.status().minutesToday;
    vi.advanceTimersByTime(300_000);
    expect(m.status().minutesToday).toBe(stopped);

    // The client's panic button fires from pagehide with no chance to read a
    // response; a second call, or an id we no longer know, must still be 204.
    expect((await app.request('/session/live_123', { method: 'DELETE' })).status).toBe(204);
    expect((await app.request('/session/live_nope', { method: 'DELETE' })).status).toBe(204);
  });

  it('DELETE is 204 even with no manager wired', async () => {
    const res = await voiceRoutes({ voice: undefined }).request('/session/x', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('GET /status reports configuration, liveness, the meter and the cap', async () => {
    const m = manager();
    const app = voiceRoutes({ voice: m });
    expect(await (await app.request('/status')).json()).toEqual({
      configured: true,
      live: false,
      minutesToday: 0,
      capMinutes: 60,
    });
    await post(app, { paneId: 'pane-1', sdp: 'v=0' });
    vi.advanceTimersByTime(60_000);
    expect(await (await app.request('/status')).json()).toEqual({
      configured: true,
      live: true,
      minutesToday: 1,
      capMinutes: 60,
    });
  });

  it('GET /status answers honestly on an unconfigured install instead of 404ing', async () => {
    const res = await voiceRoutes({ voice: undefined }).request('/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      live: false,
      minutesToday: 0,
      capMinutes: 0,
    });
  });

  // ── the secret ──────────────────────────────────────────────────────

  it('never puts the API key in a response body or a log line, on any path', async () => {
    // Worst case end to end: a real transport built on the real key, against an
    // upstream that quotes the key back in its refusal.
    const transport = openAiVoiceTransport(KEY, {
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: `key ${KEY} revoked` } }), {
          status: 401,
        })) as typeof fetch,
    });
    const m = manager({ exchange: transport.exchange, closeRemote: transport.close });
    const app = voiceRoutes({ voice: m });

    const bodies: string[] = [];
    bodies.push(await (await post(app, { paneId: 'pane-1', sdp: 'v=0 offer' })).text());
    bodies.push(await (await app.request('/status')).text());
    bodies.push(await (await app.request('/session/live_123', { method: 'DELETE' })).text());
    bodies.push(await (await post(app, 'not json')).text());

    for (const b of bodies) expect(b).not.toContain(KEY);
    for (const b of bodies) expect(b).not.toContain('sk-proj');
    for (const l of logs) expect(l).not.toContain(KEY);
    // …and the refusal is still useful, not scrubbed into uselessness.
    expect(bodies[0]).toContain('voice_upstream');
    expect(bodies[0]).toContain('[redacted]');
  });
});
