import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, runMigrations } from './migrations.js';

/**
 * Everything that defines this database: the schema TEXT of every object, plus
 * every row of every table. The unit of comparison for "a second migration
 * pass is a no-op" — asserting that it didn't throw proves nothing about
 * whether it kept the data.
 *
 * Rows are ordered by their first column so the comparison can't be fooled (or
 * flaked) by SQLite's unordered scan.
 */
function fingerprint(db: Database.Database): unknown {
  const master = db
    .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const rows: Record<string, unknown[]> = {};
  for (const t of master.filter((m) => m.type === 'table')) {
    rows[t.name] = db.prepare(`SELECT * FROM "${t.name}" ORDER BY 1`).all();
  }
  return { master, rows };
}

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

  // "Did not throw" is the weakest possible reading of idempotent, and it is
  // the one the test above makes: a migration that dropped and recreated a
  // table on its second pass — losing every row — would sail through it. Two
  // of the migrations here DO rebuild tables (v6) and three rewrite existing
  // rows in place (v8, v14, v26), which is exactly the population where a
  // re-run can be silently destructive.
  //
  // So this one takes a full fingerprint — schema TEXT plus every row of every
  // table — of a genuinely OLD database that has been upgraded to head, then
  // migrates again and demands the fingerprint be unchanged.
  it('a second pass over an upgraded old database changes nothing at all', () => {
    const db = new Database(':memory:');
    // A v6-era database: before icons (v8), before the chat-face reset (v14),
    // before modes (v21) — so the upgrade walks every rewriting migration.
    runMigrations(db, { upTo: 6 });
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('w1', 'ws1', 'Work', 0, 1, 1);
    const tab = db.prepare(
      'INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    // A leading-emoji name (v8 lifts it into `icon`), a plain one (v8 invents
    // a RANDOM icon — non-deterministic on the FIRST pass, which is precisely
    // why the fingerprint is taken after it and not before).
    tab.run('t1', 'sl1', '🌐 Home', '"p1"', 'w1', 0, 1, 1);
    tab.run('t2', 'sl2', 'Notes', '"p2"', 'w1', 1, 1, 1);
    const pane = db.prepare(
      'INSERT INTO panes (id, tab_id, kind, shell, startup_cmd, cwd, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    pane.run('p1', 't1', 'shell', '/bin/zsh', 'muxpad agent --mode do --resume abc', '/tmp', 1);
    pane.run('p2', 't2', 'shell', '/bin/zsh', 'muxpad agent --mode deep', '/tmp', 1);
    pane.run('p3', 't2', 'shell', '/bin/zsh', null, '/tmp', 1);

    runMigrations(db);
    expect(
      (
        db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as {
          version: number;
        }
      ).version,
    ).toBe(LATEST_SCHEMA_VERSION);
    // The rebuild in v6 rewrites FK targets; a dangling one would survive
    // silently and only surface as a cascade that never fires.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    // The upgrade did its job before we pin it.
    //
    // Note which side wins, because it is not obvious and it is right: v21
    // gives every pre-existing row `mode = 'deep'`, v26 renames that to
    // 'agent', and v26 then rewrites startup_cmd to MATCH THE ROW — so the
    // `--mode do` this command was carrying is stripped rather than adopted.
    // For a database this old that is the only sound reading: modes did not
    // exist when these rows were written, so a flag in the command is noise
    // from a later hand-edit and the row is the authority.
    expect(db.prepare('SELECT mode, startup_cmd FROM panes WHERE id = ?').get('p1')).toEqual({
      mode: 'agent',
      startup_cmd: 'muxpad agent --resume abc',
    });
    expect(db.prepare('SELECT startup_cmd FROM panes WHERE id = ?').get('p3')).toEqual({
      startup_cmd: null, // a non-agent pane is never rewritten
    });
    expect(db.prepare('SELECT name, icon FROM tabs WHERE id = ?').get('t1')).toEqual({
      name: 'Home', // v8 lifted the leading emoji out of the name…
      icon: '🌐', // …and into the icon slot
    });

    const before = fingerprint(db);

    // Prove the DETECTOR detects, or the assertion below is theatre: a
    // fingerprint that quietly returned a constant would make every possible
    // migration "idempotent". One row moved must show up, and moving it back
    // must restore the fingerprint exactly.
    db.prepare('UPDATE panes SET cwd = ? WHERE id = ?').run('/elsewhere', 'p3');
    expect(fingerprint(db)).not.toEqual(before);
    db.prepare('UPDATE panes SET cwd = ? WHERE id = ?').run('/tmp', 'p3');
    expect(fingerprint(db)).toEqual(before);

    runMigrations(db);
    expect(fingerprint(db)).toEqual(before);
    // …and a third, because "stable after two" and "stable forever" are not
    // the same claim and this is free.
    runMigrations(db);
    expect(fingerprint(db)).toEqual(before);
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
    // Stopped AT v21: this is about the column v21 created, in v21's
    // vocabulary. v26 renamed those values (see its own block below), and
    // running past it here would be testing two steps at once.
    runMigrations(db, { upTo: 21 });
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
    // v21 gave it 'deep'; v26 renamed that to 'agent' and left the bare
    // command alone — Agent mode is still the absence of the flag, so this
    // pane's behaviour is unchanged across BOTH steps.
    expect(pane.mode).toBe('agent');
    expect(pane.startup_cmd).toBe('muxpad agent');

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
    expect(LATEST_SCHEMA_VERSION).toBe(26);
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

describe('migrations v25 — content-derived tab icons', () => {
  const seedTab = (db: Database.Database, icon: string | null = null) => {
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w-one', 'W', 0, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, icon, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't-one', 'agent', ?, 'p1', 'w1', 0, 1, 1)`,
    ).run(icon);
  };

  it('adds the two columns with the right nullability', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedTab(db, '🚀');
    const row = db.prepare('SELECT icon, icon_sticky, icon_at FROM tabs').get() as {
      icon: string | null;
      icon_sticky: number;
      icon_at: number | null;
    };
    // icon_sticky backfills to 0, the SAFE direction and the same argument
    // migration 24 made for name_sticky: a row wrongly left not-sticky is
    // repaired by picking an icon once, a row wrongly marked sticky can never
    // be given a meaningful one again.
    expect(row.icon_sticky).toBe(0);
    // icon_at is nullable with no backfill, because "this glyph did not come
    // from the generator" is a real state — and for every pre-existing row it
    // is the true one.
    expect(row.icon_at).toBeNull();
    // The migration itself does not touch the icon. Clearing the unclaimed
    // ones is the one-time backfill's job (chat/headline.ts), behind its own
    // globals marker, so it happens once per install rather than once per
    // schema step.
    expect(row.icon).toBe('🚀');
  });

  it('backfills EXISTING tabs rather than failing on the NOT NULL default', () => {
    const db = new Database(':memory:');
    runMigrations(db, { upTo: 24 });
    seedTab(db, '🚀');
    runMigrations(db);
    expect(db.prepare('SELECT icon_sticky, icon_at FROM tabs WHERE id = ?').get('t1')).toEqual({
      icon_sticky: 0,
      icon_at: null,
    });
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedTab(db, '🚀');
    db.prepare('UPDATE tabs SET icon_sticky = 1, icon_at = 99 WHERE id = ?').run('t1');
    runMigrations(db);
    expect(db.prepare('SELECT icon_sticky, icon_at FROM tabs WHERE id = ?').get('t1')).toEqual({
      icon_sticky: 1,
      icon_at: 99,
    });
  });
});

describe('migrations v26 — ⚡ do / 🧠 deep become Chat / Agent', () => {
  /** A v25 database (pre-rename) with one workspace and one tab to hang panes
   *  off. `upTo: 25` is what makes this a real upgrade test rather than a
   *  current-schema DB pretending to be old. */
  function v25(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db, { upTo: 25 });
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 't', '""', 'w1', 0, 0, 0)`,
    ).run();
    return db;
  }

  function addPane(db: Database.Database, id: string, mode: string, cmd: string | null): void {
    db.prepare(
      `INSERT INTO panes (id, tab_id, shell, startup_cmd, cwd, mode, created_at)
       VALUES (?, 't1', '/bin/zsh', ?, '/tmp', ?, 0)`,
    ).run(id, cmd, mode);
  }

  const paneRow = (db: Database.Database, id: string) =>
    db.prepare('SELECT mode, startup_cmd FROM panes WHERE id = ?').get(id) as {
      mode: string;
      startup_cmd: string | null;
    };

  it('migrates a real `do` row AND its `--mode do` command together', () => {
    // The headline case: the row and the startup command are two halves of
    // one fact, and a migration that moved only one of them would produce a
    // pane that REPORTS Chat and RESPAWNS as Agent.
    const db = v25();
    addPane(db, 'p1', 'do', 'muxpad agent --mode do --resume sid-1');
    runMigrations(db);
    expect(paneRow(db, 'p1')).toEqual({
      mode: 'chat',
      startup_cmd: 'muxpad agent --mode chat --resume sid-1',
    });
  });

  it('migrates a `deep` row and STRIPS its `--mode deep` command', () => {
    // Agent mode is the absence of the flag, so the explicit form converges
    // on the canonical one rather than becoming `--mode agent`.
    const db = v25();
    addPane(db, 'p1', 'deep', 'muxpad agent --mode deep --resume sid-2');
    runMigrations(db);
    expect(paneRow(db, 'p1')).toEqual({
      mode: 'agent',
      startup_cmd: 'muxpad agent --resume sid-2',
    });
  });

  it('leaves a bare `muxpad agent` command byte-identical', () => {
    // Every pane created before modes existed carries this. Its meaning is
    // unchanged by the rename, so the row must not churn.
    const db = v25();
    addPane(db, 'p1', 'deep', 'muxpad agent');
    runMigrations(db);
    expect(paneRow(db, 'p1')).toEqual({ mode: 'agent', startup_cmd: 'muxpad agent' });
  });

  it('keeps the canonical flag order when --backend and --model are present', () => {
    // ws.ts's self-heal rewrite composes `muxpad agent --backend X --mode Y
    // --model Z` and compares it to the stored command to tell a reconnect
    // from a new runner. A migration that reordered the flags would make
    // every hello look like a new runner and re-flip the pane's face.
    const db = v25();
    addPane(db, 'p1', 'do', "muxpad agent --backend codex --mode do --model 'gpt-5.5'");
    runMigrations(db);
    expect(paneRow(db, 'p1').startup_cmd).toBe(
      "muxpad agent --backend codex --mode chat --model 'gpt-5.5'",
    );
  });

  it('leaves a PENDING `muxpad agent --pick` command alone (row still migrates)', () => {
    // Four call sites compare that literal verbatim; inserting a flag wedges
    // the harness picker. The mode lives on the row until one is chosen.
    const db = v25();
    addPane(db, 'p1', 'do', 'muxpad agent --pick');
    runMigrations(db);
    expect(paneRow(db, 'p1')).toEqual({ mode: 'chat', startup_cmd: 'muxpad agent --pick' });
  });

  it('lands every unrecognised value on the baseline — never on one the schema rejects', () => {
    // NOT NULL since v21 (which backfilled), so a literal NULL is
    // unreachable here — the migration still guards it, because the cost of
    // the guard is a clause and the cost of being wrong is a pane that reads
    // as a value the schema rejects.
    const db = v25();
    addPane(db, 'p-junk', 'turbo', null);
    addPane(db, 'p-empty', '', null);
    runMigrations(db);
    for (const id of ['p-junk', 'p-empty']) {
      // 'agent' = nothing injected. The only honest reading of "no mode
      // recorded" — claiming Chat would assert a contract nobody applied.
      expect(paneRow(db, id).mode).toBe('agent');
    }
    const modes = (db.prepare('SELECT DISTINCT mode FROM panes').all() as { mode: string }[]).map(
      (r) => r.mode,
    );
    expect(modes.every((m) => m === 'chat' || m === 'agent')).toBe(true);
  });

  it('leaves a NON-agent pane’s startup command untouched', () => {
    const db = v25();
    addPane(db, 'p1', 'deep', 'npm run dev -- --mode deep');
    runMigrations(db);
    expect(paneRow(db, 'p1').startup_cmd).toBe('npm run dev -- --mode deep');
  });

  it('is idempotent', () => {
    const db = v25();
    addPane(db, 'p1', 'do', 'muxpad agent --mode do');
    runMigrations(db);
    const once = paneRow(db, 'p1');
    runMigrations(db);
    expect(paneRow(db, 'p1')).toEqual(once);
  });

  it('does NOT rewrite crons.mode — those rows are read through a coercion', () => {
    // A user's schedule is theirs; the column is free text read at fire time
    // and a stored 'do' still means Chat. Rewriting it would buy nothing and
    // touch rows the rename has no business touching.
    const db = v25();
    db.prepare(
      `INSERT INTO crons (id, name, schedule, tz, prompt, target_kind, mode, next_due_at,
                          jitter_ms, created_at)
       VALUES ('c1', 'c', '0 9 * * *', 'UTC', 'p', 'new-tab', 'do', 0, 0, 0)`,
    ).run();
    runMigrations(db);
    expect(
      (db.prepare("SELECT mode FROM crons WHERE id = 'c1'").get() as { mode: string }).mode,
    ).toBe('do');
  });
});
