import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from './db.js';
import { PaneStore } from './PaneStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';

describe('PaneStore', () => {
  let panes: PaneStore;
  let workspaces: WorkspaceStore;
  let workspaceId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    panes = new PaneStore(db);
    workspaces = new WorkspaceStore(db);
    workspaceId = workspaces.create({ name: 'W', layout: 'p1' }).id;
  });

  it('creates a pane with defaults', () => {
    const p = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    expect(p.startup_cmd).toBeNull();
    expect(p.env).toBeNull();
    expect(panes.getById(p.id)).toEqual(p);
  });

  it('creates a pane with startup_cmd and env', () => {
    const p = panes.create({
      workspace_id: workspaceId,
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
    const a = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    const b = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    const list = panes.listByWorkspace(workspaceId);
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('cascades on workspace delete', () => {
    const p = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    workspaces.delete(workspaceId);
    expect(panes.getById(p.id)).toBeNull();
  });

  it('deletes a pane', () => {
    const p = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    panes.delete(p.id);
    expect(panes.getById(p.id)).toBeNull();
  });
});
