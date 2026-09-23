import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureViewportAnchor,
  proposedFitUsable,
  restoreViewportAnchor,
  withViewportAnchor,
} from './xterm-internals';

function write(term: Terminal, s: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(s, resolve);
  });
}

/** Public scrollToLine is a no-op without a DOM viewport; drive the buffer service. */
function patchHeadlessScroll(term: Terminal): void {
  const core = term as unknown as {
    _core: { _bufferService: { scrollLines: (n: number) => void } };
  };
  term.scrollToLine = (y: number) => {
    core._core._bufferService.scrollLines(y - term.buffer.active.viewportY);
  };
  term.scrollToBottom = () => {
    term.scrollToLine(term.buffer.active.baseY);
  };
}

function topText(term: Terminal): string {
  return term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true) ?? '';
}

describe('below-floor fit must not mutate the buffer (finding 1)', () => {
  let term: Terminal | undefined;

  afterEach(() => {
    term?.dispose();
    term = undefined;
  });

  it('a 10-col reflow of 1000 long lines evicts history — the floor check exists to skip that', async () => {
    term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    patchHeadlessScroll(term);
    await write(
      term,
      Array.from(
        { length: 1000 },
        (_, i) => `row${String(i).padStart(4, '0')} ${'x'.repeat(65)}\r\n`,
      ).join(''),
    );
    term.scrollToLine(400);
    expect(term.buffer.active.length).toBeGreaterThan(900);
    expect(topText(term).startsWith('row0400')).toBe(true);

    expect(proposedFitUsable({ cols: 10, rows: 24 })).toBe(false);

    // Unguarded resize is the bug: ring buffer hits the 1024 cap and coming
    // back to 80×24 leaves ~129 lines, jumped to the live bottom.
    term.resize(10, 24);
    term.resize(80, 24);
    expect(term.buffer.active.length).toBeLessThan(200);
  });

  it('skips the resize when the proposed grid is below the floor, so history survives', async () => {
    term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    patchHeadlessScroll(term);
    await write(
      term,
      Array.from(
        { length: 1000 },
        (_, i) => `row${String(i).padStart(4, '0')} ${'x'.repeat(65)}\r\n`,
      ).join(''),
    );
    term.scrollToLine(400);
    const beforeLen = term.buffer.active.length;
    const beforeTop = topText(term);

    const proposed = { cols: 10, rows: 24 };
    if (proposedFitUsable(proposed)) {
      withViewportAnchor(term, () => term!.resize(proposed.cols, proposed.rows));
    }

    expect(term.cols).toBe(80);
    expect(term.buffer.active.length).toBe(beforeLen);
    expect(term.buffer.active.viewportY).toBe(400);
    expect(topText(term)).toBe(beforeTop);
  });
});

describe('content-anchor restore across refit (finding 2)', () => {
  let term: Terminal | undefined;

  afterEach(() => {
    term?.dispose();
    term = undefined;
  });

  it('keeps row120 at the viewport top after an 80→40 wrap, for a shell (not just cursor)', async () => {
    term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    patchHeadlessScroll(term);
    await write(
      term,
      Array.from(
        { length: 200 },
        (_, i) => `row${String(i).padStart(3, '0')} ${'x'.repeat(i < 100 ? 65 : 5)}\r\n`,
      ).join(''),
    );
    term.scrollToLine(120);
    expect(topText(term).startsWith('row120')).toBe(true);

    withViewportAnchor(term, () => term!.resize(40, 24));

    expect(topText(term).startsWith('row120')).toBe(true);
  });

  it('keeps row100 at the viewport top after an 80×24→80×40 height change', async () => {
    term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    patchHeadlessScroll(term);
    await write(
      term,
      Array.from({ length: 200 }, (_, i) => `row${String(i).padStart(3, '0')}\r\n`).join(''),
    );
    term.scrollToLine(100);
    expect(topText(term).startsWith('row100')).toBe(true);

    withViewportAnchor(term, () => term!.resize(80, 40));

    expect(topText(term).startsWith('row100')).toBe(true);
  });

  it('stays pinned to the live prompt when the reader was already at the bottom', async () => {
    term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    patchHeadlessScroll(term);
    await write(
      term,
      Array.from({ length: 200 }, (_, i) => `row${String(i).padStart(3, '0')}\r\n`).join(''),
    );
    term.scrollToBottom();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

    withViewportAnchor(term, () => term!.resize(80, 40));

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  it('capture/restore is a no-op on the alternate screen', () => {
    const fake = {
      buffer: { active: { type: 'alternate', viewportY: 0, baseY: 0, getLine: () => undefined } },
      scrollToLine: () => undefined,
      scrollToBottom: () => undefined,
    };
    expect(captureViewportAnchor(fake as never)).toBeNull();
    expect(() => restoreViewportAnchor(fake as never, { kind: 'bottom' })).not.toThrow();
  });
});
