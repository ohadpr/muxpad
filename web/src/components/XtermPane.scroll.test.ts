import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'XtermPane.tsx'), 'utf8');

function has(needle: string): boolean {
  return src.includes(needle);
}

describe('XtermPane wiring for the xterm hunt fixes', () => {
  it('uses last-known foreground so null decorations do not become a shell', () => {
    expect(has('stickyForegroundCmd')).toBe(true);
    expect(/foregroundCmdRef\.current = foregroundCmd\s*;/.test(src)).toBe(false);
  });

  it('preflights FitAddon dimensions before fit() so a tiny grid cannot evict history', () => {
    expect(has('proposedFitUsable')).toBe(true);
    expect(has('proposeDimensions()')).toBe(true);
  });

  it('restores the viewport by content on every refit, not only for cursor-agent', () => {
    expect(has('withViewportAnchor')).toBe(true);
    expect(
      /preserveScroll\s*=\s*\n?\s*isCursorAgentCmd\(foregroundCmdRef\.current\)/.test(src),
    ).toBe(false);
  });

  it('constructs xterm with a scrollback cap above the 1000-line default', () => {
    expect(has('DEFAULT_XTERM_SCROLLBACK')).toBe(true);
    expect(has('scrollback: DEFAULT_XTERM_SCROLLBACK')).toBe(true);
  });

  it('always consumes cursor buffer-path wheel events, including 0-line trackpad ticks', () => {
    expect(has('consumeCapturedWheel')).toBe(true);
    expect(has('customWheelAllowsXterm')).toBe(true);
    const captureStart = src.indexOf('const onWheelCapture');
    const capture = src.slice(captureStart, src.indexOf('attachCustomWheelEventHandler'));
    expect(captureStart).toBeGreaterThan(0);
    expect(/if\s*\(\s*scrollBufferWheel/.test(capture)).toBe(false);
  });

  it('re-checks mayDriveResize on queued wiggle returns', () => {
    expect(has('mayFireQueuedResize')).toBe(true);
  });

  it('treats font-size layout events as a forced metric invalidation', () => {
    expect(has('shouldSkipCursorUnchangedBox')).toBe(true);
    expect(/layout-changed'[\s\S]*force:\s*true/.test(src)).toBe(true);
  });

  it('refits a cursor pane on visibility when a fit was skipped while hidden', () => {
    expect(has('cursorShouldRefitOnVisibility')).toBe(true);
    expect(has('skippedFitWhileHidden')).toBe(true);
  });

  it('does not jump a mobile cursor pane to the bottom on activate', () => {
    const start = src.indexOf('its viewport while mounted');
    expect(start).toBeGreaterThan(0);
    const chunk = src.slice(start, start + 1400);
    expect(chunk.includes('scrollToBottom')).toBe(false);
  });

  it('aims touch SGR at the transcript band and handles End as a buffer jump', () => {
    expect(has('transcriptBandRow')).toBe(true);
    expect(has('bufferJumpForKey')).toBe(true);
  });
});
