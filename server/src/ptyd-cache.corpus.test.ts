import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtydCache } from './ptyd-cache.js';

afterEach(() => vi.useRealTimers());

describe('bounded corpus runtime inventory', () => {
  it('reuses a fresh inventory across corpus requests', async () => {
    vi.useFakeTimers();
    const cache = new PtydCache();
    const read = vi.fn(async () => ['live']);
    await cache.refreshRuntimePanes(read);
    await cache.refreshRuntimePanes(read);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_001);
    await cache.refreshRuntimePanes(read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung read, starts no duplicate RPCs, and rejects its late answer', async () => {
    vi.useFakeTimers();
    const cache = new PtydCache();
    cache.setRuntimePanes(['known']);
    let finish!: (ids: string[]) => void;
    const read = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = cache.refreshRuntimePanes(read);
    await vi.advanceTimersByTimeAsync(301);
    await pending;
    expect(cache.livePaneIds()).toEqual(['known']);
    await cache.refreshRuntimePanes(read);
    expect(read).toHaveBeenCalledTimes(1);
    finish(['stale']);
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.livePaneIds()).toEqual(['known']);
  });

  it('keeps remote processes when a local reconnect replaces its own inventory', () => {
    const cache = new PtydCache();
    cache.setRuntimePanes(['remote', 'old-local']);
    cache.setLocalRuntimePanes(['old-local']);
    cache.setLocalRuntimePanes(['new-local']);
    expect(new Set(cache.livePaneIds())).toEqual(new Set(['remote', 'new-local']));
  });

  it('does not undo a newer local snapshot when a global read finishes', async () => {
    const cache = new PtydCache();
    cache.setRuntimePanes(['remote', 'old-local']);
    cache.setLocalRuntimePanes(['old-local']);
    let finish!: (ids: string[]) => void;
    const pending = cache.refreshRuntimePanes(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    cache.setLocalRuntimePanes(['new-local']);
    finish(['remote', 'old-local']);
    await pending;
    expect(new Set(cache.livePaneIds())).toEqual(new Set(['remote', 'new-local']));
  });
});
