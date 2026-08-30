import { describe, expect, it } from 'vitest';
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

describe('PtyScanner — plain-text URL extraction', () => {
  it('extracts a localhost URL printed on a line', () => {
    const ev = new PtyScanner().feed('  Local:   http://localhost:5173/\n');
    expect(ev.urls).toEqual(['http://localhost:5173/']);
  });

  it('strips trailing punctuation a URL picks up in prose', () => {
    const ev = new PtyScanner().feed('serving at http://127.0.0.1:3000.\n');
    expect(ev.urls).toEqual(['http://127.0.0.1:3000']);
  });

  it('extracts multiple URLs across lines in one chunk', () => {
    const ev = new PtyScanner().feed('a http://localhost:5173\nb http://localhost:8787\n');
    expect(ev.urls).toEqual(['http://localhost:5173', 'http://localhost:8787']);
  });

  it('strips ANSI color codes around a URL', () => {
    const ev = new PtyScanner().feed('\x1b[32mhttp://localhost:4000\x1b[0m\n');
    expect(ev.urls).toEqual(['http://localhost:4000']);
  });

  it('scans the final line even without a trailing newline (CR closes it)', () => {
    const ev = new PtyScanner().feed('progress http://localhost:9000\r');
    expect(ev.urls).toEqual(['http://localhost:9000']);
  });

  it('reassembles a URL split across two chunks', () => {
    const s = new PtyScanner();
    expect(s.feed('Local: http://localho').urls).toBeUndefined();
    expect(s.feed('st:5173/\n').urls).toEqual(['http://localhost:5173/']);
  });

  it('reports no urls for plain text', () => {
    expect(new PtyScanner().feed('just some normal output\n').urls).toBeUndefined();
  });
});

describe('PtyScanner — app-url marker (OSC 7771)', () => {
  it('parses a marker with url + label', () => {
    const ev = new PtyScanner().feed(
      '\x1b]7771;muxpad;app;url=http://localhost:5173;label=Web\x07',
    );
    expect(ev.markers).toEqual([{ url: 'http://localhost:5173', label: 'Web' }]);
  });

  it('parses a marker with url only', () => {
    const ev = new PtyScanner().feed('\x1b]7771;muxpad;app;url=http://localhost:5173\x07');
    expect(ev.markers).toEqual([{ url: 'http://localhost:5173' }]);
  });

  it('ignores an OSC 7771 missing the muxpad;app namespace', () => {
    const ev = new PtyScanner().feed('\x1b]7771;something;else\x07');
    expect(ev.markers).toBeUndefined();
  });

  it('a marker does not set a title and does not ring bell', () => {
    const ev = new PtyScanner().feed('\x1b]7771;muxpad;app;url=http://localhost:5173\x07');
    expect(ev.title).toBeUndefined();
    expect(ev.bel).toBe(false);
  });
});

describe('PtyScanner — memory bounds', () => {
  it('stays bounded on a 10MB stream with no newline', () => {
    const s = new PtyScanner();
    // 10MB of a single never-terminated line (the `yes`-style worst case).
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 10; i++) s.feed(chunk);
    // Reach into the private buffer to assert it never grew unbounded.
    const lineBuf = (s as unknown as { lineBuf: string }).lineBuf;
    expect(lineBuf.length).toBeLessThanOrEqual(2048);
  });

  it('stays bounded on a carriage-return progress bar (no LF)', () => {
    const s = new PtyScanner();
    for (let i = 0; i < 100000; i++) s.feed(`\rDownloading ${i}%`);
    const lineBuf = (s as unknown as { lineBuf: string }).lineBuf;
    expect(lineBuf.length).toBeLessThanOrEqual(2048);
  });
});
