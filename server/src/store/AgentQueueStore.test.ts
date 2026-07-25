import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentQueueStore } from './AgentQueueStore.js';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { openDb } from './db.js';

describe('AgentQueueStore', () => {
  let db: Database.Database;
  let queue: AgentQueueStore;
  let paneId: string;
  let otherPane: string;

  beforeEach(() => {
    db = openDb(':memory:');
    queue = new AgentQueueStore(db);
    const panes = new PaneStore(db);
    const tabs = new TabStore(db);
    const workspaces = new WorkspaceStore(db);
    const ws = workspaces.create({ name: 'W' });
    const tabId = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id }).id;
    paneId = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' }).id;
    otherPane = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' }).id;
  });

  it('enqueues and lists in order', () => {
    queue.enqueue(paneId, 'one');
    queue.enqueue(paneId, 'two');
    queue.enqueue(paneId, 'three');
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['one', 'two', 'three']);
    expect(queue.count(paneId)).toBe(3);
  });

  it('peek returns the oldest', () => {
    queue.enqueue(paneId, 'first');
    queue.enqueue(paneId, 'second');
    expect(queue.peek(paneId)?.text).toBe('first');
  });

  it('remove keeps the rest in order (no reshuffle)', () => {
    const a = queue.enqueue(paneId, 'a');
    queue.enqueue(paneId, 'b');
    queue.enqueue(paneId, 'c');
    expect(queue.remove(a.id, paneId)).toBe(true);
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['b', 'c']);
    // A new enqueue still lands at the end, not reusing the freed seq.
    queue.enqueue(paneId, 'd');
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['b', 'c', 'd']);
  });

  it('remove returns false for an unknown id', () => {
    expect(queue.remove('nope', paneId)).toBe(false);
  });

  it('remove is pane-scoped — cannot delete another pane’s message', () => {
    const mine = queue.enqueue(paneId, 'mine');
    // Passing the right id but the WRONG pane must not delete it.
    expect(queue.remove(mine.id, otherPane)).toBe(false);
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['mine']);
    // The owning pane can.
    expect(queue.remove(mine.id, paneId)).toBe(true);
    expect(queue.count(paneId)).toBe(0);
  });

  it('is scoped per pane', () => {
    queue.enqueue(paneId, 'mine');
    queue.enqueue(otherPane, 'theirs');
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['mine']);
    expect(queue.list(otherPane).map((r) => r.text)).toEqual(['theirs']);
  });

  it('clear empties a pane and returns the count', () => {
    queue.enqueue(paneId, 'a');
    queue.enqueue(paneId, 'b');
    queue.enqueue(otherPane, 'x');
    expect(queue.clear(paneId)).toBe(2);
    expect(queue.count(paneId)).toBe(0);
    expect(queue.count(otherPane)).toBe(1);
  });

  it('peek/count are empty for a fresh pane', () => {
    expect(queue.peek(paneId)).toBeUndefined();
    expect(queue.count(paneId)).toBe(0);
    expect(queue.list(paneId)).toEqual([]);
  });

  it('cascades away when the pane is deleted', () => {
    queue.enqueue(paneId, 'a');
    db.prepare('DELETE FROM panes WHERE id = ?').run(paneId);
    expect(queue.count(paneId)).toBe(0);
  });
});
