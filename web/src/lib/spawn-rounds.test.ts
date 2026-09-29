import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_ROUNDS, loadSpawnRounds, resetSpawnRoundsCache } from './spawn-rounds';

/**
 * One request per CONVERSATION, and never a blank log when it fails.
 */
describe('loadSpawnRounds', () => {
  const ok = (rounds: Record<string, unknown[]>) =>
    ({ ok: true, status: 200, json: async () => ({ rounds }) }) as Response;

  beforeEach(() => {
    resetSpawnRoundsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks once for a whole conversation and keys by child', async () => {
    let asked = '';
    const f = vi.fn(async (url: RequestInfo) => {
      asked = String(url);
      return ok({ kid: [{ id: 'r1', started_at: 100, ended_at: 200 }] });
    });
    vi.stubGlobal('fetch', f);
    const rounds = await loadSpawnRounds('parent');
    expect(rounds.get('kid')).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(asked).toContain('/api/tabs/parent/spawn-rounds');
  });

  it('coalesces concurrent callers into ONE request', async () => {
    // A conversation re-rendering while the first answer is in flight must not
    // ask again — the transcript memo rebuilds on every corpus patch.
    const f = vi.fn(async () => ok({ kid: [] }));
    vi.stubGlobal('fetch', f);
    await Promise.all([loadSpawnRounds('p'), loadSpawnRounds('p'), loadSpawnRounds('p')]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reuses a fresh answer rather than re-asking', async () => {
    const f = vi.fn(async () => ok({ kid: [] }));
    vi.stubGlobal('fetch', f);
    await loadSpawnRounds('p');
    await loadSpawnRounds('p');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('NEVER REJECTS — a failed request must not blank the log', async () => {
    // `spawnCards` falls back to the tab-level pair when it gets nothing, which
    // is exactly what shipped before rounds existed.
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await expect(loadSpawnRounds('p')).resolves.toEqual(NO_ROUNDS);
  });

  it('stops asking an older server that has no such route', async () => {
    // `text` as well as `json`: the api layer reads the error envelope off the
    // body, and a mock without it throws a TypeError that carries no status.
    const f = vi.fn(
      async () =>
        ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }) as Response,
    );
    vi.stubGlobal('fetch', f);
    expect(await loadSpawnRounds('p')).toEqual(NO_ROUNDS);
    expect(await loadSpawnRounds('other')).toEqual(NO_ROUNDS);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
