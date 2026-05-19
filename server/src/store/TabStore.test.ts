import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';

describe('TabStore', () => {
  let store: TabStore;
  let workspaceId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    store = new TabStore(db);
    const workspaces = new WorkspaceStore(db);
    workspaceId = workspaces.create({ name: 'W' }).id;
  });

  it('creates and retrieves a workspace', () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    expect(w.slug).toMatch(/^[A-Za-z2-9]{8}$/);
    expect(store.getById(w.id)).toEqual(w);
    expect(store.getBySlug(w.slug)).toEqual(w);
  });

  it('generates unique slugs across many workspaces', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const w = store.create({ name: `n${i}`, layout: 'p', workspace_id: workspaceId });
      slugs.add(w.slug);
    }
    expect(slugs.size).toBe(50);
  });

  it('lists workspaces sorted by position', () => {
    const a = store.create({ name: 'A', layout: 'pa', workspace_id: workspaceId });
    const b = store.create({ name: 'B', layout: 'pb', workspace_id: workspaceId });
    const list = store.list();
    // Insertion order = position order (a got 0, b got 1).
    expect(list.map((w) => w.id)).toEqual([a.id, b.id]);
  });

  it('reorders workspaces', () => {
    const a = store.create({ name: 'A', layout: 'pa', workspace_id: workspaceId });
    const b = store.create({ name: 'B', layout: 'pb', workspace_id: workspaceId });
    const c = store.create({ name: 'C', layout: 'pc', workspace_id: workspaceId });
    store.reorder([c.id, a.id, b.id]);
    expect(store.list().map((w) => w.id)).toEqual([c.id, a.id, b.id]);
  });

  it('updates layout and bumps updated_at', async () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(w.id, {
      layout: { direction: 'row', first: 'a', second: 'b' },
    });
    expect(updated.updated_at).toBeGreaterThan(w.updated_at);
    expect(updated.layout).toEqual({ direction: 'row', first: 'a', second: 'b' });
  });

  it('rejects update for missing workspace', () => {
    expect(() => store.update('nope', { name: 'x' })).toThrow();
  });

  it('deletes a workspace', () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    store.delete(w.id);
    expect(store.getById(w.id)).toBeNull();
  });

  it('returns workspace_id for a known tab', () => {
    const w = store.create({ name: 'X', layout: 'p', workspace_id: workspaceId });
    expect(store.getWorkspaceId(w.id)).toBe(workspaceId);
  });

  it('returns undefined for an unknown tab id', () => {
    expect(store.getWorkspaceId('does-not-exist')).toBeUndefined();
  });

  it('round-trips deeply nested layout JSON', () => {
    const layout = {
      direction: 'row' as const,
      splitPercentage: 40,
      first: { direction: 'column' as const, first: 'a', second: 'b' },
      second: 'c',
    };
    const w = store.create({ name: 'X', layout, workspace_id: workspaceId });
    expect(store.getById(w.id)?.layout).toEqual(layout);
  });
});
