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
    // Two additive pieces, originally added for the (since-retired) resident
    // pane primitive and kept because both are generally useful:
    //   globals — a tiny server-side KV for singleton pointers and one-shot
    //     migration markers. Server-side, not localStorage: a "have we run
    //     this once" marker is meaningless if it's per-device.
    //   workspaces.hidden — system-container flag, excluding a workspace
    //     from the sidebar tree (GET /api/workspaces filters it unless
    //     ?all=1). Still the mechanism for any non-user-facing container.
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
  {
    // Step 1 of the UX evolution — two independent, purely additive pieces:
    //
    //   panes.mode          — agent behavior mode (⚡ do / 🧠 deep). Default
    //     'deep' is EXACTLY today's behavior (no overlay injected at all), so
    //     every existing pane keeps running unchanged after the migration.
    //
    //   tabs.pinned         — manual "keep this at the top" flag. Default 0,
    //     so on upgrade every tab lands in the auto-sorted block, which is
    //     the pre-migration ordering degraded gracefully (position order is
    //     still the final tiebreak).
    //   tabs.last_activity_at — epoch ms of the last turn/send/pty activity.
    //     Deliberately NULLABLE with no backfill: "we have never observed
    //     activity here" is a real, distinguishable state, and inventing a
    //     timestamp (created_at, or now()) would fabricate an ordering the
    //     user never produced. Null sorts LAST in the recency block (see
    //     routes/tabs.ts), so untouched tabs sink instead of jumping around.
    version: 21,
    sql: `
      ALTER TABLE panes ADD COLUMN mode TEXT NOT NULL DEFAULT 'deep';
      ALTER TABLE tabs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tabs ADD COLUMN last_activity_at INTEGER;
    `,
  },
  {
    // `muxpad cron` — the server-owned scheduler
    // (docs/plans/2026-08-14-muxpad-cron.md). Two tables:
    //
    //   crons     — the schedules themselves. `next_due_at` is PERSISTED, not
    //     held in memory: that single choice is what makes the scheduler
    //     restart-safe and catch-up capable, which is the whole reason this
    //     exists rather than leaning on a harness's session-scoped cron.
    //   cron_runs — the run log. Turns "it just didn't run" from silence into
    //     a record. Trimmed to the newest CRON_RUNS_KEEP rows per cron on
    //     every insert, so a 30-minute cron can't grow it without bound.
    //
    // `jitter_ms` is a per-cron offset (deterministic, derived from the id)
    // added to every nominal slot, so a dozen daily crons don't all fire in
    // the same second. It is STORED rather than recomputed because
    // `next_due_at` carries it: the nominal slot is recovered exactly as
    // next_due_at - jitter_ms, with no re-derivation to drift.
    //
    // Deliberately NO foreign key on `target_pane`: a deleted pane must
    // DISABLE its cron (with a push), not silently delete the schedule the
    // user wrote — and the run history has to outlive the pane it ran in, the
    // same reasoning as session_history (v20).
    version: 22,
    sql: `
      CREATE TABLE crons (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        schedule         TEXT NOT NULL,
        tz               TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        target_kind      TEXT NOT NULL,
        target_pane      TEXT,
        workspace_id     TEXT,
        cwd              TEXT,
        model            TEXT,
        backend          TEXT,
        mode             TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        catchup          TEXT NOT NULL DEFAULT 'once',
        overlap          TEXT NOT NULL DEFAULT 'skip',
        on_context       TEXT NOT NULL DEFAULT 'fire',
        quiet_mins       INTEGER NOT NULL DEFAULT 0,
        jitter_ms        INTEGER NOT NULL DEFAULT 0,
        max_open         INTEGER NOT NULL DEFAULT 1,
        close_when_done  INTEGER NOT NULL DEFAULT 0,
        open_tabs        TEXT NOT NULL DEFAULT '[]',
        next_due_at      INTEGER NOT NULL,
        last_fire_at     INTEGER,
        last_status      TEXT,
        fail_streak      INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX crons_due ON crons(enabled, next_due_at);
      CREATE INDEX crons_target_pane ON crons(target_pane);
      CREATE TABLE cron_runs (
        id           TEXT PRIMARY KEY,
        cron_id      TEXT NOT NULL,
        due_at       INTEGER NOT NULL,
        fired_at     INTEGER NOT NULL,
        target_pane  TEXT,
        target_tab   TEXT,
        outcome      TEXT NOT NULL,
        detail       TEXT
      );
      CREATE INDEX cron_runs_cron ON cron_runs(cron_id, fired_at DESC);
    `,
  },
  {
    // APPS — the Hosted surface's first kind
    // (docs/plans/2026-08-30-hosted.md). A registry of long-running local web
    // servers muxpad supervises, so an app stops costing a permanent TAB just
    // to keep its process alive.
    //
    // `pane_id` is the whole design in one column. An app IS a supervised pane
    // — one living in a HIDDEN workspace, so it has no presence in the tab
    // tree — and that pane is what ptyd keeps alive across main-server
    // restarts. Deliberately NO foreign key: a pane deleted out from under an
    // app must leave the registry row intact so the app can be rebuilt, not
    // silently cascade the user's app definition away. The reconciler nulls
    // the column when the pane is gone and materialises a fresh one.
    //
    // NULLABLE `pane_id` is therefore a real, expected state ("registered but
    // not materialised"), not an anomaly: `app add --no-start`, a stopped app,
    // and the window between a boot and the first reconcile all live there.
    //
    // Two switches, not one, because they answer different questions:
    //   enabled    is it supposed to be RUNNING right now? (`app start`/`stop`)
    //   autostart  should a BOOT bring it up? (a scratch app you start by hand)
    // Collapsing them would make "stop it, but bring it back tomorrow"
    // unexpressible.
    //
    // The UNIQUE index on pane_id is partial (`WHERE pane_id IS NOT NULL`) so
    // any number of apps may sit unmaterialised, but one pane can never be
    // claimed by two registry rows — the state that would have two supervisors
    // fighting over one pty.
    version: 23,
    sql: `
      CREATE TABLE apps (
        id          TEXT PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        command     TEXT NOT NULL,
        url         TEXT NOT NULL,
        autostart   INTEGER NOT NULL DEFAULT 1,
        enabled     INTEGER NOT NULL DEFAULT 1,
        pane_id     TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX apps_pane ON apps(pane_id) WHERE pane_id IS NOT NULL;
    `,
  },
];

/** Highest version in the migration list. Exported so a test can assert the
 *  recorded version without hard-coding a number that drifts. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * @param opts.upTo Stop after this version instead of migrating to the head.
 *   TEST-ONLY: it exists so a migration test can build a genuinely OLD
 *   database and then upgrade it, rather than building a current-schema DB and
 *   asserting things about it (which proves nothing about the upgrade path).
 *   Production always calls this with no options.
 */
export function runMigrations(db: Database.Database, opts?: { upTo?: number }): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  for (const m of MIGRATIONS) {
    if (opts?.upTo !== undefined && m.version > opts.upTo) break;
    if (m.version <= current) continue;
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      if (m.apply) m.apply(db);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
  }
}
