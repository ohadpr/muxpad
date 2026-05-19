import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

describe('migrations', () => {
  it('creates the v1 baseline tables on a fresh db', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
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
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('w1', 'wslug1aa', 'W', 0, 0, 0);
    db.prepare(
      'INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('t1', 'tslug1aa', 'T', '"p1"', 'w1', 0, 0, 0);
    db.prepare(
      'INSERT INTO panes (id, tab_id, shell, cwd, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p1', 't1', '/bin/sh', '/tmp', 0);
    db.prepare("DELETE FROM tabs WHERE id = 't1'").run();
    const remaining = db.prepare('SELECT count(*) as c FROM panes').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('cascades tab deletion when workspace is deleted', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('w1', 'wslug1aa', 'W', 0, 0, 0);
    db.prepare(
      'INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('t1', 'tslug1aa', 'T', '""', 'w1', 0, 0, 0);
    db.prepare("DELETE FROM workspaces WHERE id = 'w1'").run();
    const remaining = db.prepare('SELECT count(*) as c FROM tabs').get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe('migrations v6 — url panes', () => {
  it('adds kind defaulting to shell and a nullable url column', () => {
    const db = new Database(':memory:');
    // better-sqlite3 enables FKs by default; disable so we can test the
    // pane row in isolation without inserting prereq workspace/tab rows.
    db.pragma('foreign_keys = OFF');
    runMigrations(db);
    // Insert a row using the legacy shape (no kind/url). The default
    // should fill kind=shell.
    db.prepare(
      `INSERT INTO panes (id, tab_id, shell, startup_cmd, cwd, env, created_at)
       VALUES ('p1', 't1', '/bin/zsh', null, '/tmp', null, 0)`,
    ).run();
    const row = db
      .prepare('SELECT kind, url FROM panes WHERE id = ?')
      .get('p1') as { kind: string; url: string | null };
    expect(row.kind).toBe('shell');
    expect(row.url).toBeNull();
  });

  it('allows kind=url with a url and null shell/cwd', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Required: tabs row first because of FK; same for workspace.
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 't', '', 'w1', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO panes (id, tab_id, kind, url, shell, cwd, created_at)
       VALUES ('p2', 't1', 'url', 'https://example.com', null, null, 0)`,
    ).run();
    const row = db
      .prepare('SELECT kind, url, shell, cwd FROM panes WHERE id = ?')
      .get('p2') as { kind: string; url: string; shell: string | null; cwd: string | null };
    expect(row).toEqual({
      kind: 'url',
      url: 'https://example.com',
      shell: null,
      cwd: null,
    });
  });
});
