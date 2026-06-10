import { describe, expect, it } from 'vitest';
import { INK_REPLAY_TAIL_BYTES, inkReplayPayload } from './ink-replay.js';

const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';

describe('inkReplayPayload', () => {
  it('returns small snapshot when no sync markers', () => {
    expect(inkReplayPayload('hello world')).toBe('hello world');
  });

  it('returns only the last complete sync block', () => {
    const snap = `${BEGIN}frame1${END}junk${BEGIN}frame2${END}tail`;
    expect(inkReplayPayload(snap)).toBe(`${BEGIN}frame2${END}`);
  });

  it('returns trailing partial block when the last frame is incomplete', () => {
    const snap = `${BEGIN}old${END}${BEGIN}partial`;
    expect(inkReplayPayload(snap)).toBe(`${BEGIN}partial`);
  });

  it('tails from the last clear-screen when no sync markers', () => {
    const snap = `old-scroll\x1b[2J\x1b[Hcurrent-screen`;
    expect(inkReplayPayload(snap)).toBe('\x1b[2J\x1b[Hcurrent-screen');
  });

  it('caps oversized non-sync replay', () => {
    const snap = 'x'.repeat(INK_REPLAY_TAIL_BYTES + 1000);
    expect(inkReplayPayload(snap).length).toBe(INK_REPLAY_TAIL_BYTES);
    expect(inkReplayPayload(snap)).toBe(snap.slice(-INK_REPLAY_TAIL_BYTES));
  });

  it('caps oversized partial sync blocks', () => {
    const snap = `${BEGIN}${'y'.repeat(INK_REPLAY_TAIL_BYTES + 500)}`;
    expect(inkReplayPayload(snap).length).toBe(INK_REPLAY_TAIL_BYTES);
  });
});
