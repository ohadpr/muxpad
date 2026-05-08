import type Database from 'better-sqlite3';
import { generateShortId } from './WorkspaceStore.js';

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

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        layout      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
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
      CREATE TABLE attachments (
        id          TEXT PRIMARY KEY,
        pane_id     TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
        mime        TEXT NOT NULL,
        path        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `,
  },
  {
    // Slugs used to be derived from workspace names. Re-randomize every
    // existing slug to a short opaque ID; from now on slugs are pure URL keys.
    version: 2,
    apply: (db) => {
      const rows = db.prepare('SELECT id FROM workspaces').all() as { id: string }[];
      const taken = new Set<string>();
      const update = db.prepare('UPDATE workspaces SET slug = ? WHERE id = ?');
      for (const row of rows) {
        let slug: string | null = null;
        for (let attempts = 0; attempts < 100; attempts++) {
          const candidate = generateShortId();
          if (taken.has(candidate)) continue;
          const collision = db
            .prepare('SELECT 1 FROM workspaces WHERE slug = ? AND id != ?')
            .get(candidate, row.id);
          if (collision) continue;
          slug = candidate;
          break;
        }
        if (!slug) throw new Error(`unable to allocate slug for workspace ${row.id}`);
        taken.add(slug);
        update.run(slug, row.id);
      }
    },
  },
  {
    // Earlier daemon-shutdown bug deleted pane rows but left workspace.layout
    // referring to them. Walk every layout and drop dead refs so workspaces
    // can recover into the empty 'Create first pane' state.
    version: 3,
    apply: (db) => {
      const rows = db.prepare('SELECT id, layout FROM workspaces').all() as {
        id: string;
        layout: string;
      }[];
      const update = db.prepare('UPDATE workspaces SET layout = ? WHERE id = ?');
      for (const ws of rows) {
        const valid = new Set(
          (
            db.prepare('SELECT id FROM panes WHERE workspace_id = ?').all(ws.id) as {
              id: string;
            }[]
          ).map((p) => p.id),
        );
        const layout = JSON.parse(ws.layout) as LayoutValue;
        const cleaned = pruneDeadPanes(layout, valid);
        const cleanedJson = JSON.stringify(cleaned);
        if (cleanedJson !== ws.layout) {
          update.run(cleanedJson, ws.id);
        }
      }
    },
  },
  {
    // User-controlled workspace ordering for the tab bar. Initialize from
    // current creation order so existing tabs don't visibly shuffle.
    version: 4,
    sql: 'ALTER TABLE workspaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0;',
    apply: (db) => {
      const rows = db
        .prepare('SELECT id FROM workspaces ORDER BY created_at, id')
        .all() as { id: string }[];
      const update = db.prepare('UPDATE workspaces SET position = ? WHERE id = ?');
      rows.forEach((row, idx) => update.run(idx, row.id));
    },
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
