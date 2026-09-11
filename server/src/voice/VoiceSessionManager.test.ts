import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { openDb } from '../store/db.js';
import {
  DISCONNECT_GRACE_MS,
  MIN_BILLED_SECONDS,
  VOICE_USAGE_KEY,
  VoiceSessionManager,
  type VoiceSessionManagerDeps,
  dayKey,
} from './VoiceSessionManager.js';
import { INTERRUPTION_POLICY, type SdpExchange, VOICE_MODEL, VoiceError } from './live.js';

// Nothing in this file reaches the network: the exchange is always a fake.

const TTL = 10 * 60_000;

describe('VoiceSessionManager', () => {
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

  const okExchange = (): SdpExchange =>
    vi.fn(async () => ({ sessionId: 'live_123', sdp: 'v=0 answer', expiresAt: null }));

  /** The nth offer an exchange spy was handed. */
  const offerAt = (exchange: SdpExchange, n: number) => {
    const call = (exchange as ReturnType<typeof vi.fn>).mock.calls[n];
    if (!call) throw new Error(`no exchange call ${n}`);
    return call[0] as Parameters<SdpExchange>[0];
  };

  const make = (over: Partial<VoiceSessionManagerDeps> = {}) =>
    new VoiceSessionManager({
      globals,
      exchange: okExchange(),
      instructions: () => 'instructions with muxpad, ptyd',
      sessionTtlMs: TTL,
      dailyCapMinutes: 60,
      log: (l) => logs.push(l),
      ...over,
    });

  const start = (m: VoiceSessionManager, paneId = 'pane-1') =>
    m.start({ paneId, sdp: 'v=0 offer' });

  // ── configuration ───────────────────────────────────────────────────

  it('refuses with voice_unconfigured when no API key produced a transport', async () => {
    const m = make({ exchange: undefined });
    expect(m.configured).toBe(false);
    expect(m.status()).toMatchObject({ configured: false, live: false });
    await expect(start(m)).rejects.toMatchObject({
      code: 'voice_unconfigured',
      status: 503,
    });
  });

  // ── the happy path ──────────────────────────────────────────────────

  it('relays the offer and hands back the answer, the id, our deadline and the voice', async () => {
    const exchange = okExchange();
    const m = make({ exchange, voice: 'marin' });
    const started = await start(m);
    expect(started).toEqual({
      sessionId: 'live_123',
      sdp: 'v=0 answer',
      expiresAt: Date.now() + TTL,
      voice: 'marin',
    });
    expect(m.status().live).toBe(true);
  });

  it('sends gpt-live-1, client delegation, the voice and glossary-primed instructions', async () => {
    const exchange = okExchange();
    const m = make({
      exchange,
      voice: 'cedar',
      instructions: () => `glossary: muxpad, ptyd, Acme GTM\n${INTERRUPTION_POLICY}`,
    });
    await start(m);
    const offer = offerAt(exchange, 0);
    expect(offer.sdp).toBe('v=0 offer');
    expect(offer.session.model).toBe(VOICE_MODEL);
    expect(offer.session.voice).toBe('cedar');
    expect(offer.session.delegation).toEqual({ type: 'client' });
    // The glossary rides on the instructions — that is the whole "Max pad" fix.
    expect(offer.session.instructions).toContain('muxpad');
    expect(offer.session.instructions).toContain('Acme GTM');
    // And the interruption policy is the documented wording, verbatim.
    expect(offer.session.instructions).toContain(INTERRUPTION_POLICY);
  });

  it('rebuilds instructions per session, so a rename lands without a restart', async () => {
    let terms = 'muxpad';
    const exchange = okExchange();
    const m = make({ exchange, instructions: () => terms });
    await start(m);
    m.stop('live_123', 'test');
    terms = 'muxpad, nimbus';
    await start(m);
    expect(offerAt(exchange, 0).session.instructions).toBe('muxpad');
    expect(offerAt(exchange, 1).session.instructions).toBe('muxpad, nimbus');
  });

  // ── cap 1: one live session ─────────────────────────────────────────

  it('refuses a second session with voice_busy while one is live', async () => {
    const m = make();
    await start(m);
    await expect(start(m, 'pane-2')).rejects.toMatchObject({ code: 'voice_busy', status: 409 });
  });

  it('holds the slot across the await, so two simultaneous requests cannot both start', async () => {
    // The busy check straddles a network round trip. Without the reservation,
    // both callers see an empty slot and both start a paid session.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exchange = vi.fn(async () => {
      await gate;
      return { sessionId: 'live_123', sdp: 'answer', expiresAt: null };
    });
    const m = make({ exchange });
    const first = start(m);
    const second = start(m, 'pane-2');
    await expect(second).rejects.toMatchObject({ code: 'voice_busy' });
    release?.();
    await first;
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('frees the slot when the exchange fails, instead of wedging at 409 forever', async () => {
    const exchange = vi.fn().mockRejectedValueOnce(new Error('upstream is down'));
    const m = make({ exchange: exchange as unknown as SdpExchange });
    await expect(start(m)).rejects.toMatchObject({ code: 'voice_upstream', status: 502 });
    expect(m.status().live).toBe(false);
    // And a failed exchange bought nothing, so it must not be billed.
    expect(m.minutesToday()).toBe(0);
  });

  // ── cap 2: the TTL ──────────────────────────────────────────────────

  it('closes the session when the TTL expires, without the client doing anything', async () => {
    const closeRemote = vi.fn(async () => {});
    const m = make({ closeRemote });
    await start(m);
    expect(m.status().live).toBe(true);
    await vi.advanceTimersByTimeAsync(TTL + 10);
    expect(m.status().live).toBe(false);
    expect(closeRemote).toHaveBeenCalledWith('live_123', expect.anything());
    // Charged the whole window it was allowed to run for.
    expect(m.minutesToday()).toBeCloseTo(10, 1);
    expect(logs.join('\n')).toContain('10-minute limit');
  });

  it('the TTL frees the slot, so voice is usable again afterwards', async () => {
    const m = make();
    await start(m);
    await vi.advanceTimersByTimeAsync(TTL + 10);
    await expect(start(m)).resolves.toMatchObject({ sessionId: 'live_123' });
  });

  // ── cap 3: the daily ceiling ────────────────────────────────────────

  it('refuses with voice_budget once the daily ceiling is spent', async () => {
    globals.set(
      VOICE_USAGE_KEY,
      JSON.stringify({ day: dayKey(Date.now()), seconds: 60 * 60, open: null }),
    );
    const m = make({ dailyCapMinutes: 60 });
    await expect(start(m)).rejects.toMatchObject({ code: 'voice_budget', status: 429 });
    expect(m.status()).toMatchObject({ live: false, minutesToday: 60, capMinutes: 60 });
  });

  it('refuses a sliver of budget rather than selling a session that instantly dies', async () => {
    globals.set(
      VOICE_USAGE_KEY,
      JSON.stringify({ day: dayKey(Date.now()), seconds: 60 * 60 - 10, open: null }),
    );
    const m = make({ dailyCapMinutes: 60 });
    await expect(start(m)).rejects.toMatchObject({ code: 'voice_budget' });
  });

  it('shortens the TTL so a session cannot run through the ceiling it was admitted under', async () => {
    // 58 of 60 minutes spent: 2 minutes left, but the session limit is 10.
    globals.set(
      VOICE_USAGE_KEY,
      JSON.stringify({ day: dayKey(Date.now()), seconds: 58 * 60, open: null }),
    );
    const m = make({ dailyCapMinutes: 60 });
    const started = await start(m);
    expect(started.expiresAt).toBe(Date.now() + 2 * 60_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10);
    expect(m.status().live).toBe(false);
    expect(m.minutesToday()).toBeCloseTo(60, 1);
  });

  it('rolls the meter over at the start of a new local day', async () => {
    globals.set(
      VOICE_USAGE_KEY,
      JSON.stringify({ day: '2026-09-10', seconds: 60 * 60, open: null }),
    );
    const m = make({ dailyCapMinutes: 60 });
    expect(m.minutesToday()).toBe(0);
    await expect(start(m)).resolves.toBeTruthy();
  });

  // ── billing ─────────────────────────────────────────────────────────

  it('charges at least the 15 seconds OpenAI bills up front for creating a session', async () => {
    const m = make();
    await start(m);
    vi.advanceTimersByTime(1_000);
    m.stop('live_123', 'client');
    expect(m.minutesToday()).toBeCloseTo(MIN_BILLED_SECONDS / 60, 3);
  });

  it('DELETE stops billing: the meter does not move after the session is closed', async () => {
    const m = make();
    await start(m);
    vi.advanceTimersByTime(120_000);
    expect(m.stop('live_123', 'client')).toBe(true);
    const atClose = m.minutesToday();
    expect(atClose).toBeCloseTo(2, 1);
    // Five more minutes of wall clock must cost nothing.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(m.minutesToday()).toBe(atClose);
    expect(m.status().live).toBe(false);
    // Every close leaves an audit line naming the cause and the cost.
    expect(logs.join('\n')).toContain('session closed (client) after 120s');
    expect(logs.join('\n')).toContain('2.0 of 60 minutes used today');
  });

  it('closing is idempotent and an unknown id is a no-op', async () => {
    const m = make();
    await start(m);
    expect(m.stop('live_999', 'client')).toBe(false);
    expect(m.status().live).toBe(true);
    expect(m.stop('live_123', 'client')).toBe(true);
    expect(m.stop('live_123', 'client')).toBe(false);
  });

  it('counts the in-flight session in minutesToday, so the meter moves while talking', async () => {
    const m = make();
    await start(m);
    vi.advanceTimersByTime(180_000);
    expect(m.minutesToday()).toBeCloseTo(3, 1);
  });

  // ── persistence across a restart ────────────────────────────────────

  it('persists spent minutes across a server restart', async () => {
    const first = make();
    await start(first);
    vi.advanceTimersByTime(4 * 60_000);
    first.dispose(); // the SIGTERM path
    expect(first.minutesToday()).toBeCloseTo(4, 1);

    // A brand-new process, same database.
    const second = make();
    expect(second.minutesToday()).toBeCloseTo(4, 1);
    expect(second.status().capMinutes).toBe(60);
  });

  it('still refuses after a restart when the ceiling was already spent', async () => {
    globals.set(
      VOICE_USAGE_KEY,
      JSON.stringify({ day: dayKey(Date.now()), seconds: 61 * 60, open: null }),
    );
    const fresh = make();
    await expect(start(fresh)).rejects.toMatchObject({ code: 'voice_budget', status: 429 });
  });

  it('charges a crashed session its full limit, because we cannot know when it ended', async () => {
    const first = make();
    await start(first);
    vi.advanceTimersByTime(30_000);
    // No dispose(): the process was killed. The ledger still holds `open`.
    const afterCrash = make();
    expect(afterCrash.minutesToday()).toBeCloseTo(10, 1);
    expect(logs.join('\n')).toContain('still open when the server stopped');
    // And the recovery is settled, not re-charged on the next boot.
    expect(make().minutesToday()).toBeCloseTo(10, 1);
  });

  it('survives a corrupt ledger row without bricking voice', async () => {
    globals.set(VOICE_USAGE_KEY, 'not json at all');
    const m = make();
    expect(m.minutesToday()).toBe(0);
    await expect(start(m)).resolves.toBeTruthy();
  });

  // ── cap 4: close on disconnect ──────────────────────────────────────

  it('closes the session after the pane s chat sockets stay gone', async () => {
    const m = make();
    await start(m, 'pane-1');
    m.noteChatPresence('pane-1', 0);
    expect(m.status().live).toBe(true); // grace window
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 10);
    expect(m.status().live).toBe(false);
    expect(logs.join('\n')).toContain('chat view has been gone');
  });

  it('does not hang up on a socket that reconnects inside the grace window', async () => {
    const m = make();
    await start(m, 'pane-1');
    m.noteChatPresence('pane-1', 0);
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS / 2);
    m.noteChatPresence('pane-1', 1);
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS * 2);
    expect(m.status().live).toBe(true);
  });

  it('ignores another pane s sockets dropping', async () => {
    const m = make();
    await start(m, 'pane-1');
    m.noteChatPresence('pane-2', 0);
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS * 2);
    expect(m.status().live).toBe(true);
  });

  it('closes immediately when the pane is deleted — there is nothing to reconnect to', async () => {
    const closeRemote = vi.fn(async () => {});
    const m = make({ closeRemote });
    await start(m, 'pane-1');
    m.notePaneRemoved('pane-1');
    expect(m.status().live).toBe(false);
    expect(closeRemote).toHaveBeenCalled();
  });

  it('settles a live session on shutdown so the next boot does not overcharge it', async () => {
    const m = make();
    await start(m);
    vi.advanceTimersByTime(60_000);
    m.dispose();
    expect(m.status().live).toBe(false);
    expect(m.minutesToday()).toBeCloseTo(1, 1);
  });

  // ── request validation ──────────────────────────────────────────────

  it('rejects a request with no paneId, no sdp, or an unknown pane', async () => {
    const m = make({ paneExists: (id) => id === 'pane-1' });
    await expect(m.start({ paneId: '', sdp: 'v=0' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(m.start({ paneId: 'pane-1', sdp: '  ' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(m.start({ paneId: 'ghost', sdp: 'v=0' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(m.status().live).toBe(false);
    expect(m.minutesToday()).toBe(0);
  });

  it('rejects an oversized offer before spending anything', async () => {
    const exchange = okExchange();
    const m = make({ exchange });
    await expect(m.start({ paneId: 'pane-1', sdp: 'x'.repeat(300_000) })).rejects.toBeInstanceOf(
      VoiceError,
    );
    expect(exchange).not.toHaveBeenCalled();
  });
});
