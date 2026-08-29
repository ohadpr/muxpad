import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSessionStore } from './AgentSessionStore.js';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { openDb } from './db.js';

describe('AgentSessionStore', () => {
  let db: ReturnType<typeof openDb>;
  let agents: AgentSessionStore;
  let paneId: string;

  beforeEach(() => {
    db = openDb(':memory:');
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

  it('a resume relaunch (no session_id) keeps the existing sid and lineage', () => {
    // `muxpad claude --resume <sid>` registers WITHOUT a session_id (claude
    // rejects --session-id with --resume); the hook re-reports the id later.
    // The existing sid/lineage must survive that window.
    agents.register({ pane_id: paneId, session_id: 'sid-1' });
    agents.recordSessionId(paneId, 'sid-2');
    const relaunch = agents.register({ pane_id: paneId });
    expect(relaunch.current_sid).toBe('sid-2');
    expect(relaunch.lineage).toEqual(['sid-1', 'sid-2']);
    expect(relaunch.writer).toBe('tui'); // ownership still resets to the TUI
    expect(relaunch.view_mode).toBe('terminal');
  });

  it('tracks status and clears stale headless state on startup reconcile', () => {
    agents.register({ pane_id: paneId, session_id: 'sid-1' });
    agents.setWriter(paneId, 'headless');
    agents.setStatus(paneId, 'running');
    expect(agents.getByPane(paneId)?.status).toBe('running');
    // Simulates a restart mid-turn: the runner map died with the process.
    agents.reconcileStartup();
    const s = agents.getByPane(paneId);
    expect(s?.writer).toBe('none');
    expect(s?.status).toBe('idle');
  });

  describe('session_history (append-only registry)', () => {
    const history = (sid: string) =>
      db.prepare('SELECT * FROM session_history WHERE sid = ?').get(sid) as
        | {
            sid: string;
            pane_id: string | null;
            assistant: string | null;
            cwd: string | null;
            first_seen: number;
            last_seen: number;
          }
        | undefined;

    it('records every sid from register / recordSessionId / attachRunner', () => {
      agents.register({ pane_id: paneId, cwd: '/tmp/x', session_id: 'sid-1' });
      agents.recordSessionId(paneId, 'sid-2');
      agents.attachRunner({ pane_id: paneId, session_id: 'sid-3', assistant: 'codex' });
      expect(history('sid-1')?.pane_id).toBe(paneId);
      expect(history('sid-1')?.cwd).toBe('/tmp/x');
      expect(history('sid-2')?.pane_id).toBe(paneId);
      expect(history('sid-3')?.assistant).toBe('codex');
    });

    it('survives a lineage reset — old sids are never deleted', () => {
      agents.register({ pane_id: paneId, session_id: 'sid-1' });
      // Fresh launch resets agent_sessions.lineage to just sid-2…
      agents.register({ pane_id: paneId, session_id: 'sid-2' });
      expect(agents.getByPane(paneId)?.lineage).toEqual(['sid-2']);
      // …but the registry keeps both.
      expect(history('sid-1')).toBeDefined();
      expect(history('sid-2')).toBeDefined();
    });

    it('survives pane deletion (no FK cascade)', () => {
      agents.register({ pane_id: paneId, session_id: 'sid-1' });
      db.prepare('DELETE FROM panes WHERE id = ?').run(paneId);
      expect(agents.getByPane(paneId)).toBeNull(); // live row cascaded
      expect(history('sid-1')?.pane_id).toBe(paneId); // registry survives
    });

    it('upserts on sid: last_seen advances, first_seen and cwd stick', () => {
      agents.register({ pane_id: paneId, cwd: '/tmp/x', session_id: 'sid-1' });
      const first = history('sid-1');
      // Re-report with no cwd → cwd must not be wiped to null.
      agents.recordSessionId(paneId, 'sid-1');
      const second = history('sid-1');
      expect(second?.first_seen).toBe(first?.first_seen);
      expect(second?.cwd).toBe('/tmp/x');
      expect(second?.last_seen).toBeGreaterThanOrEqual(first?.last_seen ?? 0);
    });
  });
});
