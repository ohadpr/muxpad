import { describe, expect, it, afterEach, vi } from 'vitest';
import { createSafeClipboardProvider } from './safe-clipboard-provider';

const SYSTEM = 'c' as never; // ClipboardSelectionType.SYSTEM — const enum, value is 'c'

describe('createSafeClipboardProvider', () => {
  const original = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    vi.restoreAllMocks();
  });

  it('writeText does not throw when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const provider = createSafeClipboardProvider();
    await expect(provider.writeText(SYSTEM, 'hello')).resolves.toBeUndefined();
  });

  it('readText returns empty string when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const provider = createSafeClipboardProvider();
    await expect(provider.readText(SYSTEM)).resolves.toBe('');
  });

  it('writeText swallows a rejecting clipboard (permission denied)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const provider = createSafeClipboardProvider();
    await expect(provider.writeText(SYSTEM, 'hello')).resolves.toBeUndefined();
  });

  it('writeText delegates to navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const provider = createSafeClipboardProvider();
    await provider.writeText(SYSTEM, 'hello');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('readText delegates to navigator.clipboard when available', async () => {
    const readText = vi.fn().mockResolvedValue('clip');
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
    const provider = createSafeClipboardProvider();
    await expect(provider.readText(SYSTEM)).resolves.toBe('clip');
  });
});
