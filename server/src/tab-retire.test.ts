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
    panes.setUnread(child.pane, true); // turn-done bolds it "done, unreviewed"

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
