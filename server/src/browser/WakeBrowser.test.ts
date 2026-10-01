import { describe, expect, it, vi } from 'vitest';
import type { BrowserAppState } from './BrowserApps.js';

vi.mock('./BrowserApps.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    ensureBrowserApp: vi.fn(async (profile: string) => ({
      slug: `browser-${profile}`,
      profile,
      viewerUrl: 'http://127.0.0.1:9599',
      cdpUrl: 'http://127.0.0.1:9499',
      state: 'started',
    })),
  };
});

const { wakeBrowser } = await import('./WakeBrowser.js');
const { ensureBrowserApp } = (await import('./BrowserApps.js')) as unknown as {
  ensureBrowserApp: ReturnType<typeof vi.fn>;
};

const deps = {} as never;
const noSleep = async () => {};

describe('starting a browser because somebody asked for it', () => {
  it('starts it and waits until it answers', async () => {
    let asked = 0;
    const r = await wakeBrowser({
      profile: 'shopping',
      deps,
      probe: async () => ++asked >= 3,
      sleep: noSleep,
    });
    expect(r.awake).toBe(true);
    expect(asked).toBe(3);
    expect(ensureBrowserApp).toHaveBeenCalled();
  });

  it('answers immediately when it was already up', async () => {
    let asked = 0;
    const r = await wakeBrowser({
      profile: 'shopping',
      deps,
      probe: async () => (asked++, true),
      sleep: noSleep,
    });
    expect(r.awake).toBe(true);
    expect(asked).toBe(1);
  });

  it('gives up rather than hanging, and says so', async () => {
    // A caller holding a request open forever is worse than an honest failure:
    // the person gets a spinner that never resolves instead of a page.
    let clock = 0;
    const r = await wakeBrowser({
      profile: 'shopping',
      deps,
      probe: async () => false,
      sleep: async () => {
        clock += 200;
      },
      now: () => clock,
      timeoutMs: 1000,
    });
    expect(r.awake).toBe(false);
    expect(r.state.profile).toBe('shopping');
  });

  it('hands back the state either way, so the caller can still proxy', async () => {
    const r = await wakeBrowser({
      profile: 'shopping',
      deps,
      probe: async () => false,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 20_000);
      })(),
    });
    expect(r.state.viewerUrl).toBe('http://127.0.0.1:9599');
  });
});
