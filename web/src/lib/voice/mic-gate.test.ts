import { describe, expect, it } from 'vitest';
import { MIN_UTTERANCE_MS, MicGate, POST_PLAYBACK_GATE_MS } from './mic-gate';

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
