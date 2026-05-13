import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  sql?: string;
  apply?: (db: Database.Database) => void;
}

type LayoutValue =
  | string
  | {
      direction: 'row' | 'column';
      splitPercentage?: number | undefined;
      first: LayoutValue;
      second: LayoutValue;
    };

/**
 * Walk the binary layout tree and drop any pane IDs not in `valid`. Empty
 * branches collapse upward; if everything is gone the layout becomes ''.
 */
export function pruneDeadPanes(layout: LayoutValue, valid: Set<string>): LayoutValue {
  if (layout == null || layout === '') return '';
  if (typeof layout === 'string') return valid.has(layout) ? layout : '';
  const first = pruneDeadPanes(layout.first, valid);
  const second = pruneDeadPanes(layout.second, valid);
  if (first === '' && second === '') return '';
  if (first === '') return second;
  if (second === '') return first;
  return { ...layout, first, second };
}

/**
 * Schema baseline. The earlier per-step v1-v5 history (initial schema,
 * slug randomization, dead-pane pruning, tab position, multi-workspaces)
 * was collapsed into a single v1 once the only deployed DB had finished
 * migrating. New installs land directly on this schema.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE tabs (
        id            TEXT PRIMARY KEY,
        slug          TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        layout        TEXT NOT NULL,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX tabs_workspace_id ON tabs(workspace_id);
      CREATE TABLE panes (
        id           TEXT PRIMARY KEY,
        tab_id       TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
        shell        TEXT NOT NULL,
        startup_cmd  TEXT,
        cwd          TEXT NOT NULL,
        env          TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX panes_tab_id ON panes(tab_id);
      CREATE TABLE attachments (
        id          TEXT PRIMARY KEY,
        pane_id     TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
        mime        TEXT NOT NULL,
        path        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      if (m.apply) m.apply(db);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
  }
}
