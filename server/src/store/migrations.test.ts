import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, runMigrations } from './migrations.js';

describe('migrations', () => {
  it('creates the v1 baseline tables on a fresh db', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['workspaces', 'tabs', 'panes', 'attachments', 'schema_version']),
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
    db.prepare('INSERT INTO panes (id, tab_id, shell, cwd, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'p1',
      't1',
      '/bin/sh',
      '/tmp',
      0,
    );
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

describe('migrations v19 — globals KV + hidden workspaces', () => {
  it('creates the globals table with key/value semantics', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO globals (key, value) VALUES ('ceo_pane_id', 'p1')").run();
    const row = db.prepare("SELECT value FROM globals WHERE key = 'ceo_pane_id'").get() as {
      value: string;
    };
    expect(row.value).toBe('p1');
    // key is the primary key — a second insert of the same key must fail.
    expect(() =>
      db.prepare("INSERT INTO globals (key, value) VALUES ('ceo_pane_id', 'p2')").run(),
    ).toThrow();
  });

  it('adds workspaces.hidden defaulting to 0', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    const row = db.prepare('SELECT hidden FROM workspaces WHERE id = ?').get('w1') as {
      hidden: number;
    };
    expect(row.hidden).toBe(0);
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
    const row = db.prepare('SELECT kind, url FROM panes WHERE id = ?').get('p1') as {
      kind: string;
      url: string | null;
    };
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
    const row = db.prepare('SELECT kind, url, shell, cwd FROM panes WHERE id = ?').get('p2') as {
      kind: string;
      url: string;
      shell: string | null;
      cwd: string | null;
    };
    expect(row).toEqual({
      kind: 'url',
      url: 'https://example.com',
      shell: null,
      cwd: null,
    });
  });

  it('v20: session_history exists, keyed by sid, with no pane FK', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // Insert with a pane_id that references no pane — must NOT be rejected:
    // history has to survive pane deletion, so there is deliberately no FK.
    db.prepare(
      `INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen)
       VALUES ('sid-1', 'ghost-pane', 'claude', '/tmp', 1, 2)`,
    ).run();
    const row = db.prepare('SELECT * FROM session_history WHERE sid = ?').get('sid-1') as {
      sid: string;
      pane_id: string;
    };
    expect(row.pane_id).toBe('ghost-pane');
    // sid is the primary key: a second insert of the same sid conflicts.
    expect(() => db.prepare('INSERT INTO session_history (sid) VALUES (?)').run('sid-1')).toThrow();
  });
});

