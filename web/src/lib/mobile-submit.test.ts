import { describe, expect, it } from 'vitest';
import { planSubmit } from './mobile-submit';

describe('planSubmit', () => {
  it('splits command text and the Enter into separate frames', () => {
    const { text, enter } = planSubmit('ls -la');
    expect(text).toBe('ls -la');
    expect(enter).toBe('\r');
  });

  // The bug this guards: text + CR in one frame is read as a paste by
  // Claude Code, so the CR becomes a literal newline and never submits. The
  // text frame must NOT carry a trailing CR.
  it('never appends the CR to the text frame', () => {
    const { text } = planSubmit('echo hi');
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/\r$/);
  });

  it('preserves embedded newlines in multi-line input without submitting them', () => {
    const { text, enter } = planSubmit('line one\nline two');
    expect(text).toBe('line one\nline two');
    expect(enter).toBe('\r');
  });

  it('empty submit sends a bare Enter and no text frame', () => {
    const { text, enter } = planSubmit('');
    expect(text).toBeNull();
    expect(enter).toBe('\r');
  });
});
