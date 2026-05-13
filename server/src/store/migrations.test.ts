import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

describe('migrations', () => {
  it('creates tables on a fresh db', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    // Post v5, the original "workspaces" table is renamed to `tabs` and a
    // new top-level `workspaces` parent table is created.
    expect(names).toEqual(
      expect.arrayContaining([
        'workspaces',
        'tabs',
        'panes',
        'attachments',
        'schema_version',
      ]),
    );
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('records the current schema version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBeGreaterThan(0);
  });

  it('cascades pane deletion when tab is deleted', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // After v5, the user-facing "tab" lives in the `tabs` table and panes
    // FK to it via `tab_id`.
    db.prepare(
      "INSERT INTO tabs (id, slug, name, layout, created_at, updated_at, position, workspace_id) VALUES ('t1', 't', 'T', '\"p1\"', 0, 0, 0, '')",
    ).run();
    db.prepare(
      "INSERT INTO panes (id, tab_id, shell, cwd, created_at) VALUES ('p1', 't1', '/bin/sh', '/tmp', 0)",
    ).run();
    db.prepare("DELETE FROM tabs WHERE id = 't1'").run();
    const remaining = db.prepare('SELECT count(*) as c FROM panes').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('migration v5 renames workspaces→tabs and folds existing rows into a Default workspace', () => {
    const db = new Database(':memory:');
    // Stand up the schema only up to v4 by hand so we can plant data
    // that v5 will need to migrate. Mirrors the SQL from v1-v4 verbatim.
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        layout      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE panes (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        shell         TEXT NOT NULL,
        startup_cmd   TEXT,
        cwd           TEXT NOT NULL,
        env           TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX panes_workspace_id ON panes(workspace_id);
      INSERT INTO schema_version (version) VALUES (1), (2), (3), (4);
      INSERT INTO workspaces (id, slug, name, layout, created_at, updated_at, position)
        VALUES ('w1', 'aaaa1111', 'Project Alpha', '"p1"', 1, 1, 0);
      INSERT INTO panes (id, workspace_id, shell, cwd, created_at)
        VALUES ('p1', 'w1', '/bin/sh', '/tmp', 1);
    `);

    runMigrations(db);

    // Pre-v5 workspace rows now live in `tabs`, still with their old ids.
    const tabs = db.prepare('SELECT * FROM tabs').all() as {
      id: string;
      workspace_id: string;
    }[];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe('w1');

    // Pane FK column was renamed.
    const panes = db.prepare('SELECT * FROM panes').all() as { tab_id: string }[];
    expect(panes).toHaveLength(1);
    expect(panes[0]?.tab_id).toBe('w1');

    // A single Default workspace exists and owns the migrated tab.
    const wsRows = db.prepare('SELECT * FROM workspaces').all() as {
      id: string;
      name: string;
    }[];
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0]?.name).toBe('Default');
    expect(tabs[0]?.workspace_id).toBe(wsRows[0]?.id);
  });
});
