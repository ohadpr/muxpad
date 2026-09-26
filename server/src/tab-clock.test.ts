import { CHAT_DECAY_MS, DAY_MS } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { runMigrations } from './store/migrations.js';
import {
  ChatClockSweeper,
  childrenOf,
  clockIndex,
  doneTabIds,
  hasDecayClock,
  isSubChat,
  resetChatClock,
  resolveTabClock,
  reviveChat,
} from './tab-clock.js';

describe('tab-clock', () => {
  let db: Database.Database;
  let tabs: TabStore;
  let panes: PaneStore;
  let workspaceId: string;

  /** A top-level chat whose clock started `daysAgo` days back. It gets an
   *  AGENT pane, because that is what makes a tab a chat — a tab you cannot
   *  send a message to has no clock at all (see `hasDecayClock`). */
  function chat(name: string, daysAgo: number, parent?: string): string {
    const t = tabs.create({
      name,
      layout: '',
      workspace_id: workspaceId,
      ...(parent ? { spawned_by: parent } : {}),
    });
    panes.create({ tab_id: t.id, startup_cmd: 'muxpad agent', face: 'chat' });
    tabs.resetClock(t.id, Date.now() - daysAgo * DAY_MS);
    return t.id;
  }

  /** A tab with no agent in it: a plain shell. Same row, same columns, nothing
   *  to send a message to. */
  function terminal(name: string, daysAgo: number): string {
    const t = tabs.create({ name, layout: '', workspace_id: workspaceId });
    panes.create({ tab_id: t.id, shell: '/bin/zsh' });
    tabs.resetClock(t.id, Date.now() - daysAgo * DAY_MS);
    return t.id;
  }

  const resolve = (id: string) => resolveTabClock(clockIndex(db), id, Date.now());

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tabs = new TabStore(db);
    panes = new PaneStore(db);
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  describe('a top-level chat decays', () => {
    it('is live with a full clock when new', () => {
      const { done, clock } = resolve(chat('a', 0));
      expect(done).toBe(false);
      expect(clock?.fill).toBeLessThan(0.001);
      expect(clock?.stopped).toBe(false);
    });

    it('is done once four days pass with no message', () => {
      const r = resolve(chat('a', 5));
      expect(r.done).toBe(true);
      expect(r.done_reason).toBe('decayed');
    });

    it('a message revives it and refills the clock', () => {
      const id = chat('a', 5);
      expect(resolve(id).done).toBe(true);
      resetChatClock(db, id);
      const after = resolve(id);
      expect(after.done).toBe(false);
      expect(after.clock?.fill).toBeLessThan(0.001);
    });

    it('pinning stops the clock, however old the chat is', () => {
      const id = chat('a', 40);
      tabs.setPinned(id, true);
      const { done, clock } = resolve(id);
      expect(done).toBe(false);
      expect(clock?.stopped).toBe(true);
      expect(clock?.expires_at).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // THE AMENDMENT. A sub-chat used to share its parent's clock. A real
  // 41-agent sidebar — every row READY, every one finished hours before,
  // none retired — killed that: a shared clock would have kept all 41 live
  // for four more days. A sub-chat is a piece of WORK, and it leaves when the
  // work lands.
  // ────────────────────────────────────────────────────────────────────────
  describe('a sub-chat has no clock — it retires on delivery', () => {
    it('publishes no clock at all, not a fresh one', () => {
      // `null` and "0% full" are different claims. Nothing about elapsed time
      // describes a sub-chat, and a chip that renders 0% is saying it does.
      const parent = chat('parent', 0);
      const child = chat('child', 0, parent);
      expect(resolve(child).clock).toBeNull();
      expect(resolve(parent).clock).not.toBeNull();
      expect(isSubChat(clockIndex(db), child)).toBe(true);
      expect(isSubChat(clockIndex(db), parent)).toBe(false);
    });

    it('never decays, however long the work takes', () => {
      // A sub-chat still running after a week is not stale, it is busy — and
      // a clock would retire it mid-sentence.
      const parent = chat('parent', 0);
      const child = chat('child', 30, parent);
      expect(resolve(child).done).toBe(false);
    });

    it('does NOT expire with its parent', () => {
      // The old rule, now wrong in the other direction too: the parent's clock
      // says nothing about whether this work is finished.
      const parent = chat('parent', 9);
      const child = chat('child', 9, parent);
      expect(resolve(parent).done).toBe(true);
      expect(resolve(child).done).toBe(false);
    });

    it('is done the moment it is marked delivered', () => {
      const parent = chat('parent', 0);
      const child = chat('child', 0, parent);
      tabs.retire(child, 'delivered');
      const r = resolve(child);
      expect(r.done).toBe(true);
      expect(r.done_reason).toBe('delivered');
      // Still there. Nothing is ever deleted — `done` is where it renders.
      expect(tabs.getById(child)?.spawned_by).toBe(parent);
    });

    it('a message revives it, and it is live again until it re-delivers', () => {
      const parent = chat('parent', 0);
      const child = chat('child', 0, parent);
      tabs.retire(child, 'delivered');
      resetChatClock(db, child);
      expect(resolve(child).done).toBe(false);
      expect(resolve(child).clock).toBeNull(); // still a sub-chat, still no clock
    });

    it('an orphan becomes a root and gets an ordinary clock', () => {
      // The parent is gone (no FK, by design), so there is nobody left to
      // deliver to — it decays like anything else rather than hanging live
      // forever waiting.
      const parent = chat('parent', 0);
      const child = chat('child', 0, parent);
      expect(resolve(child).clock).toBeNull();
      tabs.delete(parent);
      expect(resolve(child).clock).not.toBeNull();
      tabs.resetClock(child, Date.now() - 9 * DAY_MS);
      const after = resolve(child);
      expect(after.done).toBe(true);
      expect(after.done_reason).toBe('decayed');
    });

    it('an orphan starts its clock at the promotion, not at its birth', () => {
      // F5. The clock it inherits is `clock_started_at`, stamped when it was
      // created and never read since — a sub-chat's clock is not consulted.
      // So a worker born ten days ago was `decayed` the instant its parent
      // went away, mid-job, with a full tile and no announcement.
      //
      // Not a rare shape: `cron --new-tab` with close_when_done cascades the
      // tab away on every clean fire, and every pane carries MUXPAD_PANE_ID,
      // so an agent that runs `muxpad agent new` inside a cron tab leaves one
      // of these behind minutes later. It is the recurring-job pattern the
      // house notes recommend.
      const parent = chat('parent', 0);
      const child = chat('child', 10, parent);
      tabs.delete(parent);
      const after = resolve(child);
      expect(after.done).toBe(false);
      expect(after.clock?.fill).toBeLessThan(0.001);
    });

    it('promotes every orphan, not just the first', () => {
      const parent = chat('parent', 0);
      const kids = [chat('a', 10, parent), chat('b', 30, parent), chat('c', 5, parent)];
      tabs.delete(parent);
      for (const id of kids) expect(resolve(id).done, id).toBe(false);
    });

    it('does not un-retire an orphan that had already delivered', () => {
      // Its parent going away is not news about whether the work landed. The
      // clock is restarted (it is a root now and has to have one), but the
      // retirement outranks it, exactly as it does for any other chat.
      const parent = chat('parent', 0);
      const child = chat('child', 10, parent);
      tabs.retire(child, 'delivered');
      tabs.delete(parent);
      const after = resolve(child);
      expect(after.done).toBe(true);
      expect(after.done_reason).toBe('delivered');
    });

    it('a pinned sub-chat is never done, delivered or not', () => {
      const parent = chat('parent', 0);
      const child = chat('child', 0, parent);
      tabs.setPinned(child, true);
      tabs.retire(child, 'delivered');
      expect(resolve(child).done).toBe(false);
      expect(resolve(child).clock).toBeNull();
    });

    it('nests: a grandchild is a sub-chat too', () => {
      const root = chat('root', 0);
      const mid = chat('mid', 0, root);
      const leaf = chat('leaf', 30, mid);
      expect(resolve(leaf).clock).toBeNull();
      expect(resolve(leaf).done).toBe(false);
      expect(childrenOf(clockIndex(db), root)).toEqual([mid]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // F2. The clock's only exit is "send it a message". A terminal has no
  // inbox, so a terminal that decays is not resting, it is gone: nothing to
  // send, no unarchive button in the client, and pinning the only way back.
  // Three of the user's own long-lived terminals were on the casualty list.
  // ────────────────────────────────────────────────────────────────────────
  describe('a tab with no agent in it has no clock', () => {
    it('publishes no clock for a terminal, however old', () => {
      const id = terminal('shell', 40);
      expect(hasDecayClock(clockIndex(db), id)).toBe(false);
      expect(resolve(id).clock).toBeNull();
    });

    it('never decays — there is no message that would bring it back', () => {
      const id = terminal('Trayobot', 40);
      expect(resolve(id).done).toBe(false);
      expect(doneTabIds(clockIndex(db), Date.now()).has(id)).toBe(false);
    });

    it('a tab with no panes at all is not something you can message either', () => {
      const t = tabs.create({ name: 'empty', layout: '', workspace_id: workspaceId });
      tabs.resetClock(t.id, Date.now() - 40 * DAY_MS);
      expect(resolve(t.id).clock).toBeNull();
      expect(resolve(t.id).done).toBe(false);
    });

    it('is still ARCHIVABLE — an act is not a clock', () => {
      // The distinction the whole fix rests on. Pressing × on a terminal
      // should still file it away; what must not happen is it expiring
      // because nobody typed in it for four days.
      const id = terminal('shell', 0);
      tabs.retire(id, 'archived');
      const r = resolve(id);
      expect(r.done).toBe(true);
      expect(r.done_reason).toBe('archived');
      expect(r.clock).toBeNull();
    });

    it('gains a clock when an agent moves in, and loses it when one leaves', () => {
      // It is a property of the CONTENTS, so it moves. Closing the agent pane
      // stops the decay rather than freezing a stale answer — and the
      // direction that error falls in is "stays visible".
      const id = terminal('shell', 5);
      expect(resolve(id).done).toBe(false);
      const agent = panes.create({ tab_id: id, startup_cmd: 'muxpad agent', face: 'chat' });
      expect(resolve(id).done).toBe(true);
      panes.delete(agent.id);
      expect(resolve(id).done).toBe(false);
    });

    it('counts a pending `--pick` pane as an agent', () => {
      // The harness has not been chosen yet, but a message sent to it will be
      // delivered to whatever gets picked. It is a chat.
      const t = tabs.create({ name: 'pending', layout: '', workspace_id: workspaceId });
      panes.create({ tab_id: t.id, startup_cmd: 'muxpad agent --pick' });
      tabs.resetClock(t.id, Date.now() - 5 * DAY_MS);
      expect(resolve(t.id).done).toBe(true);
    });
  });

  describe('archiving', () => {
    it('makes a live chat done with its reason recorded', () => {
      const id = chat('a', 0);
      tabs.retire(id, 'archived');
      const r = resolve(id);
      expect(r.done).toBe(true);
      expect(r.done_reason).toBe('archived');
    });

    it('outranks the clock: an archived chat says archived, not decayed', () => {
      const id = chat('a', 9);
      tabs.retire(id, 'archived');
      expect(resolve(id).done_reason).toBe('archived');
    });

    it('keeps the original stamp when applied twice', () => {
      // A second turn-done on an already-delivered sub-chat must not re-date
      // it; the timestamp is what a done group sorts and labels by.
      const id = chat('a', 0);
      tabs.retire(id, 'archived', 1_000);
      expect(tabs.retire(id, 'delivered', 2_000)).toBe(false);
      expect(clockIndex(db).get(id)?.retired_at).toBe(1_000);
      expect(resolve(id).done_reason).toBe('archived');
    });

    it('reviveChat un-retires AND restarts the clock, in one act', () => {
      // Un-retiring alone would hand an archived chat back onto its expired
      // clock — done again on the very next read, so the undo would look like
      // it had silently failed.
      const id = chat('a', 9);
      tabs.retire(id, 'archived');
      expect(reviveChat(db, id)).toBe(true);
      const r = resolve(id);
      expect(r.done).toBe(false);
      expect(r.clock?.fill).toBeLessThan(0.001);
    });

    it('reviveChat reports an unknown tab rather than pretending', () => {
      expect(reviveChat(db, 'ghost')).toBe(false);
      expect(resetChatClock(db, 'ghost')).toEqual([]);
    });

    it('a pinned chat is never done, even archived', () => {
      const id = chat('a', 0);
      tabs.setPinned(id, true);
      tabs.retire(id, 'archived');
      expect(resolve(id).done).toBe(false);
    });
  });

  it('never reports an unknown tab as done', () => {
    // A tab deleted between a read and its decoration. Nothing should render
    // it; "still here" is the harmless direction to be wrong in.
    const r = resolve('ghost');
    expect(r.done).toBe(false);
    expect(r.clock).toBeNull();
  });

  it('a live chat publishes no done_reason', () => {
    expect(resolve(chat('a', 1)).done_reason).toBeUndefined();
  });

  describe('ChatClockSweeper', () => {
    it('announces nothing on the first pass, then each crossing exactly once', () => {
      const id = chat('a', 0);
      // Already done before the sweeper ever runs — a server restart four days
      // into a quiet chat. It must not be ANNOUNCED: it was already done in
      // every client's first fetch.
      chat('long-gone', 9);
      const announced: string[] = [];
      const sweeper = new ChatClockSweeper(db, (t, o) => {
        if (o.announce) announced.push(t);
      });
      const t0 = Date.now();

      expect(sweeper.tick(t0)).toEqual([]);
      expect(sweeper.tick(t0 + DAY_MS)).toEqual([]);
      expect(announced).toEqual([]);

      expect(sweeper.tick(t0 + CHAT_DECAY_MS)).toEqual([id]);
      expect(sweeper.tick(t0 + CHAT_DECAY_MS + 60_000)).toEqual([]);
      expect(announced).toEqual([id]);
    });

    it('still RECONCILES on the priming pass, it just does not announce', () => {
      // A chat that decayed while the server was down crossed just as truly as
      // one that crossed a minute ago — and its READY mark is just as stale,
      // with nobody ever going to open the tab that would clear it. The
      // handler runs; the event does not.
      const gone = chat('long-gone', 9);
      const seen: Array<{ id: string; announce: boolean }> = [];
      const sweeper = new ChatClockSweeper(db, (id, o) => seen.push({ id, announce: o.announce }));
      expect(sweeper.tick(Date.now())).toEqual([]); // nothing CROSSED, from a client's view
      expect(seen).toEqual([{ id: gone, announce: false }]);
    });

    it('announces with announce=true once it is running', () => {
      const id = chat('a', 0);
      const seen: Array<{ id: string; announce: boolean }> = [];
      const sweeper = new ChatClockSweeper(db, (t, o) =>
        seen.push({ id: t, announce: o.announce }),
      );
      const t0 = Date.now();
      sweeper.tick(t0);
      sweeper.tick(t0 + CHAT_DECAY_MS);
      expect(seen).toEqual([{ id, announce: true }]);
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

    it('never announces a sub-chat — it has no clock to run out', () => {
      const parent = chat('parent', 0);
      chat('child', 0, parent);
      const sweeper = new ChatClockSweeper(db, () => {});
      const t0 = Date.now();
      sweeper.tick(t0);
      expect(sweeper.tick(t0 + CHAT_DECAY_MS)).toEqual([parent]);
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

  it('doneTabIds returns every done chat in one pass', () => {
    const live = chat('live', 1);
    const decayed = chat('decayed', 9);
    const archived = chat('archived', 0);
    tabs.retire(archived, 'archived');
    const pinned = chat('pinned', 9);
    tabs.setPinned(pinned, true);
    const parent = chat('parent', 9);
    const delivered = chat('delivered', 0, parent);
    tabs.retire(delivered, 'delivered');
    chat('working', 0, parent); // a sub-chat still working stays live
    expect(doneTabIds(clockIndex(db), Date.now())).toEqual(
      new Set([decayed, archived, parent, delivered]),
    );
    expect(live).toBeTruthy();
  });
});
