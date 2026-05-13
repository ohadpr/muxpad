import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { WorkspaceStore } from './WorkspaceStore.js';

describe('WorkspaceStore', () => {
  let db: Database.Database;
  let store: WorkspaceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // The v5 migration auto-creates a "Default" workspace from any
    // pre-existing tabs. On a fresh in-memory DB there are no tabs,
    // so the table is empty here.
    db.prepare('DELETE FROM workspaces').run();
    store = new WorkspaceStore(db);
  });

  it('creates and retrieves a workspace with tab_count=0', () => {
    const w = store.create({ name: 'Project Alpha' });
    expect(w.slug).toMatch(/^[A-Za-z2-9]{8}$/);
    expect(w.tab_count).toBe(0);
    const fetched = store.getById(w.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Project Alpha');
    expect(fetched!.tab_count).toBe(0);
  });

  it('round-trips by slug', () => {
    const w = store.create({ name: 'X' });
    expect(store.getBySlug(w.slug)?.id).toBe(w.id);
  });

  it('lists workspaces sorted by position', () => {
    const a = store.create({ name: 'A' });
    const b = store.create({ name: 'B' });
    const c = store.create({ name: 'C' });
    expect(store.list().map((w) => w.id)).toEqual([a.id, b.id, c.id]);
  });

  it('reorders workspaces', () => {
    const a = store.create({ name: 'A' });
    const b = store.create({ name: 'B' });
    const c = store.create({ name: 'C' });
    store.reorder([c.id, a.id, b.id]);
    expect(store.list().map((w) => w.id)).toEqual([c.id, a.id, b.id]);
  });

  it('renames a workspace and bumps updated_at', async () => {
    const w = store.create({ name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(w.id, { name: 'A renamed' });
    expect(updated.name).toBe('A renamed');
    expect(updated.updated_at).toBeGreaterThan(w.updated_at);
  });

  it('throws when updating a missing workspace', () => {
    expect(() => store.update('nope', { name: 'x' })).toThrow();
  });

  it('deletes a workspace', () => {
    const w = store.create({ name: 'A' });
    store.delete(w.id);
    expect(store.getById(w.id)).toBeNull();
  });

  it('decorates with live tab_count from the tabs table', () => {
    const w = store.create({ name: 'A' });
    db.prepare(
      "INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run('t1', 'tslug1aa', 'Tab 1', '""', w.id, 1, 1, 0);
    expect(store.getById(w.id)!.tab_count).toBe(1);
    db.prepare(
      "INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run('t2', 'tslug2aa', 'Tab 2', '""', w.id, 2, 2, 1);
    expect(store.getById(w.id)!.tab_count).toBe(2);
  });
});