describe('migrations v21 — agent modes + the living sidebar', () => {
  it('adds panes.mode defaulting to deep (= exactly the pre-migration behavior)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    runMigrations(db);
    // Insert with the PRE-v21 column set — a row written by old code must
    // still land on 'deep' rather than NULL or 'do'.
    db.prepare(
      `INSERT INTO panes (id, tab_id, shell, startup_cmd, cwd, env, created_at)
       VALUES ('p1', 't1', '/bin/zsh', 'muxpad agent', '/tmp', null, 0)`,
    ).run();
    const row = db.prepare('SELECT mode FROM panes WHERE id = ?').get('p1') as { mode: string };
    expect(row.mode).toBe('deep');
  });

  it('adds tabs.pinned defaulting to 0 and tabs.last_activity_at nullable (no backfill)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    // Pre-v21 insert shape: no pinned, no last_activity_at.
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 't', '""', 'w1', 0, 111, 111)`,
    ).run();
    const row = db.prepare('SELECT pinned, last_activity_at FROM tabs WHERE id = ?').get('t1') as {
      pinned: number;
      last_activity_at: number | null;
    };
    expect(row.pinned).toBe(0);
    // Deliberately NOT backfilled from created_at: "never observed" is a
    // real state and must stay distinguishable (it sorts last).
    expect(row.last_activity_at).toBeNull();
  });

  it('upgrades a REAL populated v20 database to v21 without data loss', () => {
    // A genuine v20 → v21 upgrade. This test used to run every migration
    // first and then insert rows, so it exercised a v21 database pretending
    // to be old — it could not have caught a broken v21 step at all. `upTo`
    // stops the walk at 20, so the rows below really are written against the
    // pre-v21 schema, and the second runMigrations is the upgrade under test.
    const db = new Database(':memory:');
    runMigrations(db, { upTo: 20 });
    expect(
      (
        db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as {
          version: number;
        }
      ).version,
    ).toBe(20);
    // The v21 columns must genuinely not exist yet, or the "upgrade" is fake.
    const colsBefore = (db.prepare('PRAGMA table_info(tabs)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(colsBefore).not.toContain('pinned');
    expect(colsBefore).not.toContain('last_activity_at');
    expect(
      (db.prepare('PRAGMA table_info(panes)').all() as { name: string }[]).map((c) => c.name),
    ).not.toContain('mode');

    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 'tslug', 'My Tab', '"p1"', 'w1', 3, 5, 6)`,
    ).run();
    db.prepare(
      `INSERT INTO panes (id, tab_id, shell, startup_cmd, cwd, created_at)
       VALUES ('p1', 't1', '/bin/zsh', 'muxpad agent', '/tmp', 7)`,
    ).run();

    runMigrations(db); // the upgrade

    const tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(tab.name).toBe('My Tab');
    expect(tab.slug).toBe('tslug');
    expect(tab.position).toBe(3);
    // Defaults land on the pre-existing row: pinned 0 (auto-sorted block),
    // last_activity_at NULL (never observed — deliberately not backfilled).
    expect(tab.pinned).toBe(0);
    expect(tab.last_activity_at).toBeNull();
    const pane = db.prepare('SELECT * FROM panes WHERE id = ?').get('p1') as Record<
      string,
      unknown
    >;
    expect(pane.startup_cmd).toBe('muxpad agent');
    expect(pane.mode).toBe('deep');

    // Idempotent: re-running on the now-current DB changes nothing.
    runMigrations(db);
    expect(db.prepare('SELECT * FROM tabs WHERE id = ?').get('t1')).toEqual(tab);
  });

  it('upgrades a REAL populated v21 database to v22, adding the cron tables', () => {
    // A genuine v21 → v22 upgrade: rows are written against the pre-cron
    // schema, and the second runMigrations is the step under test.
    const db = new Database(':memory:');
    runMigrations(db, { upTo: 21 });
    const tables = () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name);
    expect(tables()).not.toContain('crons');

    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'W', 0, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 'T', '""', 'w1', 0, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO panes (id, tab_id, kind, shell, startup_cmd, cwd, created_at)
       VALUES ('p1', 't1', 'shell', '/bin/zsh', 'muxpad agent', '/tmp', 1)`,
    ).run();

    runMigrations(db);
    expect(tables()).toContain('crons');
    expect(tables()).toContain('cron_runs');
    // Existing rows survive untouched.
    expect(db.prepare('SELECT name FROM tabs WHERE id = ?').get('t1')).toEqual({ name: 'T' });

    // A cron can be written and read with the documented defaults.
    db.prepare(
      `INSERT INTO crons (id, name, schedule, tz, prompt, target_kind, target_pane, next_due_at, created_at)
       VALUES ('c1', 'job', '0 9 * * *', 'UTC', 'go', 'pane', 'p1', 999, 1)`,
    ).run();
    const cron = db.prepare('SELECT * FROM crons WHERE id = ?').get('c1') as Record<
      string,
      unknown
    >;
    expect(cron.enabled).toBe(1);
    expect(cron.catchup).toBe('once');
    expect(cron.overlap).toBe('skip');
    expect(cron.on_context).toBe('fire');
    expect(cron.fail_streak).toBe(0);
    expect(cron.jitter_ms).toBe(0);

    // Deliberately NO foreign key on target_pane: deleting the pane must not
    // silently delete the schedule the user wrote (the scheduler disables it,
    // with a push), and the run history has to outlive the pane it ran in.
    db.prepare('DELETE FROM panes WHERE id = ?').run('p1');
    expect(db.prepare('SELECT id FROM crons WHERE id = ?').get('c1')).toEqual({ id: 'c1' });

    // Idempotent.
    runMigrations(db);
    expect(db.prepare('SELECT id FROM crons WHERE id = ?').get('c1')).toEqual({ id: 'c1' });
  });

  it('upgrades a REAL populated v22 database to v23, adding the apps registry', () => {
    const db = new Database(':memory:');
    runMigrations(db, { upTo: 22 });
    const tables = () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name);
    expect(tables()).not.toContain('apps');

    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'W', 0, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 'T', '""', 'w1', 0, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO panes (id, tab_id, kind, shell, startup_cmd, cwd, created_at)
       VALUES ('p1', 't1', 'shell', '/bin/zsh', 'muxpad serve --url http://127.0.0.1:1 -- ./start', '/tmp', 1)`,
    ).run();

    runMigrations(db);
    expect(tables()).toContain('apps');
    // Existing rows survive untouched.
    expect(db.prepare('SELECT name FROM tabs WHERE id = ?').get('t1')).toEqual({ name: 'T' });

    db.prepare(
      `INSERT INTO apps (id, slug, name, cwd, command, url, pane_id, created_at, updated_at)
       VALUES ('a1', 'notes', 'Notes', '/tmp', './start', 'http://127.0.0.1:1', 'p1', 1, 1)`,
    ).run();
    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get('a1') as Record<string, unknown>;
    expect(app.enabled).toBe(1);
    expect(app.autostart).toBe(1);

    // The slug is unique…
    expect(() =>
      db
        .prepare(
          `INSERT INTO apps (id, slug, name, cwd, command, url, created_at, updated_at)
           VALUES ('a2', 'notes', 'Dup', '/tmp', './start', 'http://127.0.0.1:2', 1, 1)`,
        )
        .run(),
    ).toThrow();
    // …and so is a NON-NULL pane_id (two apps must never claim one pty)…
    expect(() =>
      db
        .prepare(
          `INSERT INTO apps (id, slug, name, cwd, command, url, pane_id, created_at, updated_at)
           VALUES ('a3', 'other', 'Other', '/tmp', './start', 'http://127.0.0.1:3', 'p1', 1, 1)`,
        )
        .run(),
    ).toThrow();
    // …while any number of apps may sit unmaterialised.
    for (const [id, slug] of [
      ['a4', 'four'],
      ['a5', 'five'],
    ]) {
      db.prepare(
        `INSERT INTO apps (id, slug, name, cwd, command, url, created_at, updated_at)
         VALUES (?, ?, 'X', '/tmp', './start', 'http://127.0.0.1:9', 1, 1)`,
      ).run(id, slug);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM apps').get()).toEqual({ n: 3 });

    // Deliberately NO foreign key on pane_id: losing the pty must not silently
    // delete the app DEFINITION — the reconciler rebuilds the pane instead.
    db.prepare('DELETE FROM panes WHERE id = ?').run('p1');
    expect(db.prepare('SELECT id FROM apps WHERE id = ?').get('a1')).toEqual({ id: 'a1' });

    // Idempotent.
    runMigrations(db);
    expect(db.prepare('SELECT id FROM apps WHERE id = ?').get('a1')).toEqual({ id: 'a1' });
  });

  it('records the latest schema version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const v = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };
    expect(v.version).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(24);
  });
});

