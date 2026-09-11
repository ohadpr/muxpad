import { describe, expect, it } from 'vitest';
import type { VoiceStatus } from '../lib/voice/client';
import { clockOf, isLive, stateLabel, unavailableReason } from './VoiceControl';

const status = (o: Partial<VoiceStatus> = {}): VoiceStatus => ({
  configured: true,
  live: false,
  minutesToday: 0,
  capMinutes: 60,
  ...o,
});

describe('clockOf', () => {
  it('is mm:ss with padded seconds', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(9_000)).toBe('0:09');
    expect(clockOf(61_000)).toBe('1:01');
    expect(clockOf(600_000)).toBe('10:00');
  });

  it('keeps counting in minutes past an hour — a louder signal than a tidy 1:00:03', () => {
    expect(clockOf(3_723_000)).toBe('62:03');
  });

  it('never renders a negative clock', () => {
    expect(clockOf(-5000)).toBe('0:00');
  });
});

describe('stateLabel', () => {
  it('names each of the five live states distinctly', () => {
    const labels = (['connecting', 'listening', 'thinking', 'speaking', 'error'] as const).map(
      stateLabel,
    );
    expect(new Set(labels).size).toBe(5);
    expect(labels).toContain('Listening');
    expect(labels).toContain('Working');
    expect(labels).toContain('Speaking');
  });
});

describe('isLive — what counts as spending money', () => {
  it('is true for every state where a session exists', () => {
    for (const s of ['connecting', 'listening', 'thinking', 'speaking'] as const) {
      expect(isLive(s)).toBe(true);
    }
  });

  it('is false once there is nothing to stop', () => {
    for (const s of ['off', 'error', 'ended'] as const) expect(isLive(s)).toBe(false);
  });
});

describe('unavailableReason', () => {
  it('is null when voice can actually run', () => {
    expect(unavailableReason(status(), true, null)).toBeNull();
  });

  it('explains an unsupported browser', () => {
    expect(unavailableReason(status(), false, null)).toMatch(/can’t do voice/i);
  });

  // THE 503 PATH, expressed as the thing the user actually sees.
  it('DISABLES WITH A REASON when the server has no key — never silently hides', () => {
    const r = unavailableReason(status({ configured: false }), true, null);
    expect(r).toMatch(/isn’t set up/i);
    expect(r).toMatch(/OpenAI key/i);
  });

  it('explains an exhausted cap', () => {
    expect(unavailableReason(status({ capMinutes: 60, minutesToday: 60 }), true, 0)).toMatch(
      /cap/i,
    );
  });

  it('does NOT disable when the status endpoint is simply unreachable', () => {
    // A failed side-channel must not gate the feature — the session POST is
    // the real door, and it answers for itself.
    expect(unavailableReason(null, true, null)).toBeNull();
  });

  it('reports the browser problem first — it is the one the user cannot fix here', () => {
    expect(unavailableReason(status({ configured: false }), false, 0)).toMatch(/can’t do voice/i);
  });
});
