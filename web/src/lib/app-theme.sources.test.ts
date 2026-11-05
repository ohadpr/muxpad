import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ── THREE READERS OF ONE VALUE, AND WHICH ONE WINS ───────────────────────
 *
 * The install's theme reaches a window by three asynchronous routes — the boot
 * prefetch, a `prefs.updated` push, and a refetch after a reconnect — and both
 * of the ways that goes wrong were real:
 *
 *   · the boot request (1.5s wait budget) answers LATE and overwrites a theme
 *     somebody picked while it was in flight;
 *   · the push is fire-and-forget and replays nothing, so a window whose
 *     socket was down during the pick never learns the new theme at all.
 *
 * Both are ordering, not fetching, so they are tested here against the module
 * that owns the order rather than through a mounted app.
 */

const getPrefs = vi.fn<() => Promise<{ prefs: Record<string, string> }>>();
vi.mock('../api', () => ({ api: { prefs: () => getPrefs() } }));

let applied: (string | null)[] = [];
vi.mock('../settings', async (orig) => {
  const real = await orig<typeof import('../settings')>();
  return {
    ...real,
    setServerTheme: (c: string | null) => {
      applied.push(c);
      real.setServerTheme(c as never);
    },
  };
});

async function load() {
  vi.resetModules();
  applied = [];
  return await import('./app-theme');
}

beforeEach(() => {
  getPrefs.mockReset();
});

describe('the theme’s sources are applied in issue order', () => {
  it('takes the boot snapshot when it is the only thing that has arrived', async () => {
    const t = await load();
    t.applyBootTheme('memphis');
    expect(applied).toEqual(['memphis']);
  });

  it('DROPS a boot snapshot that answers after a live value', async () => {
    const t = await load();
    getPrefs.mockResolvedValue({ prefs: { theme: 'riso' } });
    await t.refreshAppTheme();
    // The prefetch finally answers — with what the server said before the pick.
    t.applyBootTheme('memphis');
    expect(applied).toEqual(['riso']);
  });

  it('DROPS a refetch that was issued before a push it raced', async () => {
    const t = await load();
    let answer!: (v: { prefs: Record<string, string> }) => void;
    getPrefs.mockReturnValue(
      new Promise((res) => {
        answer = res;
      }),
    );
    const inFlight = t.refreshAppTheme();
    // The pick lands while the refetch is still out.
    t.applyPushedTheme('riso');
    answer({ prefs: { theme: 'memphis' } });
    await inFlight;
    expect(applied).toEqual(['riso']);
  });

  it('lets a push win however many have come before it', async () => {
    const t = await load();
    t.applyBootTheme('memphis');
    t.applyPushedTheme('riso');
    t.applyPushedTheme('tokyo-night');
    t.applyPushedTheme('memphis');
    expect(applied).toEqual(['memphis', 'riso', 'tokyo-night', 'memphis']);
  });

  it('keeps the palette on screen when the refetch fails', async () => {
    const t = await load();
    t.applyBootTheme('memphis');
    getPrefs.mockRejectedValue(new Error('offline'));
    await t.refreshAppTheme();
    expect(applied).toEqual(['memphis']);
  });

  it('applies the refetch when nothing newer has landed — the recovery case', async () => {
    const t = await load();
    t.applyBootTheme('memphis');
    getPrefs.mockResolvedValue({ prefs: { theme: 'riso' } });
    await t.refreshAppTheme();
    expect(applied).toEqual(['memphis', 'riso']);
  });
});

describe('a reconnect recovers the theme it missed', () => {
  it('refetches alongside the workspaces, not only on a reload', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8');
    const reconnect = src.slice(src.indexOf('subscribeReconnect('));
    expect(reconnect.slice(0, 400)).toContain('refreshAppTheme');
  });

  it('applies the boot payload through the guard, never straight to the document', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8');
    expect(src).toContain('applyBootTheme');
    // `setServerTheme` is the unguarded door: boot calling it directly is the
    // late-overwrite bug, whatever the ordering code says.
    expect(src).not.toMatch(/setServerTheme\(/);
  });
});
