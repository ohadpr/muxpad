import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSessionStore } from './AgentSessionStore.js';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { openDb } from './db.js';

describe('AgentSessionStore', () => {
  let agents: AgentSessionStore;
  let paneId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    agents = new AgentSessionStore(db);
    const panes = new PaneStore(db);
    const tabs = new TabStore(db);
    const workspaces = new WorkspaceStore(db);
    const ws = workspaces.create({ name: 'W' });
    const tabId = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id }).id;
    paneId = panes.create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' }).id;
  });

  it('registers a terminal-owned session seeded with the minted id', () => {
    const s = agents.register({ pane_id: paneId, cwd: '/tmp/x', session_id: 'sid-1' });
    expect(s.assistant).toBe('claude');
    expect(s.current_sid).toBe('sid-1');
    expect(s.lineage).toEqual(['sid-1']);
    expect(s.view_mode).toBe('terminal');
    expect(s.writer).toBe('tui');
    expect(agents.getByPane(paneId)?.id).toBe(s.id);
  });

  it('registers with an empty lineage when no id is minted', () => {
    const s = agents.register({ pane_id: paneId });
    expect(s.current_sid).toBeNull();
    expect(s.lineage).toEqual([]);
  });

  it('records a hook-reported id: sets current and grows the lineage', () => {
    agents.register({ pane_id: paneId, session_id: 'sid-1' });
    const s = agents.recordSessionId(paneId, 'sid-2');
    expect(s?.current_sid).toBe('sid-2');
    expect(s?.lineage).toEqual(['sid-1', 'sid-2']);
  });

  it('dedupes a repeated id in the lineage', () => {
    agents.register({ pane_id: paneId, session_id: 'sid-1' });
    agents.recordSessionId(paneId, 'sid-1');
    expect(agents.getByPane(paneId)?.lineage).toEqual(['sid-1']);
  });

  it('is a no-op for a pane with no registered session (out of scope)', () => {
    expect(agents.recordSessionId(paneId, 'whatever')).toBeNull();
  });

  it('re-launch in the same pane resets to a fresh session but keeps one row', () => {
    const first = agents.register({ pane_id: paneId, session_id: 'sid-1' });
    agents.recordSessionId(paneId, 'sid-2');
    const relaunch = agents.register({ pane_id: paneId, session_id: 'sid-3' });
    expect(relaunch.id).toBe(first.id); // same row (upsert by pane)
    expect(relaunch.lineage).toEqual(['sid-3']); // lineage reset
    expect(relaunch.current_sid).toBe('sid-3');
    expect(agents.list()).toHaveLength(1);
  });
});
