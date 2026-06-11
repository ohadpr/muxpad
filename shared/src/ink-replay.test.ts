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

  it('replays the last full-screen Ink frame, escape-aligned at the head', () => {
    // Two realistic synchronized full repaints (cursor-home + content).
    const home = '\x1b[H\x1b[2J';
    const frameA = `${BEGIN}${home}old prompt${END}`;
    const frameB = `${BEGIN}${home}new prompt ▌${END}`;
    const out = inkReplayPayload(`${frameA}between${frameB}`);
    expect(out).toBe(frameB);
    // Head is escape-aligned (begins with the sync-begin), so xterm doesn't
    // receive a truncated CSI; and only the current frame is replayed.
    expect(out.startsWith(BEGIN)).toBe(true);
    expect(out).not.toContain('old prompt');
  });

  it('CHARACTERIZES the known alt-screen limitation (mode-set before the marker is dropped)', () => {
    // A TUI enters the alt screen + mouse mode early, then later emits a synced
    // frame. The slice keeps only the last frame and DROPS the ?1049h / mouse
    // enables — so the replayed bytes assume modes the fresh xterm isn't in.
    // This documents the deferred behavior (see inkReplayPayload's doc); it is
    // acceptable because Claude/Ink runs on the NORMAL buffer (no ?1049h).
    const enterAlt = '\x1b[?1049h\x1b[?1000h';
    const frame = `${BEGIN}\x1b[Hmenu${END}`;
    const out = inkReplayPayload(`${enterAlt}scrollback${frame}`);
    expect(out).toBe(frame);
    expect(out).not.toContain('\x1b[?1049h'); // mode-set lost — known limitation
  });
});
