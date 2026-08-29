import { type LayoutNode, pruneLayout, randomTabIcon, splitLeadingEmoji } from '@muxpad/shared';
import type Database from 'better-sqlite3';

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
    sql: 'ALTER TABLE tabs ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;',
  },
  {
    // Per-tab icon. Adds the column, then backfills: lift a leading emoji
    // out of the name into the icon slot (the old "emoji in the name"
    // convention) so the navigator's icon column is consistent and we
    // don't double up; tabs without a leading emoji get a random icon.
    version: 8,
    sql: 'ALTER TABLE tabs ADD COLUMN icon TEXT;',
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
  {
    // Which face a shell pane shows ('terminal' | 'web' | 'chat') and, for
    // the web face, the chosen URL. Was localStorage-only (device-local,
    // lost on another device / cache clear) with terminal⇄chat separately
    // half-synced through agent_sessions.view_mode; one server-persisted
    // pane-level value makes every face survive reloads and follow the user
    // across devices — same pattern as tabs.view_mode.
    version: 13,
    sql: `
      ALTER TABLE panes ADD COLUMN face TEXT NOT NULL DEFAULT 'terminal';
      ALTER TABLE panes ADD COLUMN face_url TEXT;
    `,
  },
  {
    // Terminal⇄chat session switching was dropped (PR #4): chat is an
    // agent-pane face only. Any non-agent pane still persisted on the chat
    // face is legacy state from the switching era — reset it to terminal so
    // no pane is stranded on a face the UI no longer offers.
    version: 14,
    sql: `
      UPDATE panes SET face = 'terminal'
      WHERE face = 'chat'
        AND (startup_cmd IS NULL OR startup_cmd NOT LIKE 'muxpad agent%');
    `,
  },
  {
    // Durable kill queue: a pane DELETE whose ptyd kill fails in transit
    // must not leave the pty running forever with no DB row (an invisible
    // straggler no UI can ever reach). Failed kills land here and a sweeper
    // retries until ptyd confirms.
    version: 15,
    sql: `
      CREATE TABLE pending_pane_kills (
        pane_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Web Push subscriptions (one row per browser/device that enabled
    // notifications). `endpoint` is the push service URL — unique per
    // subscription, so it doubles as the primary key. `subscription` is the
    // full PushSubscription JSON (endpoint + encryption keys) that web-push
    // needs to send. Rows are pruned when the push service reports the
    // subscription gone (404/410).
    version: 16,
    sql: `
      CREATE TABLE push_subscriptions (
        endpoint     TEXT PRIMARY KEY,
        subscription TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `,
  },
  {
    // Per-pane "done, unreviewed" flag (bold name, like unread mail). Set when
    // an agent turn finishes here unobserved, or manually; cleared when the
    // pane is viewed. Distinct from the runtime BEL attention (red dot).
    // Persisted so results found while you were away survive a restart.
    version: 17,
    sql: 'ALTER TABLE panes ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;',
  },
  {
    // Server-owned queue of user messages waiting for a busy/reconnecting agent.
    // Previously the queue lived only in the browser's React state, so closing
    // the tab (or a server restart mid-reconnect) silently dropped every pending
    // message. Persisting it server-side means the queue survives reloads,
    // follows the user across devices, and — crucially — the server keeps
    // feeding messages to the agent one turn at a time even with no browser open.
    // `seq` is a monotonic per-pane order key (ties broken by it); rows are
    // deleted as each is relayed to the runner or cancelled by the user.
    version: 18,
    sql: `
      CREATE TABLE agent_queue (
        id          TEXT PRIMARY KEY,
        pane_id     TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        text        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX agent_queue_pane ON agent_queue(pane_id, seq);
    `,
  },
  {
    // CEO pane storage (see docs/plans/2026-08-21-ceo-pane.md §B2). Two
    // additive pieces:
    //   globals — a tiny server-side KV for singleton pointers
    //     (ceo_pane_id / ceo_tab_id). Server-side, not localStorage: the
    //     CEO must resolve to the SAME pane from every browser.
    //   workspaces.hidden — system-container flag. The CEO pane needs a
    //     backing tab (panes.tab_id is NOT NULL) and tabs need a workspace;
    //     rather than relaxing FKs (SQLite table rebuild) the pane lives in
    //     a hidden '· system ·' workspace excluded from the sidebar tree.
    version: 19,
    sql: `
      CREATE TABLE globals (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      ALTER TABLE workspaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Append-only session registry (docs/plans/2026-08-28-session-archive.md
    // §1). `agent_sessions` is a LIVE table — lineage resets on fresh launch
    // and the row cascade-deletes with its pane — so the pane↔sid history was
    // being lost even where the transcript survives. Every place a sid becomes
    // known (register / recordSessionId / attachRunner) upserts here; rows are
    // never deleted. Deliberately no pane FK: history must survive pane
    // deletion.
    version: 20,
    sql: `
      CREATE TABLE session_history (
        sid        TEXT PRIMARY KEY,
        pane_id    TEXT,
        assistant  TEXT,
        cwd        TEXT,
        first_seen INTEGER,
        last_seen  INTEGER
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
