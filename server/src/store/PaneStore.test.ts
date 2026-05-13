import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from './db.js';
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
});
