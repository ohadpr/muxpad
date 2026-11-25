import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_ROUNDS,
  loadSpawnRounds,
  resetSpawnRoundsCache,
  spawnRoundsCacheSize,
} from './spawn-rounds';

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

  it('refreshes a lifecycle change inside the freshness window', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok({ kid: [{ id: 'r', ended_at: null }] }))
      .mockResolvedValueOnce(ok({ kid: [{ id: 'r', ended_at: 200 }] }));
    vi.stubGlobal('fetch', f);
    await loadSpawnRounds('p');
    const result = await loadSpawnRounds('p', true);
    expect(result.get('kid')?.[0]?.ended_at).toBe(200);
  });

  it('refreshes after a lifecycle change during an in-flight read', async () => {
    let finish!: (response: Response) => void;
    const f = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            finish = r;
          }),
      )
      .mockResolvedValueOnce(ok({ kid: [{ id: 'r', ended_at: 200 }] }));
    vi.stubGlobal('fetch', f);
    const first = loadSpawnRounds('p');
    const changed = loadSpawnRounds('p', true);
    finish(ok({ kid: [{ id: 'r', ended_at: null }] }));
    await first;
    expect((await changed).get('kid')?.[0]?.ended_at).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
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

  it('carries the CHILDREN on the map, as the corpus would have drawn them', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        rounds: {},
        children: [
          {
            id: 'ws',
            slug: 'ws',
            name: 'Work',
            tabs: [
              {
                id: 'kid',
                slug: 'kid',
                name: 'card-summary',
                layout: '',
                spawned_by: 'p',
                done: true,
                spawn_task: 'Audit the lane',
                spawn_report: 'whole',
                spawn_report_state: 'ok',
                spawn_report_at: 9,
              },
            ],
          },
        ],
      }),
    }));
    const answer = await loadSpawnRounds('p');
    const kid = answer.children?.[0];
    expect([kid?.tabId, kid?.parentId, kid?.task, kid?.done, kid?.report?.text]).toEqual([
      'kid',
      'p',
      'Audit the lane',
      true,
      'whole',
    ]);
  });

  it('an older server with no `children` leaves the cards to the corpus', async () => {
    vi.stubGlobal('fetch', async () => ok({ kid: [] }));
    expect((await loadSpawnRounds('p')).children).toBeUndefined();
  });

  // ONE ENTRY IS EVERY CHILD'S ROUNDS AND EVERY CHILD'S ROW — the 519-child
  // coordinator measured at 1.41 MB was a single one. Held per parent the
  // session had ever opened, with no eviction, that is a leak the 4 s TTL
  // does nothing about. Found by review.
  it('holds a bounded number of parents, newest kept', async () => {
    vi.stubGlobal('fetch', async () => ok({ kid: [] }));
    for (let i = 0; i < 40; i++) await loadSpawnRounds(`parent${i}`);
    expect(spawnRoundsCacheSize()).toBeLessThanOrEqual(12);
    // And the one you are on is still a cache HIT, not a re-ask.
    const f = vi.fn(async () => ok({ kid: [] }));
    vi.stubGlobal('fetch', f);
    await loadSpawnRounds('parent39');
    expect(f).not.toHaveBeenCalled();
  });
});
