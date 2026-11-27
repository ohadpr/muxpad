import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { runMigrations } from './migrations.js';

describe('indexed corpus content marker', () => {
  it('backfills an existing database and tracks insert, move, command change and delete', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, { upTo: 60 });
      const tabs = new TabStore(db);
      const panes = new PaneStore(db);
      const ws = new WorkspaceStore(db).create({ name: 'W' });
      const a = tabs.create({ name: 'a', workspace_id: ws.id, layout: '' });
      const b = tabs.create({ name: 'b', workspace_id: ws.id, layout: '' });
      const pane = panes.create({ tab_id: a.id, startup_cmd: 'muxpad agent --backend=codex' });
      runMigrations(db);
      const marker = (id: string) =>
        (db.prepare('SELECT corpus_has_agent AS n FROM tabs WHERE id = ?').get(id) as { n: number })
          .n;
      expect(marker(a.id)).toBe(1);
      expect(marker(b.id)).toBe(0);
      panes.setTab(pane.id, b.id);
      expect([marker(a.id), marker(b.id)]).toEqual([0, 1]);
      db.prepare('UPDATE panes SET startup_cmd = NULL WHERE id = ?').run(pane.id);
      expect(marker(b.id)).toBe(0);
      db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?').run('muxpad agent', pane.id);
      const second = panes.create({ tab_id: b.id, startup_cmd: 'muxpad agent' });
      expect(marker(b.id)).toBe(1);
      panes.delete(pane.id);
      expect(marker(b.id)).toBe(1);
      panes.delete(second.id);
      expect(marker(b.id)).toBe(0);
    } finally {
      db.close();
    }
  });
});