describe("migrations v24 — the nav row's second line", () => {
  const seedTab = (db: Database.Database) => {
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w-one', 'W', 0, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't-one', 'agent', 'p1', 'w1', 0, 1, 1)`,
    ).run();
  };

  it('adds the three columns with the right nullability', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedTab(db);
    const row = db.prepare('SELECT headline, headline_at, name_sticky FROM tabs').get() as {
      headline: string | null;
      headline_at: number | null;
      name_sticky: number;
    };
    // headline and its clock are NULLABLE with no backfill: "never summarised"
    // is a real, permanent state for any tab without an agent session, and an
    // empty string would be the different (and false) claim that we tried.
    expect(row.headline).toBeNull();
    expect(row.headline_at).toBeNull();
    // name_sticky backfills to 0 — the safe direction. A tab wrongly marked
    // not-sticky is re-stickied by renaming it once; a tab wrongly marked
    // sticky could never be auto-named again.
    expect(row.name_sticky).toBe(0);
  });

  it('backfills EXISTING tabs rather than failing on the NOT NULL default', () => {
    // Migrate to v23, write a tab the old way, then take the last step —
    // the case a real upgrade actually hits.
    const db = new Database(':memory:');
    runMigrations(db, { upTo: 23 });
    seedTab(db);
    runMigrations(db);
    expect(db.prepare('SELECT name_sticky FROM tabs WHERE id = ?').get('t1')).toEqual({
      name_sticky: 0,
    });
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedTab(db);
    db.prepare('UPDATE tabs SET headline = ?, name_sticky = 1 WHERE id = ?').run('a line', 't1');
    runMigrations(db);
    expect(db.prepare('SELECT headline, name_sticky FROM tabs WHERE id = ?').get('t1')).toEqual({
      headline: 'a line',
      name_sticky: 1,
    });
  });
});
