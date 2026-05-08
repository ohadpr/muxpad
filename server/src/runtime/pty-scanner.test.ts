import { describe, it, expect } from 'vitest';
import { PtyScanner } from './pty-scanner.js';

describe('PtyScanner — bell detection', () => {
  it('detects a plain BEL', () => {
    expect(new PtyScanner().feed('hello\x07world').bel).toBe(true);
  });

  it('returns false when no BEL is present', () => {
    expect(new PtyScanner().feed('hello world').bel).toBe(false);
  });

  it('ignores BEL terminating an OSC string (xterm title set)', () => {
    expect(new PtyScanner().feed('\x1b]0;my title\x07').bel).toBe(false);
  });

  it('ignores BEL terminating OSC 7 (cwd report)', () => {
    expect(new PtyScanner().feed('\x1b]7;file:///some/path\x07').bel).toBe(false);
  });

  it('ignores BEL terminating OSC 52 (clipboard)', () => {
    expect(new PtyScanner().feed('\x1b]52;c;dGVzdA==\x07').bel).toBe(false);
  });

  it('ignores BEL terminating a DCS string', () => {
    expect(new PtyScanner().feed('\x1bP1;2;some payload\x07').bel).toBe(false);
  });

  it('detects a real BEL after an OSC sequence in the same chunk', () => {
    expect(new PtyScanner().feed('\x1b]0;title\x07ready\x07').bel).toBe(true);
  });

  it('correctly handles ST (ESC backslash) as OSC terminator', () => {
    expect(new PtyScanner().feed('\x1b]0;title\x1b\\bell:\x07').bel).toBe(true);
  });

  it('carries state across chunks split mid-OSC', () => {
    const s = new PtyScanner();
    expect(s.feed('\x1b]0;par').bel).toBe(false);
    expect(s.feed('tial title\x07').bel).toBe(false);
    expect(s.feed('now real:\x07').bel).toBe(true);
  });

  it('handles ESC followed by a non-string-introducer (e.g. CSI)', () => {
    expect(new PtyScanner().feed('\x1b[31mred\x1b[0m\x07').bel).toBe(true);
  });

  it('does not falsely flag on chatty title updates', () => {
    const s = new PtyScanner();
    for (let i = 0; i < 20; i++) {
      expect(s.feed('\x1b]0;~/some/dir\x07').bel).toBe(false);
    }
  });
});

describe('PtyScanner — title extraction', () => {
  it('extracts title from OSC 0 (set icon + title)', () => {
    expect(new PtyScanner().feed('\x1b]0;my window\x07').title).toBe('my window');
  });

  it('extracts title from OSC 1 (set icon)', () => {
    expect(new PtyScanner().feed('\x1b]1;short\x07').title).toBe('short');
  });

  it('extracts title from OSC 2 (set window title)', () => {
    expect(new PtyScanner().feed('\x1b]2;Just the title\x07').title).toBe('Just the title');
  });

  it('does not extract a title for OSC 7 (cwd)', () => {
    const result = new PtyScanner().feed('\x1b]7;file:///some/path\x07');
    expect(result.title).toBeUndefined();
  });

  it('does not extract a title for OSC 52 (clipboard)', () => {
    const result = new PtyScanner().feed('\x1b]52;c;dGVzdA==\x07');
    expect(result.title).toBeUndefined();
  });

  it('handles empty title payload', () => {
    expect(new PtyScanner().feed('\x1b]2;\x07').title).toBe('');
  });

  it('handles ST-terminated OSC titles', () => {
    expect(new PtyScanner().feed('\x1b]2;via ST\x1b\\').title).toBe('via ST');
  });

  it('returns the most recent title when multiple are emitted in one chunk', () => {
    const result = new PtyScanner().feed('\x1b]2;first\x07\x1b]2;second\x07');
    expect(result.title).toBe('second');
  });

  it('reassembles a title split across chunks', () => {
    const s = new PtyScanner();
    expect(s.feed('\x1b]2;hello, ').title).toBeUndefined();
    expect(s.feed('world\x07').title).toBe('hello, world');
  });

  it('does not return a title when the OSC is incomplete at chunk boundary', () => {
    const s = new PtyScanner();
    expect(s.feed('\x1b]2;in progress').title).toBeUndefined();
  });

  it('caps the OSC buffer so a malformed unterminated sequence cannot grow without bound', () => {
    const s = new PtyScanner();
    // Feed a giant in-progress OSC and never terminate it. Should not OOM.
    const big = 'x'.repeat(100_000);
    expect(s.feed(`\x1b]2;${big}`).title).toBeUndefined();
    // The state machine will accept the next BEL as a terminator and emit
    // whatever fits within the cap.
    const out = s.feed('\x07');
    expect(out.title).toBeDefined();
    expect(out.title!.length).toBeLessThanOrEqual(2048);
  });
});
