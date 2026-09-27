import type { MuxpadEvent, Tab } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { runMigrations } from './store/migrations.js';
import { clockIndex, resolveTabClock } from './tab-clock.js';
import { ChatRetirer, clearReadyMarks, retireChat } from './tab-retire.js';

/**
 * The 41-agent sidebar, in a test. Every row READY, every one finished hours
 * earlier, none retired — because `ready` cleared only on opening a tab and
 * the user read the output as report files instead.
 */
describe('retiring a sub-chat when it delivers', () => {
  let db: Database.Database;
  let tabs: TabStore;
  let panes: PaneStore;
  let events: EventBus;
  let cache: PtydCache;
  let workspaceId: string;
  let blockedPanes: Set<string>;
  let deps: {
    db: Database.Database;
    cache: PtydCache;
    events: EventBus;
    blocked: (p: string) => boolean;
  };

  /** A chat with one agent pane, optionally spawned under `parent`. */
  function chat(name: string, parent?: string): { tab: string; pane: string } {
    const t = tabs.create({
      name,
      layout: '',
      workspace_id: workspaceId,
      ...(parent ? { spawned_by: parent } : {}),
    });
    const p = panes.create({ tab_id: t.id, shell: '/bin/zsh', cwd: '/tmp' });
    return { tab: t.id, pane: p.id };
  }

  const isDone = (id: string) => resolveTabClock(clockIndex(db), id, Date.now()).done;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tabs = new TabStore(db);
    panes = new PaneStore(db);
    events = new EventBus();
    cache = new PtydCache();
    blockedPanes = new Set();
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    deps = { db, cache, events, blocked: (p: string) => blockedPanes.has(p) };
  });

  it('retires the sub-chat and clears its READY the moment its turn ends', () => {
    const parent = chat('parent');
    const child = chat('child', parent.tab);
    // A mark left over from an EARLIER turn. Deliberately not "the one
    // turn-done is about to write": in production `setUnread` runs AFTER the
    // synchronous `emitTurn('done')` that lands here, so pre-setting it would
    // state the ordering backwards and hide the write that matters. That
    // sequence is driven for real in tab-retire.ws.test.ts.
    panes.setUnread(child.pane, true);

    expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(true);

    expect(isDone(child.tab)).toBe(true);
    expect(resolveTabClock(clockIndex(db), child.tab, Date.now()).done_reason).toBe('delivered');
    // The result reached the user as a card in the parent. The green dot on a
    // row that has left the live list is exactly the noise being removed.
    expect(panes.getById(child.pane)?.unread).toBe(false);
  });

  it('leaves a TOP-LEVEL chat alone when its turn ends', () => {
    // A conversation you are having does not end because the agent stopped
    // talking. It leaves on its clock, or when you archive it.
    const top = chat('top');
    panes.setUnread(top.pane, true);
    expect(new ChatRetirer(deps).onTurnEnded({ pane_id: top.pane, phase: 'done' })).toBe(false);
    expect(isDone(top.tab)).toBe(false);
    expect(panes.getById(top.pane)?.unread).toBe(true);
  });

  it('announces the retirement so the sidebar moves without a poll', () => {
    const parent = chat('parent');
    const child = chat('child', parent.tab);
    const seen: Tab[] = [];
    events.subscribe((e: MuxpadEvent) => {
      if (e.type === 'tab.updated') seen.push(e.tab);
    });
    new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' });
    expect(seen.at(-1)?.id).toBe(child.tab);
    expect(seen.at(-1)?.done).toBe(true);
    expect(seen.at(-1)?.done_reason).toBe('delivered');
  });

  it('subscribes to the live bus, so the wiring is the tested thing', () => {
    const parent = chat('parent');
    const child = chat('child', parent.tab);
    const retirer = new ChatRetirer(deps);
    retirer.start();
    events.emit({
      type: 'agent_turn',
      pane_id: child.pane,
      phase: 'done',
      sid: 'sid-1',
      backend: 'claude',
    });
    expect(isDone(child.tab)).toBe(true);
    retirer.stop();
  });

  it('ignores turn-START — only an ended turn can have delivered anything', () => {
    const parent = chat('parent');
    const child = chat('child', parent.tab);
    const retirer = new ChatRetirer(deps);
    retirer.start();
    events.emit({
      type: 'agent_turn',
      pane_id: child.pane,
      phase: 'start',
      sid: 'sid-1',
      backend: 'claude',
    });
    expect(isDone(child.tab)).toBe(false);
    retirer.stop();
  });

  // Cron's keep-list, which this reuses verbatim in intent: each of these
  // means the agent still has something FOR YOU that retiring would bury.
  describe('what holds a delivered sub-chat open', () => {
    it('a FATAL turn — a crashed run is what you want to look at', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'fatal' })).toBe(
        false,
      );
      expect(isDone(child.tab)).toBe(false);
    });

    it('a pending QUESTION — blocked on you is the opposite of delivered', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      blockedPanes.add(child.pane);
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(false);
      expect(isDone(child.tab)).toBe(false);
    });

    it('an ARTIFACT on the pane — it made you something', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      db.prepare(
        'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?,?,?,?,?)',
      ).run('a1', child.pane, 'image/png', '/tmp/x.png', Date.now());
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(false);
      expect(isDone(child.tab)).toBe(false);
    });

    it('LIVE BACKGROUND SUBAGENTS — the work it spawned outlives the turn', () => {
      // R2-3. A turn ends; the subagents it launched are still running. The
      // sub-chat retired anyway, and the row it left behind published
      // `done: true` alongside `status: 'working'` — the same roster that
      // holds this open is the one `getStatus` reads. The sidebar was saying
      // both things about one row at once.
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      cache.setSubagentCount(child.pane, 2);
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(false);
      expect(isDone(child.tab)).toBe(false);
      expect(cache.getStatus(child.pane, false)).toBe('working');

      // The last one finishes: now it has delivered, and the next turn end
      // retires it. (A runner reports the empty roster before turn-done on
      // the ordinary path; this is the same edge either way.)
      cache.setSubagentCount(child.pane, 0);
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(true);
      expect(isDone(child.tab)).toBe(true);
    });

    it('never publishes done and working together', () => {
      // The invariant behind the one above, stated on its own so it survives
      // a rewrite of the keep-list: whatever the reasons are, a row the
      // sidebar calls finished must not also be one it draws a spinner on.
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      cache.setSubagentCount(child.pane, 1);
      new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' });
      expect(isDone(child.tab) && cache.getStatus(child.pane, false) === 'working').toBe(false);
    });

    it('QUEUED work — let the LAST turn retire it', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      db.prepare(
        'INSERT INTO agent_queue (id, pane_id, seq, text, created_at) VALUES (?,?,?,?,?)',
      ).run('q1', child.pane, 1, 'and then this', Date.now());
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(false);
      expect(isDone(child.tab)).toBe(false);
      db.prepare('DELETE FROM agent_queue').run();
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(true);
      expect(isDone(child.tab)).toBe(true);
    });

    it('a SECOND PANE — one agent finishing says nothing about the others', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      panes.create({ tab_id: child.tab, shell: '/bin/zsh', cwd: '/tmp' });
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(false);
      expect(isDone(child.tab)).toBe(false);
    });

    it('PINNED — the universal override', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      tabs.setPinned(child.tab, true);
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: child.pane, phase: 'done' })).toBe(false);
      expect(isDone(child.tab)).toBe(false);
    });

    it('a vanished pane is a silent no-op', () => {
      expect(new ChatRetirer(deps).onTurnEnded({ pane_id: 'ghost', phase: 'done' })).toBe(false);
    });
  });

  /**
   * ── THE OTHER QUESTION THE SAME TURN-END ANSWERS ───────────────────────────
   *
   * "Is this worker finished?" and "should its row leave the live list?" are two
   * questions, and the keep-list answers both at once — which is why hanging the
   * spawn report off RETIREMENT would have missed the two cases that need it
   * most. A crashed worker and one that produced a file both keep their live
   * rows deliberately, and both have unambiguously stopped working.
   *
   * So `keepOpen` is split by WHY it holds the row, and the report rides the
   * finish rather than the retirement:
   *
   *   still working / not one unit of work  → neither. Nothing has happened yet.
   *   finished, but keep the row            → report, no retirement.
   *   finished, nothing holding it          → both.
   *
   * Retirement itself is byte-for-byte the same decision it was — every test
   * above still holds — which is the property this describe block exists to pin
   * alongside the new one.
   */
  describe('onFinished — the work has ended, whether or not the row leaves', () => {
    /** Run one turn-end and report what each half decided. */
    function turn(
      paneId: string,
      phase: 'done' | 'fatal',
    ): { retired: boolean; finished: Array<{ tabId: string; crashed: boolean }> } {
      const finished: Array<{ tabId: string; crashed: boolean }> = [];
      const retirer = new ChatRetirer({
        ...deps,
        onFinished: (tabId, _paneId, o) => finished.push({ tabId, crashed: o.crashed }),
      });
      const retired = retirer.onTurnEnded({ pane_id: paneId, phase });
      return { retired, finished };
    }

    it('fires alongside an ordinary retirement', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      const { retired, finished } = turn(child.pane, 'done');
      expect(retired).toBe(true);
      expect(finished).toEqual([{ tabId: child.tab, crashed: false }]);
    });

    it('FIRES FOR A CRASHED WORKER, which never retires', () => {
      // The case that decided the trigger. `keepOpen` holds a fatal run open
      // because a crashed run is what you want to look at — so a report hung off
      // retirement alone would be silent about exactly the failure the parent
      // most needs to hear about, and the card would spin forever.
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      const { retired, finished } = turn(child.pane, 'fatal');
      expect(retired).toBe(false);
      expect(finished).toEqual([{ tabId: child.tab, crashed: true }]);
    });

    it('fires for a worker held open by an ARTIFACT — it made you something', () => {
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      db.prepare(
        'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?,?,?,?,?)',
      ).run('a1', child.pane, 'image/png', '/tmp/x.png', Date.now());
      const { retired, finished } = turn(child.pane, 'done');
      expect(retired).toBe(false);
      expect(finished.map((f) => f.tabId)).toEqual([child.tab]);
    });

    it('stays silent while the worker still has work coming', () => {
      // Each of these means the agent is not finished, so there is nothing to
      // report on yet — and a report per intermediate turn is a model call per
      // intermediate turn.
      const parent = chat('parent');
      const blocked = chat('blocked', parent.tab);
      blockedPanes.add(blocked.pane);
      expect(turn(blocked.pane, 'done').finished).toEqual([]);

      const busy = chat('busy', parent.tab);
      cache.setSubagentCount(busy.pane, 1);
      expect(turn(busy.pane, 'done').finished).toEqual([]);

      const queued = chat('queued', parent.tab);
      db.prepare(
        'INSERT INTO agent_queue (id, pane_id, seq, text, created_at) VALUES (?,?,?,?,?)',
      ).run('q1', queued.pane, 1, 'and then this', Date.now());
      expect(turn(queued.pane, 'done').finished).toEqual([]);

      const split = chat('split', parent.tab);
      panes.create({ tab_id: split.tab, shell: '/bin/zsh', cwd: '/tmp' });
      expect(turn(split.pane, 'done').finished).toEqual([]);
    });

    it('reports a PINNED worker, which is finished but never retires', () => {
      // Pinning answers "does this row expire", not "did this work end". A
      // pinned worker whose card said nothing forever would be the original
      // complaint, reachable by one click of the pin.
      const parent = chat('parent');
      const child = chat('child', parent.tab);
      tabs.setPinned(child.tab, true);
      const { retired, finished } = turn(child.pane, 'done');
      expect(retired).toBe(false);
      expect(finished.map((f) => f.tabId)).toEqual([child.tab]);
    });

    it('stays silent for a TOP-LEVEL chat — it has no parent to report to', () => {
      const top = chat('top');
      expect(turn(top.pane, 'done').finished).toEqual([]);
    });
  });

  describe('clearReadyMarks — the ready expiry itself', () => {
    it('clears the tab mark and every pane mark, and says so', () => {
      const c = chat('x');
      const second = panes.create({ tab_id: c.tab, shell: '/bin/zsh', cwd: '/tmp' });
      tabs.setUnread(c.tab, true);
      panes.setUnread(c.pane, true);
      panes.setUnread(second.id, true);
      expect(clearReadyMarks(deps, c.tab)).toBe(true);
      expect(tabs.isUnread(c.tab)).toBe(false);
      expect(panes.getById(c.pane)?.unread).toBe(false);
      expect(panes.getById(second.id)?.unread).toBe(false);
      // Nothing left to clear → nothing claimed.
      expect(clearReadyMarks(deps, c.tab)).toBe(false);
    });

    it('emits a pane.updated per cleared pane, so other clients drop the bold', () => {
      const c = chat('x');
      panes.setUnread(c.pane, true);
      const seen: string[] = [];
      events.subscribe((e: MuxpadEvent) => {
        if (e.type === 'pane.updated') seen.push(e.pane.id);
      });
      clearReadyMarks(deps, c.tab);
      expect(seen).toEqual([c.pane]);
    });

    it('is a persisted write, not a rendering rule', () => {
      // `ready` is persisted so a result found while you were away survives a
      // restart — so the thing that ends it has to be persisted too, or the
      // flag sits in the database waiting to reappear.
      const c = chat('x');
      panes.setUnread(c.pane, true);
      clearReadyMarks(deps, c.tab);
      expect(
        (db.prepare('SELECT unread FROM panes WHERE id = ?').get(c.pane) as { unread: number })
          .unread,
      ).toBe(0);
    });
  });

  describe('retireChat — one door for both paths', () => {
    it('archiving clears ready too', () => {
      // Archiving is telling the system you are done with it; leaving it lit
      // green in the done group is the same noise by another route.
      const c = chat('x');
      tabs.setUnread(c.tab, true);
      panes.setUnread(c.pane, true);
      expect(retireChat(deps, c.tab, 'archived')).toBe(true);
      expect(isDone(c.tab)).toBe(true);
      expect(tabs.isUnread(c.tab)).toBe(false);
      expect(panes.getById(c.pane)?.unread).toBe(false);
    });

    it('still clears marks on an already-retired chat', () => {
      // A chat can be re-marked unread after it retired; a second pass is the
      // cheapest way to be right about that.
      const c = chat('x');
      retireChat(deps, c.tab, 'archived');
      panes.setUnread(c.pane, true);
      expect(retireChat(deps, c.tab, 'archived')).toBe(true);
      expect(panes.getById(c.pane)?.unread).toBe(false);
    });

    it('reports false when there was nothing to do', () => {
      const c = chat('x');
      retireChat(deps, c.tab, 'archived');
      expect(retireChat(deps, c.tab, 'archived')).toBe(false);
    });
  });
});
