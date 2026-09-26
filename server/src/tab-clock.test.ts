import { CHAT_DECAY_MS, DAY_MS } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { runMigrations } from './store/migrations.js';
import {
  ChatClockSweeper,
  clockIndex,
  clockRoot,
  descendantsOf,
  doneTabIds,
  resetChatClock,
  resolveTabClock,
} from './tab-clock.js';

describe('tab-clock', () => {
  let db: Database.Database;
  let tabs: TabStore;
  let workspaceId: string;

  /** A tab with its clock stamped `daysAgo` days back. */
  function chat(name: string, daysAgo: number, parent?: string): string {
    const t = tabs.create({
      name,
      layout: '',
      workspace_id: workspaceId,
      ...(parent ? { spawned_by: parent } : {}),
    });
    tabs.resetClock(t.id, Date.now() - daysAgo * DAY_MS);
    return t.id;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tabs = new TabStore(db);
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  it('gives a brand-new chat a full clock', () => {
    const id = chat('a', 0);
    const { done, clock } = resolveTabClock(clockIndex(db), id, Date.now());
    expect(done).toBe(false);
    expect(clock.fill).toBeLessThan(0.001);
    expect(clock.stopped).toBe(false);
  });

  it('marks a chat done once four days pass with no message', () => {
    const id = chat('a', 5);
    expect(resolveTabClock(clockIndex(db), id, Date.now()).done).toBe(true);
  });

  it('a message revives a done chat and refills its clock', () => {
    const id = chat('a', 5);
    expect(resolveTabClock(clockIndex(db), id, Date.now()).done).toBe(true);
    resetChatClock(db, id);
    const after = resolveTabClock(clockIndex(db), id, Date.now());
    expect(after.done).toBe(false);
    expect(after.clock.fill).toBeLessThan(0.001);
  });

  it('pinning stops the clock, however old the chat is', () => {
    const id = chat('a', 40);
    tabs.setPinned(id, true);
    const { done, clock } = resolveTabClock(clockIndex(db), id, Date.now());
    expect(done).toBe(false);
    expect(clock.stopped).toBe(true);
    expect(clock.expires_at).toBeNull();
  });

  describe('a child shares its parent’s clock', () => {
    it('reads the parent’s age, not its own', () => {
      const parent = chat('parent', 3);
      const child = chat('child', 0, parent);
      const index = clockIndex(db);
      const p = resolveTabClock(index, parent, Date.now());
      const c = resolveTabClock(index, child, Date.now());
      expect(c.clock.started_at).toBe(p.clock.started_at);
      expect(c.clock.fill).toBeCloseTo(0.75, 3);
      expect(c.clock.last_day).toBe(true);
    });

    it('expires WITH the parent even when it is the newer chat', () => {
      // The rule this encodes: work spawned under a chat must not outlive it.
      // The child here was created moments ago and would be nowhere near
      // expiry on a clock of its own.
      const parent = chat('parent', 5);
      const child = chat('child', 0, parent);
      const index = clockIndex(db);
      expect(resolveTabClock(index, parent, Date.now()).done).toBe(true);
      expect(resolveTabClock(index, child, Date.now()).done).toBe(true);
    });

    it('resolves through a grandparent', () => {
      const root = chat('root', 5);
      const mid = chat('mid', 0, root);
      const leaf = chat('leaf', 0, mid);
      expect(clockRoot(clockIndex(db), leaf)?.id).toBe(root);
      expect(resolveTabClock(clockIndex(db), leaf, Date.now()).done).toBe(true);
    });

    it('a message to the CHILD revives the whole family', () => {
      // A shared clock has to be shared in both directions, or answering a
      // worker leaves the chat it belongs to expiring underneath you.
      const parent = chat('parent', 5);
      const child = chat('child', 5, parent);
      const touched = resetChatClock(db, child);
      expect(new Set(touched)).toEqual(new Set([parent, child]));
      const index = clockIndex(db);
      expect(resolveTabClock(index, parent, Date.now()).done).toBe(false);
      expect(resolveTabClock(index, child, Date.now()).done).toBe(false);
    });

    it('a pinned parent stops its children too', () => {
      const parent = chat('parent', 40);
      const child = chat('child', 40, parent);
      tabs.setPinned(parent, true);
      const c = resolveTabClock(clockIndex(db), child, Date.now());
      expect(c.done).toBe(false);
      expect(c.clock.stopped).toBe(true);
    });

    it('a pinned child opts itself out without pinning the parent', () => {
      const parent = chat('parent', 5);
      const child = chat('child', 5, parent);
      tabs.setPinned(child, true);
      const index = clockIndex(db);
      expect(resolveTabClock(index, child, Date.now()).done).toBe(false);
      expect(resolveTabClock(index, parent, Date.now()).done).toBe(true);
    });

    it('an orphan falls back to its own clock instead of vanishing', () => {
      // There is no FK: deleting a parent leaves the child holding a dangling
      // id. It becomes a root in its own right — reading the dangle as
      // "expired" would delete work by implication, which this model never
      // does.
      const parent = chat('parent', 5);
      const child = chat('child', 0, parent);
      tabs.delete(parent);
      const { done, clock } = resolveTabClock(clockIndex(db), child, Date.now());
      expect(done).toBe(false);
      expect(clock.fill).toBeLessThan(0.001);
    });

    it('survives a cycle instead of hanging', () => {
      // Unreachable through any route that exists (spawned_by is written once,
      // at creation) — but this runs on the sidebar's hot path, and a corrupt
      // row must not take the server with it.
      const a = chat('a', 0);
      const b = chat('b', 0, a);
      db.prepare('UPDATE tabs SET spawned_by = ? WHERE id = ?').run(b, a);
      expect(() => resolveTabClock(clockIndex(db), a, Date.now())).not.toThrow();
      expect(() => descendantsOf(clockIndex(db), a)).not.toThrow();
    });
  });

  it('never reports an unknown tab as done', () => {
    // A tab deleted between a read and its decoration. Nothing should render
    // it; "alive" is the harmless direction to be wrong in.
    expect(resolveTabClock(clockIndex(db), 'ghost', Date.now()).done).toBe(false);
  });

  it('resetChatClock reports nothing for an unknown tab', () => {
    expect(resetChatClock(db, 'ghost')).toEqual([]);
  });

  describe('ChatClockSweeper', () => {
    it('says nothing on the first pass, then announces each crossing once', () => {
      const id = chat('a', 0);
      // Already done before the sweeper ever runs — a server restart four days
      // into a quiet chat. The priming pass must swallow it: it was done in
      // the payload of every client's first fetch, so announcing it is a boot
      // burst that tells nobody anything.
      chat('long-gone', 9);
      const seen: string[] = [];
      const sweeper = new ChatClockSweeper(db, (t) => seen.push(t));
      const t0 = Date.now();

      // Priming pass, and a tick while the chat is still alive.
      expect(sweeper.tick(t0)).toEqual([]);
      expect(sweeper.tick(t0 + DAY_MS)).toEqual([]);
      expect(seen).toEqual([]);

      // It crosses — announced exactly once, however many ticks follow.
      expect(sweeper.tick(t0 + CHAT_DECAY_MS)).toEqual([id]);
      expect(sweeper.tick(t0 + CHAT_DECAY_MS + 60_000)).toEqual([]);
      expect(seen).toEqual([id]);
    });

    it('re-arms after a revival', () => {
      const id = chat('a', 0);
      const sweeper = new ChatClockSweeper(db, () => {});
      const t0 = Date.now();
      sweeper.tick(t0);
      expect(sweeper.tick(t0 + CHAT_DECAY_MS)).toEqual([id]);
      resetChatClock(db, id, t0 + CHAT_DECAY_MS);
      expect(sweeper.tick(t0 + CHAT_DECAY_MS + 1_000)).toEqual([]);
      expect(sweeper.tick(t0 + 2 * CHAT_DECAY_MS + 1_000)).toEqual([id]);
    });

    it('announces a child crossing alongside its parent', () => {
      const parent = chat('parent', 0);
      const child = chat('child', 0, parent);
      const sweeper = new ChatClockSweeper(db, () => {});
      const t0 = Date.now();
      sweeper.tick(t0);
      expect(new Set(sweeper.tick(t0 + CHAT_DECAY_MS))).toEqual(new Set([parent, child]));
    });

    it('keeps sweeping when one announcement throws', () => {
      chat('a', 0);
      chat('b', 0);
      const seen: string[] = [];
      let first = true;
      const sweeper = new ChatClockSweeper(db, (t) => {
        if (first) {
          first = false;
          throw new Error('emit blew up');
        }
        seen.push(t);
      });
      const t0 = Date.now();
      sweeper.tick(t0);
      expect(() => sweeper.tick(t0 + CHAT_DECAY_MS)).not.toThrow();
      expect(seen).toHaveLength(1);
    });
  });

  it('doneTabIds returns every expired chat in one pass', () => {
    const live = chat('live', 1);
    const dead = chat('dead', 9);
    const pinned = chat('pinned', 9);
    tabs.setPinned(pinned, true);
    expect(doneTabIds(clockIndex(db), Date.now())).toEqual(new Set([dead]));
    expect(live).toBeTruthy();
  });
});
