import { describe, expect, it } from 'vitest';
import {
  MIN_CANCEL_UTTERANCE_MS,
  MIN_UTTERANCE_MS,
  MicGate,
  POST_PLAYBACK_GATE_MS,
} from './mic-gate';

const u = (startMs: number, endMs: number, text = 'something') => ({ startMs, endMs, text });

describe('minimum duration', () => {
  it('discards sub-300ms utterances — lip smacks, breath, echo fragments', () => {
    const g = new MicGate();
    expect(g.judge(u(1000, 1000 + MIN_UTTERANCE_MS - 1))).toBe('too-short');
  });

  it('accepts one at the threshold', () => {
    const g = new MicGate();
    expect(g.judge(u(1000, 1000 + MIN_UTTERANCE_MS))).toBe('accept');
  });

  it('applies even when the gate is down — a blip is noise in any room', () => {
    const g = new MicGate();
    g.disarm();
    expect(g.judge(u(0, 100))).toBe('too-short');
  });
});

describe('post-playback gate', () => {
  it('is armed for a window after the model stops producing transcript', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(g.isArmed(5100)).toBe(true);
    expect(g.isArmed(5000 + POST_PLAYBACK_GATE_MS - 1)).toBe(true);
    expect(g.isArmed(5000 + POST_PLAYBACK_GATE_MS)).toBe(false);
  });

  it('rejects a long utterance that starts inside the window — the phantom barge-in', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(g.judge(u(5100, 6500))).toBe('echo-gated');
  });

  it('accepts the same utterance once the window has passed', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(g.judge(u(5000 + POST_PLAYBACK_GATE_MS + 1, 7000))).toBe('accept');
  });

  it('takes the LATEST output as the reference, never an earlier one', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    g.observedOutput(9000);
    expect(g.isArmed(5900)).toBe(true);
    g.observedOutput(6000); // a late, out-of-order delta must not shorten it
    expect(g.isArmed(9100)).toBe(true);
  });

  it('DISARMS as soon as real speech gets through, so a genuine interruption is delayed at most once', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(g.judge(u(5100, 6500))).toBe('echo-gated');
    // Same instant, next utterance: still gated…
    expect(g.isArmed(5200)).toBe(true);
    // …until one clears it.
    expect(g.judge(u(5800, 7000))).toBe('accept');
    expect(g.isArmed(5200)).toBe(false);
  });

  it('resets clean', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    g.reset();
    expect(g.isArmed(5100)).toBe(false);
  });
});

describe('tunability', () => {
  it('honours custom windows', () => {
    const g = new MicGate({ postPlaybackMs: 50, minUtteranceMs: 10 });
    g.observedOutput(1000);
    expect(g.judge(u(1010, 1030))).toBe('echo-gated');
    expect(g.judge(u(1060, 1080))).toBe('accept');
  });
});

// ── THE UTTERANCE THE BACKSTOP EXISTS FOR ───────────────────────────────────
//
// Both filters were declining a bare spoken "stop". Measured off captured live
// sessions: a delta's span is a fixed 200ms quantum and a bare "stop" is ONE
// delta, so the 300ms floor rejected every one-word cancel deterministically —
// and cancelling OVER the model, which is how anyone cancels anything, starts
// inside the echo window by definition. Neither filter is loosened globally; a
// cancel-shaped utterance is judged on evidence its text supplies directly.

describe('a cancel-shaped utterance is judged on its text, not its length', () => {
  const cancel = { cancelShaped: true } as const;

  it('accepts a bare "stop" at the transcriber’s ONE-DELTA span of 200ms', () => {
    // THE MEASURED CASE. `end_ms - start_ms` on a live delta is a fixed 200ms
    // quantisation bucket (32/32 deltas across two captured sessions), and a
    // bare spoken "stop" — 525ms of real audio — arrives as exactly one delta.
    // So this span is what EVERY one-word cancel reports, and the 300ms floor
    // was rejecting all of them deterministically rather than occasionally.
    const g = new MicGate();
    expect(g.judge(u(1000, 1200, 'stop'))).toBe('too-short');
    expect(g.judge(u(1000, 1200, 'stop'), cancel)).toBe('accept');
  });

  it('still refuses a span smaller than one quantum — a degenerate segment', () => {
    // The floor that survives is not about how long "stop" takes to say; it is
    // about a span the transcriber cannot legitimately have produced.
    const g = new MicGate();
    expect(g.judge(u(1000, 1050, 'stop'), cancel)).toBe('too-short');
    expect(g.judge(u(1000, 1000, 'stop'), cancel)).toBe('too-short');
  });

  it('keeps the cancel floor below one quantum, or every bare cancel dies', () => {
    // A guard on the constant itself: at or above 200 this filter rejects
    // every single-delta utterance, which is every one-word cancel there is.
    expect(MIN_CANCEL_UTTERANCE_MS).toBeGreaterThan(0);
    expect(MIN_CANCEL_UTTERANCE_MS).toBeLessThan(200);
  });

  it('accepts a cancel spoken OVER the model when the model did not say it', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(g.judge(u(5100, 5600, 'stop'))).toBe('echo-gated');
    g.observedOutput(5000);
    expect(
      g.judge(u(5100, 5600, 'stop'), {
        cancelShaped: true,
        recentOutput: 'the next thing I would look at is the router file',
      }),
    ).toBe('accept');
  });

  it('refuses one the model demonstrably just said', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(
      g.judge(u(5100, 5600, 'stop'), { cancelShaped: true, recentOutput: 'should I stop?' }),
    ).toBe('echo-gated');
  });

  it('matches whole words — our own "Stopped." is not the user saying "stop"', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(
      g.judge(u(5100, 5600, 'stop'), {
        cancelShaped: true,
        recentOutput: 'Stopped. The agent has been interrupted.',
      }),
    ).toBe('accept');
  });

  it('does not consult the echo test at all once the window has passed', () => {
    const g = new MicGate();
    g.observedOutput(5000);
    expect(
      g.judge(u(9000, 9500, 'stop'), { cancelShaped: true, recentOutput: 'I will stop.' }),
    ).toBe('accept');
  });
});
