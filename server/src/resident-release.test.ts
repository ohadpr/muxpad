import type { MuxpadEvent } from '@muxpad/shared';
// The one-time release that dismantles the retired "resident pane" primitive
// on existing installs. The contract that matters: NOTHING the user made is
// ever destroyed — panes, tabs and transcripts survive; they just move
// somewhere the sidebar shows.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { releaseResidentPane } from './resident-release.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

const SYSTEM = '· system ·';

/** An install as the retired primitive left it: a hidden system workspace
 *  holding a tab holding a real agent pane, plus the legacy globals. */
function legacyInstall(opts: { visibleWorkspace: boolean }) {
  const db = openDb(':memory:');
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const visible = opts.visibleWorkspace ? workspaces.create({ name: 'Work' }) : null;
  // Hidden workspaces are a LEGACY artifact — WorkspaceStore can no longer
  // create one — so build the pre-release shape the way a real old DB holds it.
  const sys = workspaces.create({ name: SYSTEM });
  db.prepare('UPDATE workspaces SET hidden = 1 WHERE id = ?').run(sys.id);
  sys.hidden = true;
  const tab = tabs.create({ name: 'chat', layout: '', workspace_id: sys.id });
  const pane = panes.create({
    tab_id: tab.id,
    shell: '/bin/zsh',
    cwd: '/tmp',
    startup_cmd: 'muxpad agent --mode do',
    face: 'chat',
    mode: 'do',
  });
  tabs.update(tab.id, { layout: pane.id });
  for (const k of ['ceo_pane_id', 'ceo_tab_id', 'ceo_mode_defaulted']) {
    db.prepare('INSERT INTO globals (key, value) VALUES (?, ?)').run(k, 'x');
  }
  return { db, workspaces, tabs, panes, visible, sys, tab, pane };
}

const globalsKeys = (db: Database.Database) =>
  (db.prepare('SELECT key FROM globals').all() as { key: string }[]).map((r) => r.key);

describe('resident-pane release', () => {
  it('moves the stranded tab into the first VISIBLE workspace', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    const res = releaseResidentPane({ db: f.db });
    expect(res.released).toBe(true);
    expect(res.movedTabIds).toEqual([f.tab.id]);
    expect(f.tabs.getWorkspaceId(f.tab.id)).toBe(f.visible!.id);
    // It is now an ordinary, listable tab.
    expect(f.tabs.listByWorkspace(f.visible!.id).map((t) => t.id)).toContain(f.tab.id);
  });

  it('stamps a rescued tab with activity so it does not sort to the very bottom', () => {
    // A tab that lived in the hidden container never had its activity touched,
    // so `last_activity_at` is NULL — and the living sidebar sorts NULL last.
    // A rescued chat with real history landing beneath every stale tab in the
    // workspace is the opposite of "here it is, we didn't lose it".
    const f = legacyInstall({ visibleWorkspace: true });
    // The NULL comes from the v21 migration, which added the column with no
    // backfill — every tab that predates it starts null, and the resident
    // container's tab is by definition an old one.
    f.db.prepare('UPDATE tabs SET last_activity_at = NULL WHERE id = ?').run(f.tab.id);
    expect(f.tabs.getById(f.tab.id)?.last_activity_at).toBeNull();
    releaseResidentPane({ db: f.db });
    expect(f.tabs.getById(f.tab.id)?.last_activity_at).toBeGreaterThan(0);
  });

  it('keeps a rescued tab’s existing recency rather than overwriting it', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    f.tabs.touchActivity(f.tab.id, 12345);
    releaseResidentPane({ db: f.db });
    expect(f.tabs.getById(f.tab.id)?.last_activity_at).toBe(12345);
  });

  it('never destroys the pane, its history pointer, or its mode', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    releaseResidentPane({ db: f.db });
    const pane = f.panes.getById(f.pane.id);
    expect(pane).not.toBeNull();
    expect(pane?.startup_cmd).toBe('muxpad agent --mode do');
    expect(pane?.mode).toBe('do');
    expect(pane?.tab_id).toBe(f.tab.id);
  });

  it('retires the emptied system workspace — but only after the tabs left it', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    releaseResidentPane({ db: f.db });
    expect(f.workspaces.getById(f.sys.id)).toBeNull();
    // The delete cannot have cascaded into the pane: it moved out first.
    expect(f.panes.getById(f.pane.id)).not.toBeNull();
  });

  it('runs ONCE — a workspace the user re-hides is never dragged out again', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    expect(releaseResidentPane({ db: f.db }).released).toBe(true);
    // The user deliberately rebuilds a hidden container and parks a tab there.
    const again = f.workspaces.create({ name: SYSTEM });
    f.db.prepare('UPDATE workspaces SET hidden = 1 WHERE id = ?').run(again.id);
    f.tabs.setWorkspace(f.tab.id, again.id);
    const second = releaseResidentPane({ db: f.db });
    expect(second.released).toBe(false);
    expect(f.tabs.getWorkspaceId(f.tab.id)).toBe(again.id);
  });

  it('clears the retired primitive’s globals pointers', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    releaseResidentPane({ db: f.db });
    const keys = globalsKeys(f.db);
    expect(keys).not.toContain('ceo_pane_id');
    expect(keys).not.toContain('ceo_tab_id');
    expect(keys).not.toContain('ceo_mode_defaulted');
    expect(keys).toContain('resident_pane_released');
  });

  it('surfaces the container in place when there is nowhere to move to', () => {
    // Degenerate install: the hidden workspace is the only one. Inventing a
    // workspace and shuffling rows buys nothing over just showing this one.
    const f = legacyInstall({ visibleWorkspace: false });
    const res = releaseResidentPane({ db: f.db });
    expect(res.released).toBe(true);
    expect(res.unhiddenWorkspaceId).toBe(f.sys.id);
    const ws = f.workspaces.getById(f.sys.id);
    expect(ws).not.toBeNull();
    expect(ws?.hidden).toBe(false);
    // Renamed off the plumbing label the user should never have to read.
    expect(ws?.name).not.toBe(SYSTEM);
    // The tab stayed put, and the pane is intact.
    expect(f.tabs.getWorkspaceId(f.tab.id)).toBe(f.sys.id);
    expect(f.panes.getById(f.pane.id)).not.toBeNull();
  });

  it('is a no-op on a fresh install, and still marks itself done', () => {
    const db = openDb(':memory:');
    new WorkspaceStore(db).create({ name: 'Work' });
    const res = releaseResidentPane({ db });
    expect(res).toEqual({ released: false, movedTabIds: [] });
    expect(globalsKeys(db)).toContain('resident_pane_released');
  });

  it('moves EVERY stranded tab, not just the one the primitive created', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    const extra = f.tabs.create({ name: 'stray', layout: '', workspace_id: f.sys.id });
    const res = releaseResidentPane({ db: f.db });
    expect(res.movedTabIds).toHaveLength(2);
    expect(f.tabs.getWorkspaceId(extra.id)).toBe(f.visible!.id);
  });

  it('announces the move so open sidebars re-read their lists', () => {
    const f = legacyInstall({ visibleWorkspace: true });
    const events = new EventBus();
    const seen: MuxpadEvent[] = [];
    events.subscribe((e) => seen.push(e));
    releaseResidentPane({ db: f.db, events });
    expect(seen.some((e) => e.type === 'workspace.removed')).toBe(true);
    expect(seen.some((e) => e.type === 'tab.added' && e.tab.id === f.tab.id)).toBe(true);
  });
});
