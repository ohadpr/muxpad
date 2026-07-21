import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { runMigrations } from './migrations.js';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';

describe('PaneStore', () => {
  let panes: PaneStore;
  let tabs: TabStore;
  let tabId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    panes = new PaneStore(db);
    tabs = new TabStore(db);
    const workspaces = new WorkspaceStore(db);
    const ws = workspaces.create({ name: 'W' });
    tabId = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id }).id;
  });

  it('creates a pane with defaults', () => {
    const p = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' });
    expect(p.startup_cmd).toBeNull();
    expect(p.env).toBeNull();
    expect(panes.getById(p.id)).toEqual(p);
  });

  it('creates a pane with startup_cmd and env', () => {
    const p = panes.create({
      tab_id: tabId,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'claude',
      env: { FOO: 'bar' },
    });
    expect(p.startup_cmd).toBe('claude');
    expect(p.env).toEqual({ FOO: 'bar' });
    expect(panes.getById(p.id)?.env).toEqual({ FOO: 'bar' });
  });

  it('lists panes for a workspace in creation order', () => {
    const a = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' });
    const b = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' });
    const list = panes.listByTab(tabId);
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('cascades on tab delete', () => {
    const p = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' });
    tabs.delete(tabId);
    expect(panes.getById(p.id)).toBeNull();
  });

  it('deletes a pane', () => {
    const p = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' });
    panes.delete(p.id);
    expect(panes.getById(p.id)).toBeNull();
  });

  it('creates a kind=url pane with null shell/cwd', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // FK rows
    db.prepare(`INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w', 'w', 'w', 0, 0, 0)`).run();
    db.prepare(`INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t', 't', 't', '', 'w', 0, 0, 0)`).run();

    const store = new PaneStore(db);
    const pane = store.create({
      tab_id: 't',
      kind: 'url',
      url: 'https://example.com',
    });
    expect(pane.kind).toBe('url');
    expect(pane.url).toBe('https://example.com');
    expect(pane.shell).toBeNull();
    expect(pane.cwd).toBeNull();

    const read = store.getById(pane.id)!;
    expect(read.kind).toBe('url');
    expect(read.url).toBe('https://example.com');
  });

  it('updateKind flips shell → url, clearing shell/cwd/startup_cmd', () => {
    const p = panes.create({
      tab_id: tabId,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'claude',
    });
    panes.updateKind(p.id, { kind: 'url', url: null });
    const after = panes.getById(p.id)!;
    expect(after.kind).toBe('url');
    expect(after.url).toBeNull();
    expect(after.shell).toBeNull();
    expect(after.cwd).toBeNull();
    expect(after.startup_cmd).toBeNull();
  });

  it('updateKind flips url → shell with explicit shell/cwd', () => {
    const p = panes.create({ tab_id: tabId, kind: 'url', url: 'https://example.com' });
    panes.updateKind(p.id, { kind: 'shell', shell: '/bin/zsh', cwd: '/home/me' });
    const after = panes.getById(p.id)!;
    expect(after.kind).toBe('shell');
    expect(after.url).toBeNull();
    expect(after.shell).toBe('/bin/zsh');
    expect(after.cwd).toBe('/home/me');
    expect(after.startup_cmd).toBeNull();
  });

  it('listCwds returns only shell panes with a non-null cwd', () => {
    // shell pane with cwd → included
    const a = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp/a' });
    // shell pane with no cwd → excluded
    panes.create({ tab_id: tabId, shell: '/bin/zsh' });
    // url pane → excluded even though cwd is null anyway
    panes.create({ tab_id: tabId, kind: 'url', url: 'https://example.com' });
    // shell pane that gets a cwd later via updateCwd → included
    const c = panes.create({ tab_id: tabId, shell: '/bin/zsh' });
    panes.updateCwd(c.id, '/tmp/c');

    const list = panes.listCwds();
    const map = new Map(list.map((e) => [e.id, e.cwd]));
    expect(map.get(a.id)).toBe('/tmp/a');
    expect(map.get(c.id)).toBe('/tmp/c');
    expect(list).toHaveLength(2);
  });

  it('updates a pane url via updateUrl', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w', 'w', 'w', 0, 0, 0)`).run();
    db.prepare(`INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t', 't', 't', '', 'w', 0, 0, 0)`).run();
    const store = new PaneStore(db);
    const p = store.create({ tab_id: 't', kind: 'url', url: 'https://a' });
    store.updateUrl(p.id, 'https://b');
    expect(store.getById(p.id)!.url).toBe('https://b');
  });

  it('tracks the unread flag: defaults false, set and clear', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w', 'w', 'w', 0, 0, 0)`).run();
    db.prepare(`INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t', 't', 't', '', 'w', 0, 0, 0)`).run();
    const store = new PaneStore(db);
    const a = store.create({ tab_id: 't', shell: '/bin/zsh' });
    const b = store.create({ tab_id: 't', shell: '/bin/zsh' });

    // Defaults to not-unread.
    expect(store.getById(a.id)!.unread).toBe(false);

    // Set one → reflected in getById; the other stays clean.
    store.setUnread(a.id, true);
    expect(store.getById(a.id)!.unread).toBe(true);
    expect(store.getById(b.id)!.unread).toBe(false);

    // Clear.
    store.setUnread(a.id, false);
    expect(store.getById(a.id)!.unread).toBe(false);
  });
});
