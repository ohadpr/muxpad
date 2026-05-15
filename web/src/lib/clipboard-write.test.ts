import { describe, expect, it, afterEach, vi } from 'vitest';
import { writeClipboard, readClipboard } from './clipboard-write';

describe('writeClipboard', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ok = await writeClipboard('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    const ok = await writeClipboard('fallback-text');
    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when navigator.clipboard.writeText rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    const ok = await writeClipboard('x');
    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when both paths fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn().mockReturnValue(false);
    const ok = await writeClipboard('x');
    expect(ok).toBe(false);
  });

  it('cleans up the temporary textarea even on failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    await writeClipboard('x');
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('readClipboard', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('returns clipboard text when available', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockResolvedValue('clip') },
      configurable: true,
    });
    expect(await readClipboard()).toBe('clip');
  });

  it('returns empty string when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    expect(await readClipboard()).toBe('');
  });
});
