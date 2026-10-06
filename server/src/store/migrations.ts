import {
  type LayoutNode,
  pruneLayout,
  randomTabIcon,
  splitLeadingEmoji,
  staggeredClockOffset,
  staggeredClockStart,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { applyModeToStartupCmd } from '../agent-modes.js';

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
    //   panes.mode          — agent behavior mode, then spelled 'do'/'deep'
    //     (renamed to 'chat'/'agent' in v26). Default 'deep' is EXACTLY
    //     today's behavior (no overlay injected at all), so every existing
    //     pane keeps running unchanged after the migration.
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
  {
    // The nav row's second line, and the auto-namer's hard stop.
    //
    //   tabs.headline — ONE line saying what this chat is currently about,
    //     written by a cheap model from the transcript (chat/headline.ts).
    //     Nullable with no backfill, because "we have never summarised this
    //     chat" is a real and permanent state: a tab with no agent session
    //     never gets one, and the rail simply renders a one-line row. An
    //     empty string would be a different (and wrong) claim — that we
    //     summarised it and it came out blank.
    //
    //   tabs.headline_at — when that line was last written. This is the
    //     rate limiter's clock, and it is PERSISTED for the same reason the
    //     cron scheduler persists next_due_at: an in-memory timestamp resets
    //     on every server restart, and a restart is exactly the moment a
    //     rate limiter must not forget itself (a bounce loop would otherwise
    //     re-summarise every chat on every boot).
    //
    //   tabs.name_sticky — the user has named this tab by hand. Permanent.
    //     This replaces an in-memory Map in ws.ts whose own comment conceded
    //     the flaw: after a restart it treated every existing auto-name as
    //     user-given, so the guard held only by the accident that a manual
    //     name matched neither the bootstrap sentinel nor the last title.
    //     Backfilled to 0, which is the safe direction — a tab wrongly
    //     marked not-sticky can be re-stickied by renaming it once; a tab
    //     wrongly marked sticky can never be auto-named again.
    version: 24,
    sql: `
      ALTER TABLE tabs ADD COLUMN headline TEXT;
      ALTER TABLE tabs ADD COLUMN headline_at INTEGER;
      ALTER TABLE tabs ADD COLUMN name_sticky INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // The tab ICON becomes content-derived, chosen by the same model call that
    // writes the headline (chat/headline.ts). Two columns, mirroring the two
    // the headline needed:
    //
    //   tabs.icon_sticky — the user has chosen this icon by hand. Permanent,
    //     one-way, and it outranks everything: exactly the `name_sticky`
    //     contract, for exactly the same reason. The sidebar work flagged this
    //     gap explicitly ("no content-derived icon path exists; if one is
    //     added it must consult name_sticky"), and an icon deserves its own
    //     flag rather than riding the name's — renaming a tab and choosing its
    //     glyph are different acts, and one should not silently freeze the
    //     other. Backfilled to 0, the safe direction: a tab wrongly marked
    //     not-sticky can be re-stickied by picking its icon once, while a tab
    //     wrongly marked sticky can never be given a meaningful one again.
    //
    //   tabs.icon_at — when the generated icon was last WRITTEN. Not an
    //     attempt clock (that is headline_at, shared, because it is one model
    //     call): this measures how long the current glyph has been sitting
    //     there, and it is the anti-drift window. Persisted for the same
    //     reason headline_at is — a restart is exactly when a stability window
    //     must not forget itself. NULL means "this icon did not come from the
    //     generator", which for every pre-existing row means the random one it
    //     was born with.
    version: 25,
    sql: `
      ALTER TABLE tabs ADD COLUMN icon_sticky INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tabs ADD COLUMN icon_at INTEGER;
    `,
  },
  {
    // The two agent modes get their user-facing names: 'do' → 'chat',
    // 'deep' → 'agent' (see shared/types.ts AgentModeSchema). Purely a rename
    // of the STORED vocabulary — no pane's behaviour changes here.
    //
    // The value lives in two places and BOTH have to move together, or a pane
    // reads one mode and boots in another:
    //
    //   panes.mode        — the authoritative row. Rewritten below. Anything
    //     unrecognised (a NULL from before v21, a value from a future build
    //     someone downgraded out of) lands on 'agent', the baseline: it is the
    //     only reading of "no mode recorded" that doesn't claim a contract was
    //     overlaid when it wasn't.
    //
    //   panes.startup_cmd — `muxpad agent … --mode do|deep`, which is what a
    //     RESPAWN actually boots from. Rewritten via applyModeToStartupCmd so
    //     the flag ordering stays byte-identical to what ws.ts's self-heal
    //     rewrite composes (a different order reads as a new runner on every
    //     hello and re-flips the pane's face).
    //
    // Agent mode stays expressed by the ABSENCE of the flag, so a bare
    // `muxpad agent` — every pane that predates modes entirely — is already
    // correct and is left untouched. `--mode deep` is STRIPPED rather than
    // rewritten to `--mode agent`: same meaning, and it converges those rows
    // onto the one canonical spelling.
    //
    // crons.mode is deliberately NOT migrated. It is nullable free text read
    // at fire time through a tolerant normalizer (CronScheduler), a stored
    // 'do'/'deep' keeps meaning exactly what it meant, and rewriting user
    // rows for a cosmetic rename buys nothing.
    //
    // Note on the column DEFAULT: v21 created it as `DEFAULT 'deep'`, and
    // SQLite cannot alter a default without rebuilding the table. It is
    // unreachable — PaneStore.create is the only INSERT and always supplies
    // the value — and PaneStore.row() normalizes anything unrecognised to the
    // baseline, so a row can never surface a value the schema rejects. Not
    // worth a full table rebuild.
    version: 26,
    apply: (db) => {
      db.prepare("UPDATE panes SET mode = 'chat' WHERE mode = 'do'").run();
      db.prepare("UPDATE panes SET mode = 'agent' WHERE mode IS NULL OR mode <> 'chat'").run();
      const rows = db
        .prepare(
          "SELECT id, mode, startup_cmd FROM panes WHERE startup_cmd LIKE 'muxpad agent%--mode %'",
        )
        .all() as Array<{ id: string; mode: string; startup_cmd: string | null }>;
      const update = db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?');
      for (const r of rows) {
        const next = applyModeToStartupCmd(r.startup_cmd, r.mode === 'chat' ? 'chat' : 'agent');
        if (next !== r.startup_cmd) update.run(next, r.id);
      }
    },
  },
  {
    // THE CHAT CLOCK, and the hierarchy it is shared down.
    //
    //   tabs.spawned_by — the tab this chat was spawned FROM (an agent working
    //     in that chat asked for this one). Nullable; null is the normal case.
    //
    //     Deliberately NO foreign key, and the reason is the whole model:
    //     nothing here is ever deleted by a clock, so a child must survive its
    //     parent's manual deletion rather than cascade away with it. A dangling
    //     id is therefore an EXPECTED state, and the resolver (tab-clock.ts)
    //     reads a child whose parent is gone as a root in its own right. An
    //     ON DELETE SET NULL would also have worked, but only while
    //     `foreign_keys = ON` — which is a pragma, i.e. a property of the
    //     CONNECTION, not of the data. Tolerating the dangle is the invariant
    //     that holds however the db is opened.
    //
    //   tabs.clock_started_at — epoch ms the chat's 4-day clock last started.
    //     Reset by a message the user sends it; when it runs out the chat is
    //     `done` (computed at read time, never stored — a stored flag would be
    //     a second source of truth that goes stale the instant the clock ticks
    //     past it with no writer awake).
    //
    // ── WHY NOT REUSE last_activity_at ───────────────────────────────────────
    // It answers a different question. `last_activity_at` is bumped by pty
    // OUTPUT (sampled every 5s) and by keystrokes, so a chat left tailing a log
    // would be immortal while a chat you genuinely finished with three days ago
    // decays on schedule — the clock would measure the terminal, not you. It is
    // also the sidebar's recency ORDER, and one column cannot be both a sort
    // key everything touches and a lifecycle clock only a deliberate act may
    // move.
    //
    // ── THE BACKFILL: EVERYONE STARTS FRESH, BUT NOT ALL AT ONCE ─────────────
    // No existing tab's clock starts before THIS MOMENT — the first boot after
    // this ships — so nothing decays on day one. Backfilling from
    // `last_activity_at` was considered and explicitly rejected: it would have
    // arrived with roughly half the existing tabs already expired, collapsing
    // most of the sidebar into a `done` group on the first render, which reads
    // as data loss even though nothing was lost.
    //
    // What one shared `Date.now()` gets wrong is the OTHER end of the same
    // four days. Ninety rows stamped in one minute expire in one minute, so
    // the sidebar does not thin on the fourth morning, it empties — every
    // untouched workspace a collapsed `N done` header over nothing, arriving
    // as ninety `tab.updated` events in a single sweeper tick. So each row's
    // clock starts at boot PLUS an offset derived from its id
    // (`staggeredClockStart`, in shared, with the argument for the direction
    // and for not ranking by activity). Measured on the real 90-tab database:
    // 38/26/26 crossings across days four to seven, and never more than two in
    // any one tick.
    //
    // The offset is never negative, which is how the day-one promise survives
    // the change: staggering can only give a chat more time than it had.
    //
    // Guarded by `IS NULL` so the backfill is idempotent in the real sense: a
    // second pass cannot re-stamp a clock the user has since reset (the version
    // guard already prevents a second pass, but a migration that would corrupt
    // data if it ever ran twice is one restore-from-backup away from doing it).
    // The offset is a pure function of the id for the same reason — a restore
    // must not re-deal every surviving chat a different death date than the one
    // the user has been watching count down.
    version: 27,
    sql: `
      ALTER TABLE tabs ADD COLUMN spawned_by TEXT;
      ALTER TABLE tabs ADD COLUMN clock_started_at INTEGER;
      CREATE INDEX tabs_spawned_by ON tabs(spawned_by);
    `,
    apply: (db) => {
      const boot = Date.now();
      const ids = db.prepare('SELECT id FROM tabs WHERE clock_started_at IS NULL').all() as Array<{
        id: string;
      }>;
      const update = db.prepare('UPDATE tabs SET clock_started_at = ? WHERE id = ?');
      for (const { id } of ids) update.run(staggeredClockStart(id, boot), id);
    },
  },
  {
    // RETIREMENT — the other way into `done`, and the one that answers the
    // 41-agent sidebar.
    //
    //   tabs.retired_at     — epoch ms this chat left the live list by an act
    //     rather than by the clock. Null means "still live" (or decayed, which
    //     is computed from the clock and never written).
    //   tabs.retired_reason — WHICH act. 'delivered' (a sub-chat finished its
    //     work and its result went back to the parent), 'archived' (the user
    //     did it by hand). Stored rather than inferred because the two read
    //     very differently in a tooltip, and because `spawned_by` alone cannot
    //     tell them apart — a sub-chat can also be archived by hand.
    //
    // WHY A COLUMN AND NOT A COMPUTED STATE, when `done`-by-decay is computed:
    // decay is a function of TIME, which the server can always re-derive; a
    // retirement is an EVENT, and an event nobody wrote down did not happen.
    // A sub-chat's delivery is observable exactly once, at turn-done, and the
    // runtime that observed it is gone after a restart.
    //
    // Nullable with no backfill, and that is the whole upgrade: every existing
    // tab is live, which is exactly the state they were in before this column
    // existed. Nothing retires retroactively — including the 41 agents that
    // motivated this. They decay on the v27 clock like everything else, and
    // any sub-chat among them retires the next time it finishes a turn.
    version: 28,
    sql: `
      ALTER TABLE tabs ADD COLUMN retired_at INTEGER;
      ALTER TABLE tabs ADD COLUMN retired_reason TEXT;
    `,
  },
  {
    // THE SPAWN REPORT — what a sub-chat actually did, in the parent's log.
    //
    // A worker retires the moment it delivers, which answered the 41-agent
    // sidebar and created a new complaint in its place: "I don't see the
    // summary of the work of this card anywhere". The chat leaves, the push
    // notification arrives, and the report it wrote is behind a click nobody
    // knows to make. These three columns are what the parent's log shows
    // instead.
    //
    //   spawn_report       — a few sentences: what it was asked, what it
    //     concluded, whether it worked, and where the work IS (a file path, a
    //     published URL, an attachment). NULL when there was nothing to say.
    //   spawn_report_at    — epoch ms of the ATTEMPT. Two jobs, deliberately:
    //     the rate limiter's clock (headline_at's precedent — a restart is
    //     exactly when a limiter must not forget itself, and a FAILURE has to
    //     advance it or a broken install spawns a subprocess per retirement
    //     forever), and the report entry's PLACE in the parent's transcript,
    //     which is the moment the result landed rather than the spawn three
    //     hours further up.
    //   spawn_report_state — what KIND of answer this is, and it is what keeps
    //     three different outcomes from reading as one shrug:
    //       'ok'      — a report was written
    //       'none'    — the child finished having produced nothing usable, and
    //                   says so. NEVER an invented summary.
    //       'crashed' — its last turn was FATAL. Written with or without text
    //                   (whatever it got done before dying is worth saying),
    //                   and it is the ONLY signal the client has that a child
    //                   which never retires has stopped — a crashed sub-chat
    //                   keeps its row by design, so its card span otherwise.
    //       NULL      — we could not summarise (no SDK, a timeout, a reply that
    //                   was not a report). The clock still advanced; nothing
    //                   renders. Every failure path leaves the surface exactly
    //                   as it was, which is chat/headline.ts's contract.
    //
    // WHY THE TAB ROW and not a side table: one report per child is a 1:1
    // relation, and the child's row already IS the record that the spawn
    // happened (the cards derive from the corpus and store nothing of their
    // own). The row also reaches the parent's conversation with no new
    // protocol — TabStore.row() → decorateTab → `tab.updated` → the client's
    // tab cache → the spawn cards — which is durable, cross-device, and the
    // same liveness path the headline already rides. A `spawn_notes` table
    // earns its keep when a parent needs MANY notes of SEVERAL kinds (the
    // directed-work echo in web/src/lib/chat-directed.ts being the other
    // candidate); it is the upgrade, not this.
    //
    // ONLY THE SUMMARY LIVES HERE. The report the child actually wrote can be
    // 25 KB, and the tab row is published on every sidebar list and every 5s
    // poll — so the expansion is fetched on demand from the transcript
    // endpoint instead. See web/src/lib/spawn-work.ts.
    //
    // No backfill, and there cannot be one: a report is read off a transcript
    // at the moment a child finishes, and no existing child is finishing now.
    // Absent is the right state for every row that predates the column, and
    // the client draws nothing for it.
    version: 29,
    sql: `
      ALTER TABLE tabs ADD COLUMN spawn_report TEXT;
      ALTER TABLE tabs ADD COLUMN spawn_report_at INTEGER;
      ALTER TABLE tabs ADD COLUMN spawn_report_state TEXT;
    `,
  },
  {
    // WHAT THE WORKER WAS ASKED — the other half of the pair, and the one the
    // reader sees FIRST.
    //
    //   tabs.spawn_task — one short line of plain English, read off the child's
    //     FIRST message when it starts work. NULL until then, and for every chat
    //     nobody spawned.
    //
    // A worker's card read `status-line`, beside a dot and a spinner, and
    // nothing else: `--name=` values are handles typed on a command line, chosen
    // to be short enough to type and unique enough to grep, which are not the
    // qualities a label needs. Two of them side by side say nothing about what
    // is running.
    //
    // WHY NOT THE HEADLINE, which already exists and already restates the
    // prompt. Two reasons, and the second is the one that decides it:
    //
    //   · It is a TAB-WIDE facility with a deliberately different cadence. The
    //     whole of chat/headline.ts is an argument for STILLNESS — a 6-minute
    //     floor, an anti-drift prompt, a "rewording is not a change" rule —
    //     because it is the sidebar's second line for every chat in the app.
    //     Making it fire immediately to serve a card would change what every
    //     row in the rail does, to fix one card.
    //   · It answers a different question. The headline names what a chat is
    //     ABOUT and keeps re-answering that as the subject moves; this names
    //     what a worker was ASKED, once, and is never revised — the task does
    //     not drift, and a label that changed under a running card would be the
    //     drift the headline exists to prevent, reintroduced next door.
    //
    // So: its own column, 1:1 with the child, write-once, beside `spawn_report`
    // — the pair reads "asked" and "concluded" — and written by the same writer
    // through the same model seam, firing on the first turn instead of the last.
    // The headline is still the card's FALLBACK (see web `spawnLabel`), which is
    // the one job it is genuinely good at.
    //
    // No backfill: a label is read off a first message and no existing child is
    // sending one. Absent is correct for every row that predates this, and the
    // card falls back through the headline to the handle rather than going
    // blank.
    version: 30,
    sql: `
      ALTER TABLE tabs ADD COLUMN spawn_task TEXT;
    `,
  },
  {
    // WHERE THE WORK IS — a JSON array of the urls and files a worker produced.
    //
    //   tabs.spawn_artifacts — `["https://…/muxpad-cross-workspace",
    //     "/tmp/sidebar/cross-workspace.md"]`, or NULL.
    //
    // `cross-ws` published a page and wrote a 13 KB report, and NEITHER reached
    // the conversation: "it went and investigated, produced an artifact … and so
    // I have no idea that it's waiting on me, that there's an artifact". A url or
    // a report path is the most valuable thing a completion card can carry — the
    // difference between a summary and something you can act on.
    //
    // ITS OWN COLUMN rather than a line inside `spawn_report`, and that is the
    // whole reason it helps here. The report is a MODEL's sentences and can fail;
    // for `cross-ws` it did (generated, then refused by a length rule), and
    // anything riding it failed with it. This is scraped from the transcript by a
    // regex, on the same read, and survives every failure the generator has. It
    // also has to render as LINKS, which prose cannot.
    //
    // A JSON array in a TEXT column, not a side table: it is a short bounded list
    // (4) belonging 1:1 to a row that already exists, and nothing ever queries
    // ACROSS artifacts — the only reader wants "this child's", which is the one
    // question a column answers better than a join.
    version: 31,
    sql: `
      ALTER TABLE tabs ADD COLUMN spawn_artifacts TEXT;
    `,
  },
  {
    // A WORKER IS A SEQUENCE OF ROUNDS, not one job.
    //
    // "if the chat has progressed then it doesn't help much to update the
    // original card" was answered with two entries per child — a launch at
    // `created_at` and a completion at `retired_at`. Both are ONE PAIR PER TAB,
    // and a worker does not get one job: it gets handed successive ones with
    // `muxpad agent send`, which revives the retired chat and starts fresh work.
    // Every round after the first was invisible to the person who asked for it.
    //
    // Measured on the real database, and it is not a corner case: the chat
    // writing this had FIVE user messages against a single pair of timestamps.
    // Worse than invisible, in fact — `reviveChat` NULLs `retired_at`, so
    // re-tasking a worker made its completion card disappear and reappear lower
    // down the log when the new round ended.
    //
    // WHY A TABLE AND NOT MORE COLUMNS: rounds are 1:N and unbounded. No
    // arrangement of a fixed pair carries them, which is the whole finding.
    //
    // WHY NOT DERIVED FROM THE ARCHIVE, which was the promising alternative:
    // `archive.sqlite` already stores one row per message with `sid`/`ts`/`role`
    // plus its own byte copy of each transcript, so rounds ARE reconstructible
    // from it — durably, stably, and measured at 38 ms per sid over 33 247
    // messages. It fails on LIVENESS. `Archiver` triggers on `agent_turn
    // done|fatal` and a 15-minute timer, so the message that STARTS a round is
    // archived when that round ENDS or up to a quarter of an hour later. A
    // launch card that arrives after the work finishes is not a launch card.
    // The archive remains the right BACKFILL for rounds that predate this table.
    //
    // The two live signals both already exist and are already wired:
    //   START  TabActivity.noteUserMessage — ws.ts's single funnel for every
    //          message into every agent pane, where `reviveChat` already fires.
    //   END    ChatRetirer.onFinished — where the spawn report already fires.
    //
    // ON DELETE CASCADE because a round of a chat that is gone is nothing. This
    // is the one place in the lifecycle where a cascade is right: everywhere
    // else "nothing is ever deleted" is the rule, and a round has no meaning
    // apart from its child.
    version: 32,
    sql: `
      CREATE TABLE spawn_rounds (
        id            TEXT PRIMARY KEY,
        tab_id        TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        report        TEXT,
        report_state  TEXT,
        artifacts     TEXT
      );
      CREATE INDEX spawn_rounds_tab ON spawn_rounds(tab_id, started_at);
    `,
  },
  {
    // WHEN THE USER LAST TOUCHED THIS CHAT — the key a GLOBAL recency list can
    // be ordered on, which `last_activity_at` is not.
    //
    //   tabs.last_user_at — epoch ms of the last act by the USER on this chat:
    //     its creation, a message sent into it, or an unarchive. NOT NULL from
    //     here on. Nothing the machine does moves it — not pty output, not a
    //     turn finishing, not an agent writing into the pane.
    //
    // ── WHY A FOURTH TIMESTAMP ───────────────────────────────────────────────
    // The sidebar can now be ordered as ONE flat list across every workspace,
    // and that turns the ordering key from a convenience into the product.
    // `last_activity_at` is bumped by sampled pty OUTPUT, which inside one
    // workspace is tolerable (you picked the workspace; the list is your
    // current context) and globally is not: measured on the live database while
    // this was written, 6 of 58 chats were `working` and held 6 of the global
    // top 7 — all under a minute old, none of them anything the user did. v27
    // had already written the sentence, about the same column, for the clock:
    // "a chat left tailing a log would be immortal".
    //
    // ── WHY NOT REUSE clock_started_at, WHICH MEANS ALMOST EXACTLY THIS ──────
    // Because it carries v27's backfill, and that backfill is deliberately NOT
    // a user-touch time: it is `boot + hash(id)` (`staggeredClockStart`), which
    // on the live database leaves 4 rows stamped in the FUTURE and 35 rows
    // ordered by an id hash. An untouched chat sorting ABOVE everything you
    // actually did — because its hash happens to be large — is strictly worse
    // than the noisy key it was meant to replace.
    //
    // Nor may that column be corrected in place. Its OTHER reader is the decay
    // clock the user watches count down on every chip, and v27 says why a
    // re-stamp is off the table: "a restore must not re-deal every surviving
    // chat a different death date than the one the user has been watching".
    // Correcting the sort would silently move 35 expiry dates. So: a second
    // column, with one writer, and v27's column left exactly as it is.
    //
    // ── THE BACKFILL: THE SYNTHETIC CLOCKS IDENTIFY THEMSELVES ───────────────
    // v27 stamped every row it touched at `boot + staggeredClockOffset(id)` for
    // ONE boot instant. Subtracting that offset therefore maps every row it
    // backfilled — and only those — back onto that single shared value, while a
    // clock a real message has since reset lands on some unrelated instant. The
    // population is recoverable exactly, with no stored flag, because the offset
    // was already required to be a pure function of the id.
    //
    // So: take the most common `clock_started_at - offset(id)` across the table.
    // With ≥ 2 rows agreeing, that value is v27's boot and every row at it is
    // UNTOUCHED — its clock says nothing about the user and is discarded. Every
    // other row's clock IS a user act (a send, or an unarchive, both of which go
    // through TabStore.resetClock) and is kept.
    //
    //   last_user_at = MAX(created_at, clock_started_at)  for a touched row
    //                = created_at                         for an untouched one
    //
    // `created_at` is the floor in both arms and is itself a genuine user touch
    // — somebody made this chat — so an untouched chat is not guessed at, it is
    // ranked by the last thing about it anyone can actually vouch for. It sinks
    // below everything you have messaged since, which is where it belongs, and
    // it can never be in the future.
    //
    // Verified against the live 85-tab database before it was written: one
    // candidate boot with 35 rows, every runner-up with exactly 1, and all 4 of
    // the future-stamped clocks inside the 35. 50 rows kept a real user send.
    //
    // ── HOW IT DEGRADES, IN BOTH DIRECTIONS ──────────────────────────────────
    // Fewer than 2 rows agree (a small or heavily-used install where v27 left
    // nothing untouched): no population to discard, every clock is read as real.
    // A row whose clock happens to collide with the boot value is read as
    // untouched and falls back to `created_at` — one row, one rank, no lie.
    // Both errors cost a position in a list; neither can produce a timestamp
    // nobody earned, which is the failure v27's backfill actually shipped.
    //
    // A guard the arithmetic does not need but the data does: a kept clock is
    // clamped to the migration instant. It cannot be in the future by
    // construction (only the discarded population is), and clamping means a
    // clock-skewed row cannot outrank the present anyway.
    version: 33,
    sql: 'ALTER TABLE tabs ADD COLUMN last_user_at INTEGER;',
    apply: (db) => {
      const now = Date.now();
      const rows = db
        .prepare('SELECT id, created_at, clock_started_at FROM tabs WHERE last_user_at IS NULL')
        .all() as Array<{ id: string; created_at: number; clock_started_at: number | null }>;

      // The mode of `clock_started_at - offset(id)` — v27's boot, if it is
      // still legible in this table.
      const tally = new Map<number, number>();
      for (const r of rows) {
        if (r.clock_started_at === null) continue;
        const boot = r.clock_started_at - staggeredClockOffset(r.id);
        tally.set(boot, (tally.get(boot) ?? 0) + 1);
      }
      let syntheticBoot: number | null = null;
      let best = 1; // ≥ 2 to count: one row agreeing with itself is not a population
      for (const [boot, n] of tally) {
        if (n > best) {
          best = n;
          syntheticBoot = boot;
        }
      }

      const update = db.prepare('UPDATE tabs SET last_user_at = ? WHERE id = ?');
      for (const r of rows) {
        const synthetic =
          r.clock_started_at === null ||
          (syntheticBoot !== null &&
            r.clock_started_at - staggeredClockOffset(r.id) === syntheticBoot);
        const touched = synthetic ? r.created_at : Math.min(r.clock_started_at as number, now);
        update.run(Math.max(r.created_at, touched), r.id);
      }
    },
  },
  {
    // THE WORKERS THAT FINISHED BEFORE ROUNDS EXISTED.
    //
    // `spawn_rounds` only records what happens after v32 lands, and five workers
    // had already been spawned, run and retired by then — so the user watched
    // five jobs finish with nothing in the conversation at all. Their rounds are
    // reconstructible from what the row already says, exactly, with no model
    // call and no guess:
    //
    //   started_at  = created_at    the spawn IS the handover, for the first round
    //   ended_at    = retired_at    NULL for one still running, which is right
    //   report      = spawn_report  whatever was generated for it, if anything
    //
    // ONE round per child, because that is all the tab columns can express —
    // which is the whole reason the table exists. A worker re-tasked four times
    // before this ran gets one round covering the lot, and that is the honest
    // limit of the data rather than a defect of the backfill: the boundaries of
    // rounds 2..N were never written down anywhere. (The archive knows them, at
    // its own 15-minute lag — see the v32 note. Not worth a model call or a scan
    // for history nobody is looking at.)
    //
    // A RETIRED CHILD WITH NO REPORT STILL GETS ITS ROUND. An honest empty card
    // beats no card: the round is the record that it ran and finished, and the
    // missing summary is a separate fact the card says out loud.
    //
    // IDEMPOTENT, and by the data rather than by the version gate: it inserts
    // only for children with NO round at all. The gate already prevents a second
    // pass, but a migration that would double every card in every conversation
    // if it ever ran twice is one restore-from-backup away from doing it.
    version: 34,
    apply: (db) => {
      const orphans = db
        .prepare(
          `SELECT t.id, t.created_at, t.retired_at, t.spawn_report, t.spawn_report_state
             FROM tabs t
            WHERE t.spawned_by IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM spawn_rounds r WHERE r.tab_id = t.id)`,
        )
        .all() as Array<{
        id: string;
        created_at: number;
        retired_at: number | null;
        spawn_report: string | null;
        spawn_report_state: string | null;
      }>;
      const ins = db.prepare(
        `INSERT INTO spawn_rounds (id, tab_id, started_at, ended_at, report, report_state)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const t of orphans) {
        // A deterministic id, so a restore that somehow reaches this twice
        // collides on the primary key rather than inserting a twin.
        ins.run(
          `backfill-${t.id}`,
          t.id,
          t.created_at,
          t.retired_at,
          t.spawn_report,
          t.spawn_report_state,
        );
      }
    },
  },
  {
    // WHO SENT THE MESSAGE — provenance for a message delivered INTO a chat.
    //
    // `muxpad agent send` drops a message into another chat's conversation, and
    // on the receiving side it has always rendered as an ordinary user bubble.
    // A coordinator's multi-paragraph brief is therefore indistinguishable from
    // something the human typed, in the worker's own transcript. This table is
    // the record that says otherwise.
    //
    // ── WHY A ROW AND NOT A MARKER IN THE TEXT ───────────────────────────────
    // The cron fire solves the same problem the other way: `renderCronMarker`
    // wraps the prompt in a `<muxpad-cron>` block that IS delivered to the
    // model, deliberately, because a scheduled job has to tell the agent it is
    // not a human speaking.
    //
    // A chat-to-chat send must not do that. Prepending a block would change the
    // prompt every worker in the fleet receives — a behaviour change wearing a
    // presentation change's clothes. So this follows `spawn_rounds` instead: a
    // muxpad-owned row, joined into the conversation by the client. muxpad does
    // not write the agent's transcript (it tails the harness's file), so a
    // sender label could never have been a transcript row anyway.
    //
    // ── WHY THE JOIN KEY IS A HASH OF THE TEXT ───────────────────────────────
    // The row and the bubble share no id, and the obvious substitute — the
    // timestamp — does not work: a send that lands mid-turn is persisted to the
    // server-side queue and delivered when that turn ends, which on a long turn
    // is many minutes later. The TEXT survives that trip unchanged, so it is
    // what the two sides agree on. `at` is kept anyway, to break ties when the
    // same text was sent twice, and to age rows out.
    //
    // ── WHY THE TEXT ITSELF IS NOT STORED ────────────────────────────────────
    // It is already in the transcript. The messages this exists for run to
    // several hundred lines; a second copy per send would grow the database by
    // the size of the conversation for no fact it does not already hold.
    //
    // `from_tab_id` is the SENDING CHAT, resolved server-side from the pane the
    // sender ran in — never a name supplied by the caller, so a card cannot be
    // made to claim a chat it did not come from. NULL means muxpad recorded a
    // send it cannot attribute, which renders as an ordinary bubble.
    //
    // ON DELETE CASCADE on the receiving tab, for the same reason `spawn_rounds`
    // has one: provenance for a conversation that is gone is nothing. The
    // SENDER is deliberately NOT a foreign key — deleting the coordinator must
    // not erase the record that it once briefed a worker; an id that no longer
    // resolves renders as an unattributed bubble, which is honest.
    // IF NOT EXISTS, for the reason v34 states in its own note: a restore from
    // backup is one step from re-running a migration, and the version gate is
    // not the only thing that decides whether this runs twice. `migrations.test`
    // exercises exactly that — it clears `schema_version` above a point and runs
    // the tail again — so a bare CREATE here fails every later migration's test.
    version: 35,
    sql: `
      CREATE TABLE IF NOT EXISTS inbound_messages (
        id          TEXT PRIMARY KEY,
        tab_id      TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
        at          INTEGER NOT NULL,
        text_key    TEXT NOT NULL,
        from_tab_id TEXT
      );
      CREATE INDEX IF NOT EXISTS inbound_messages_tab ON inbound_messages(tab_id, at);
    `,
  },
  {
    // ── ONE-TIME CRONS ───────────────────────────────────────────────────────
    // A cron expression naming BOTH a month and a day-of-month — `0 7 24 9 *`,
    // "07:00 on September 24th" — has always been this product's idiom for "do
    // this once", because there was no other way to say it. The agent
    // instructions spell that out and then tell you to delete the row by hand
    // afterwards.
    //
    // Nobody ever does. Measured on the live database before this migration:
    // three of five crons were one-offs by that idiom, two had already fired
    // and done their job, and both were sitting enabled with `next_due_at` in
    // SEPTEMBER 2027 — a reminder about a META option and a wifi check, queued
    // to go off again a year later. The "delete it afterwards" instruction had
    // a 0% compliance rate, which is the correct way to read an instruction
    // nobody follows: the design was wrong, not the user.
    //
    // So the idiom becomes a stored fact. `once` is set here for every dated
    // schedule, and a fired one is retired on the spot rather than rolled
    // forward — which cleans up the two live stragglers as part of the upgrade
    // instead of leaving them for somebody to notice in 2027.
    //
    // Deliberately NOT deleted: a retired one-off keeps its row, its history
    // and its place in `cron list`. "It ran and it is done" and "it never
    // existed" are different things, and only one of them is true.
    version: 36,
    // `apply`, not `sql`, for two reasons. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, and the idempotency test re-runs migrations
    // with the version rows deleted on purpose ("a restore from backup is one
    // step from running it"). And the dated-schedule test is a field check that
    // SQL can only fake with brittle GLOBs — in JS it is what it says it is.
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(crons)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'once')) {
        db.exec('ALTER TABLE crons ADD COLUMN once INTEGER NOT NULL DEFAULT 0');
      }
      const rows = db.prepare('SELECT id, schedule, last_fire_at FROM crons').all() as Array<{
        id: string;
        schedule: string;
        last_fire_at: number | null;
      }>;
      for (const r of rows) {
        // RE-IMPLEMENTED HERE, not imported from cron/schedule.ts, and that is
        // deliberate rather than an oversight to tidy up later. A migration ran
        // once against the data as it was; if it imported the live predicate it
        // would silently change behaviour every time that predicate is refined,
        // and replaying history would no longer reproduce it. The duplication
        // is the stability. (They agree today — see `isDatedSchedule`.)
        //
        // Dated = a specific day-of-month AND a specific month. Both must be
        // pinned: `0 9 1 * *` is monthly and `0 9 * 9 *` is every day in
        // September, and neither is a one-off.
        const f = r.schedule.trim().split(/\s+/);
        const dom = f[2];
        const mon = f[3];
        const dated =
          f.length >= 5 &&
          dom !== undefined &&
          mon !== undefined &&
          dom !== '*' &&
          mon !== '*' &&
          !dom.includes('*') &&
          !mon.includes('*');
        if (!dated) continue;
        db.prepare('UPDATE crons SET once = 1 WHERE id = ?').run(r.id);
        // …and a one-off that ALREADY fired is done now, not next year.
        if (r.last_fire_at !== null) {
          db.prepare("UPDATE crons SET enabled = 0, last_status = 'done' WHERE id = ?").run(r.id);
        }
      }
    },
  },
  {
    // ORPHANED ATTACHMENT FILES, and the trigger that stops them being made.
    //
    // `attachments.pane_id` is `ON DELETE CASCADE`, so deleting a pane — or a
    // tab, or a workspace, which cascade into panes — removes the attachment
    // ROWS. Nothing has ever removed the FILES. Measured on a real install:
    // 1493 files on disk against 794 rows, so 699 files and 348 MB that no
    // query can reach and no sweep collected, growing with every chat deleted.
    //
    // A TRIGGER, not a call in each delete path, for the same reason
    // `pending_pane_kills` exists: the cascade is SQLite's and the application
    // never sees it. PaneStore.delete is not the chokepoint — a `DELETE FROM
    // tabs` reaches panes without passing through it, and a workspace delete
    // reaches them through two cascades. A trigger on the attachments row is
    // the only place every path converges.
    //
    // The unlink itself is deferred rather than done here: a trigger cannot
    // touch the filesystem, and it must not try — the DELETE has to commit
    // whether or not a file can be removed. The sweeper owns the retry, same
    // division of labour as the kill queue.
    version: 37,
    // IF NOT EXISTS on both, because the idempotency test re-runs every
    // migration with the version rows deleted ("a restore from backup is one
    // step from running it") — and it caught this one bare.
    sql: `
      CREATE TABLE IF NOT EXISTS pending_attachment_unlinks (
        path       TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS attachments_unlink_on_delete
      AFTER DELETE ON attachments
      BEGIN
        INSERT OR IGNORE INTO pending_attachment_unlinks (path, created_at)
        VALUES (OLD.path, CAST(strftime('%s','now') AS INTEGER) * 1000);
      END;
    `,
  },
  {
    // THE JOIN — `spawn_rounds.delivered_at`: has this child's result been put
    // into its parent's conversation yet?
    //
    // `apply` rather than `sql` for migration 36's first reason: SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, and the idempotency test re-runs every
    // migration with the version rows deleted.
    //
    // ─── THE BACKFILL IS THE WHOLE POINT OF THIS MIGRATION ──────────────────
    // Every round that already ended is stamped DELIVERED, and it is the one
    // line here that cannot be left out. `delivered_at IS NULL` is the queue
    // the new sweeper drains, so without this the first boot after the upgrade
    // would read 181 finished historical rounds as a pending backlog and flush
    // every one of them into its parent — the three big orchestrators would
    // each be handed a message reporting on dozens of workers that finished
    // days ago, and a cron or two would fire on top of it.
    //
    // Stamped with `ended_at` (not `now`) so the column reads as what it is: a
    // fact about when the round's result was settled. An unfinished round is
    // left NULL — it has produced nothing to deliver, and it becomes eligible
    // the normal way when it closes.
    version: 38,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(spawn_rounds)').all() as Array<{ name: string }>;
      // THE BACKFILL IS INSIDE THE ADD, and that placement is the careful part.
      // Run unconditionally it would also fire on a RE-RUN (the idempotency
      // test's second pass, or a restore from backup that lost schema_version)
      // — and by then the column is live, so every round legitimately WAITING
      // to be delivered would be stamped as already delivered and its report
      // lost silently. The column existing is proof the backfill already ran.
      if (!cols.some((c) => c.name === 'delivered_at')) {
        db.exec('ALTER TABLE spawn_rounds ADD COLUMN delivered_at INTEGER');
        db.exec('UPDATE spawn_rounds SET delivered_at = ended_at WHERE ended_at IS NOT NULL');
      }
    },
  },
  {
    // CHAT CARDS — named persistent blocks pinned at the top of a conversation.
    // See shared/src/cards.ts for what they are and why muxpad does not decide
    // their content.
    //
    // UNIQUE (tab_id, name) is the whole semantics: `card set build` twice
    // updates one card rather than growing a list, so the name is an identity
    // and the write is an upsert. Without it a chatty writer would stack a new
    // card per update — which is the transcript behaviour cards exist to
    // replace.
    //
    // ON DELETE CASCADE because a card is part of its chat and means nothing
    // without it. Unlike attachments (migration 37) there are no FILES behind a
    // card, so the cascade is the whole cleanup — no queue, no sweeper.
    version: 39,
    sql: `
      CREATE TABLE IF NOT EXISTS tab_cards (
        id         TEXT PRIMARY KEY,
        tab_id     TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        content    TEXT NOT NULL,
        format     TEXT NOT NULL DEFAULT 'text',
        every_ms   INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tab_id, name)
      );
      CREATE INDEX IF NOT EXISTS tab_cards_by_tab ON tab_cards (tab_id, created_at);
    `,
  },
  {
    // FOLDED CRONS — render the delivered prompt collapsed behind a caret.
    //
    // A cron that refreshes a card injects the same plumbing every fire ("run
    // this, write the result there") and nobody reads it twice; 22 fires in the
    // Investing chat are 22 copies of one instruction.
    //
    // Named `fold`, NOT `quiet`: `crons.quiet_mins` already means "do not barge
    // into a live conversation", and two unrelated quiets on one row is a trap
    // for whoever reads this schema next. The flag is the AUTHOR's
    // because only they know whether the prompt is plumbing or content.
    //
    // It hides the prompt and nothing else — the agent's reply is an ordinary
    // message and stays visible, which is what keeps a failed fire from
    // vanishing without needing a special case for failure.
    //
    // `apply`, not `sql`: SQLite has no ADD COLUMN IF NOT EXISTS and the
    // idempotency test re-runs every migration with the version rows deleted.
    version: 40,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(crons)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'fold')) {
        db.exec('ALTER TABLE crons ADD COLUMN fold INTEGER NOT NULL DEFAULT 0');
      }
    },
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
