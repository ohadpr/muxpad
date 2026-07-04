import type Database from 'better-sqlite3';
import { type LayoutNode, pruneLayout, randomTabIcon, splitLeadingEmoji } from '@muxpad/shared';

interface Migration {
  version: number;
  sql?: string;
  apply?: (db: Database.Database) => void;
}

/**
 * Walk the binary layout tree and drop any pane IDs not in `valid`. Empty
 * branches collapse upward; if everything is gone the layout becomes ''.
 * Thin wrapper over the shared `pruneLayout` collapse routine.
 */
export function pruneDeadPanes(layout: LayoutNode, valid: Set<string>): LayoutNode {
  return pruneLayout(layout, (id) => valid.has(id));
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
  {
    // Numbered v6 (not v2) because deployed DBs carry the pre-collapse
    // schema_version history 1..5; a v2 here would be silently skipped
    // by the `m.version <= current` guard. New URL-pane install lands
    // at v6.
    version: 6,
    // SQLite has no ALTER COLUMN, so we rebuild the panes table to
    // relax NOT NULL on shell/cwd and add kind+url. Rebuilding the
    // table forces us to also rebuild attachments: an ALTER TABLE
    // ... RENAME on panes rewrites the FK target in attachments to
    // the temp name, leaving a dangling reference after we restore
    // the original name. Recreating attachments fresh keeps its FK
    // pointing at the new panes table.
    sql: `
      ALTER TABLE panes RENAME TO panes_v1;
      ALTER TABLE attachments RENAME TO attachments_v1;
      CREATE TABLE panes (
        id           TEXT PRIMARY KEY,
        tab_id       TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL DEFAULT 'shell',
        url          TEXT,
        shell        TEXT,
        startup_cmd  TEXT,
        cwd          TEXT,
        env          TEXT,
        created_at   INTEGER NOT NULL
      );
      INSERT INTO panes (id, tab_id, kind, shell, startup_cmd, cwd, env, created_at)
        SELECT id, tab_id, 'shell', shell, startup_cmd, cwd, env, created_at
        FROM panes_v1;
      CREATE TABLE attachments (
        id          TEXT PRIMARY KEY,
        pane_id     TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
        mime        TEXT NOT NULL,
        path        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      INSERT INTO attachments (id, pane_id, mime, path, created_at)
        SELECT id, pane_id, mime, path, created_at FROM attachments_v1;
      DROP TABLE attachments_v1;
      DROP TABLE panes_v1;
      CREATE INDEX panes_tab_id ON panes(tab_id);
    `,
  },
  {
    // Manual "mark as unread": a persistent per-tab flag, folded into the
    // tab's attention dot alongside the BEL-driven runtime attention. Lives
    // in the DB (not ptyd's runtime) so it survives restarts and needs no
    // ptyd round-trip; cleared when the tab is next viewed (markSeen).
    version: 7,
    sql: `ALTER TABLE tabs ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Per-tab icon. Adds the column, then backfills: lift a leading emoji
    // out of the name into the icon slot (the old "emoji in the name"
    // convention) so the navigator's icon column is consistent and we
    // don't double up; tabs without a leading emoji get a random icon.
    version: 8,
    sql: `ALTER TABLE tabs ADD COLUMN icon TEXT;`,
    apply: (db) => {
      const rows = db.prepare('SELECT id, name FROM tabs').all() as {
        id: string;
        name: string;
      }[];
      const upd = db.prepare('UPDATE tabs SET name = ?, icon = ? WHERE id = ?');
      for (const r of rows) {
        const { icon, rest } = splitLeadingEmoji(r.name);
        const trimmed = rest.trim();
        if (icon && trimmed)
          upd.run(trimmed, icon, r.id); // "🌐 Home" → name "Home", icon 🌐
        else if (icon)
          upd.run(r.name, icon, r.id); // name was only an emoji → use it as the icon, no random mismatch
        else upd.run(r.name, randomTabIcon(), r.id); // no leading emoji → random icon
      }
    },
  },
  {
    // Agent sessions: muxpad's own handle on a Claude (later Codex/Cursor)
    // session running in a pane, so the session can be viewed/driven as a
    // terminal or as web chat and switched between the two. `current_sid`
    // is the live provider session-id, captured via the SessionStart hook
    // the `muxpad claude` wrapper installs; `lineage` is the JSON list of
    // every session-id this pane's session has carried (resume/compact/fork
    // can mint a new one). One row per pane. See
    // docs/plans/2026-07-01-web-chat-session-switching.md.
    version: 9,
    sql: `
      CREATE TABLE agent_sessions (
        id           TEXT PRIMARY KEY,
        pane_id      TEXT NOT NULL UNIQUE REFERENCES panes(id) ON DELETE CASCADE,
        assistant    TEXT NOT NULL DEFAULT 'claude',
        cwd          TEXT,
        current_sid  TEXT,
        lineage      TEXT NOT NULL DEFAULT '[]',
        view_mode    TEXT NOT NULL DEFAULT 'terminal',
        writer       TEXT NOT NULL DEFAULT 'tui',
        status       TEXT NOT NULL DEFAULT 'idle',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `,
  },
  {
    // The Claude TUI's PID, captured by the `muxpad claude` wrapper via $$
    // (exec-inherited into claude). The server SIGTERMs it to hand a session
    // from the terminal to chat cleanly — no keystroke fragility, no ptyd RPC.
    version: 10,
    sql: 'ALTER TABLE agent_sessions ADD COLUMN tui_pid INTEGER;',
  },
  {
    // User-set pane name. Persistent override for the live-derived tab-strip
    // label (terminal title / foreground command), so a rename in the pane
    // tab bar sticks and isn't overwritten by claude/the shell. Nullable —
    // null means "use the live label". Lives in SQLite, not ptyd, so it
    // survives restarts and needs no ptyd round-trip.
    version: 11,
    sql: 'ALTER TABLE panes ADD COLUMN name TEXT;',
  },
  {
    // Desktop split ⇄ tabbed rendering mode per tab ('split' | 'tabbed').
    // Was a localStorage-only prototype (per device, lost on cache clear);
    // persisting it server-side makes the choice survive reloads and follow
    // the user across devices — same rationale as agent_sessions.view_mode.
    // The split layout tree is untouched by the flip; this is only how the
    // same panes are presented.
    version: 12,
    sql: "ALTER TABLE tabs ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'split';",
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
