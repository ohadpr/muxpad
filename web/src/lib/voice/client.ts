// muxpad's half of the handshake: three endpoints, no audio, no streaming.
//
// The server's entire job is to hold the API key and trade one SDP offer for
// one SDP answer. Audio never touches it. That is why a voice session survives
// a muxpad server restart mid-call (the peer connection is direct) and why the
// only muxpad-side failure modes are at setup time.
//
// THE REFUSALS ARE THE INTERESTING PART, because on a machine with no API key
// the 503 is the ONLY path that runs — so it is the one the UI must handle
// beautifully rather than as a generic error toast.

import { ApiError, req } from '../../api';

export interface VoiceSessionAnswer {
  sessionId: string;
  sdp: string;
  /** Epoch ms after which the server will not honour this session. Null when
   *  the server declines to set a deadline. */
  expiresAt: number | null;
  /** The voice the model was configured with — shown so the user knows which
   *  one they are paying for. */
  voice: string;
}

export interface VoiceStatus {
  /** Is an API key present server-side? False → the mic is disabled, with a
   *  reason, rather than hidden. */
  configured: boolean;
  /** Is a session live right now (possibly on another device)? */
  live: boolean;
  minutesToday: number;
  /**
   * Today's ceiling in minutes. ALWAYS a number — the server has no "uncapped"
   * mode, because an uncapped voice session is an unbounded bill. An
   * unconfigured install reports 0, which is why `configured` must be checked
   * before the budget (0 of 0 minutes left is true but is not the reason).
   */
  capMinutes: number;
}

/** Why a session could not start, in terms the UI can act on. */
export type VoiceRefusal = 'unconfigured' | 'budget' | 'busy' | 'unknown';

export class VoiceUnavailableError extends Error {
  readonly refusal: VoiceRefusal;
  readonly status: number;
  constructor(message: string, refusal: VoiceRefusal, status: number) {
    super(message);
    this.name = 'VoiceUnavailableError';
    this.refusal = refusal;
    this.status = status;
  }
}

/**
 * Map a failed session POST onto a refusal.
 *
 * The envelope's `code` is authoritative and the STATUS is the fallback, in
 * that order. Both are checked because the two are meant to agree and a
 * mismatch should still land somewhere useful rather than on 'unknown' — a UI
 * that says "voice isn't set up" is helpful, one that says "429" is not.
 */
export function refusalOf(e: unknown): VoiceRefusal {
  if (!(e instanceof ApiError)) return 'unknown';
  switch (e.code) {
    case 'voice_unconfigured':
      return 'unconfigured';
    case 'voice_budget':
      return 'budget';
    case 'voice_busy':
      return 'busy';
    default:
      break;
  }
  if (e.status === 503) return 'unconfigured';
  if (e.status === 429) return 'budget';
  if (e.status === 409) return 'busy';
  return 'unknown';
}

/** Human-readable, and specific enough to act on. These are the only strings
 *  the user sees when voice fails to start, so they say what to DO. */
export function refusalMessage(r: VoiceRefusal, fallback?: string): string {
  switch (r) {
    case 'unconfigured':
      return 'Voice isn’t set up on this server — no OpenAI key configured.';
    case 'budget':
      return 'Voice is over today’s spending cap.';
    case 'busy':
      return 'A voice session is already running somewhere else.';
    default:
      return fallback?.trim() || 'Voice couldn’t start.';
  }
}

export async function createVoiceSession(
  paneId: string,
  sdp: string,
  signal?: AbortSignal,
): Promise<VoiceSessionAnswer> {
  try {
    return await req<VoiceSessionAnswer>('/api/voice/session', {
      method: 'POST',
      body: JSON.stringify({ paneId, sdp }),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    const refusal = refusalOf(e);
    throw new VoiceUnavailableError(
      refusalMessage(refusal, e instanceof Error ? e.message : undefined),
      refusal,
      e instanceof ApiError ? e.status : 0,
    );
  }
}

/**
 * Tear a session down server-side. Deliberately never throws: every caller is
 * on a cleanup path (the user pressed stop, the tab went to the background,
 * the component unmounted) and none of them can do anything useful with a
 * failure. The server expires sessions on its own, so a lost DELETE costs at
 * most the remainder of a TTL.
 */
export async function endVoiceSession(sessionId: string): Promise<void> {
  try {
    await req<void>(`/api/voice/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  } catch {
    // best effort by design
  }
}

/**
 * Ask whether voice is even possible, and what it has cost today.
 *
 * Returns null when the endpoint itself is unreachable — which is different
 * from `configured: false`, and the UI treats it that way: unreachable hides
 * the control, unconfigured shows it disabled with a reason.
 */
export async function fetchVoiceStatus(): Promise<VoiceStatus | null> {
  try {
    return await req<VoiceStatus>('/api/voice/status');
  } catch {
    return null;
  }
}

/**
 * Minutes left against today's cap, or null when there is no status to count
 * against — which is "we don't know yet", not "unlimited", and the UI renders
 * nothing rather than guessing.
 *
 * Clamped at zero: a negative "-3 min left" is a worse bug than a wrong zero,
 * and the server's own budget check refuses well before the number would go
 * negative anyway.
 */
export function minutesRemaining(s: VoiceStatus | null): number | null {
  if (!s || typeof s.capMinutes !== 'number') return null;
  return Math.max(0, Math.round(s.capMinutes - s.minutesToday));
}
