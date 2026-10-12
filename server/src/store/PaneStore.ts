import {
  type AgentMode,
  BASELINE_AGENT_MODE,
  type PaneSpec,
  coerceAgentMode,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

interface PaneRow {
  id: string;
  tab_id: string;
  kind: 'shell' | 'url';
  url: string | null;
  shell: string | null;
  startup_cmd: string | null;
  cwd: string | null;
  env: string | null;
  name: string | null;
  face: 'terminal' | 'web' | 'chat';
  face_url: string | null;
  unread: number;
  mode: string | null;
  created_at: number;
  parked_at: number | null;
}

export class PaneStore {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    tab_id: string;
    kind?: 'shell' | 'url';
    url?: string | null;
    shell?: string | null;
    cwd?: string | null;
    startup_cmd?: string | null;
    env?: Record<string, string> | null;
    face?: 'terminal' | 'web' | 'chat';
    mode?: AgentMode;
  }): PaneSpec {
    const id = ulid();
    const now = Date.now();
    const kind = input.kind ?? 'shell';
    const url = input.url ?? null;
    const shell = input.shell ?? null;
    const cwd = input.cwd ?? null;
    const startup_cmd = input.startup_cmd ?? null;
    const env = input.env ?? null;
    const face = input.face ?? 'terminal';
    // BASELINE, not DEFAULT_AGENT_MODE. This creates EVERY pane — plain
    // terminals, URL panes, split panes — and most of them have no agent in
    // them at all; stamping the house mode on a bare shell would make
    // `muxpad claude` (which reads this row to decide whether to
    // --append-system-prompt the contract) overlay a session the user
    // launched by hand. Callers that are genuinely creating an AGENT pane
    // pass DEFAULT_AGENT_MODE explicitly — agent-tab.ts and the pane-create
    // route both do.
    const mode = input.mode ?? BASELINE_AGENT_MODE;
    this.db
      .prepare(
        'INSERT INTO panes (id, tab_id, kind, url, shell, startup_cmd, cwd, env, face, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.tab_id,
        kind,
        url,
        shell,
        startup_cmd,
        cwd,
        env ? JSON.stringify(env) : null,
        face,
        mode,
        now,
      );
    return {
      id,
      tab_id: input.tab_id,
      kind,
      url,
      shell,
      startup_cmd,
      cwd,
      env,
      name: null,
      face,
      face_url: null,
      unread: false,
      mode,
      created_at: now,
    };
  }

  getById(id: string): PaneSpec | null {
    return this.row(this.db.prepare('SELECT * FROM panes WHERE id = ?').get(id));
  }

  listByTab(tabId: string): PaneSpec[] {
    const rows = this.db
      .prepare('SELECT * FROM panes WHERE tab_id = ? ORDER BY created_at')
      .all(tabId) as PaneRow[];
    return rows.map((r) => this.row(r) as PaneSpec);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM panes WHERE id = ?').run(id);
  }

  /**
   * Runner-owned panes that currently need a process.
   *
   * Three ways to qualify, and the third was missing — which broke the
   * supervision half of the sweep that reads this:
   *
   *   a turn in flight      `agent_sessions.status = 'running'`
   *   queued work           something waiting in `agent_queue`
   *   AN UNRETIRED SUB-CHAT a worker that was given a job and has not finished
   *
   * The first two are the lazy-start policy: an idle chat starts when its next
   * send is queued, because keeping every historical chat resident is what put
   * 103 panes on this machine. That policy is right and is why the blanket
   * `startup_cmd LIKE 'muxpad agent%'` had to go.
   *
   * But it answers "should this pane be warm?", and the sweep also asks "has
   * this pane DIED?" — and a worker whose runner crashed between turns has
   * nothing in flight and nothing queued, so it scored zero on both counts and
   * was never looked at again. It stayed `live` forever: no give-up, no
   * `done_reason: 'died'`, and its round left open, which is the parent's spawn
   * card spinning for good. ws-respawn pins exactly that and was failing.
   *
   * A sub-chat is the one pane that is SUPPOSED to be running without having to
   * prove it each time — that is what spawning one means. It cannot reopen the
   * resurrection bug: a finished worker has `retired_at` set and is excluded by
   * the clause above, and a historical top-level chat has no `spawned_by` at
   * all. Measured on this machine at the time of the change: 35 live agent
   * tabs, 0 of them unretired sub-chats.
   */
  /**
   * Agent panes that are CANDIDATES for parking — the mirror of
   * `listAgentPanes`, which answers "which panes need a process".
   *
   * Returns the facts the decision needs (see agent-park.ts) in one query
   * rather than a lookup per pane: on this machine the sweep would otherwise be
   * five round trips times a hundred-odd panes, every ten minutes, to park
   * nothing most of the time.
   *
   * `watched` is deliberately NOT here. Who has a chat open is a fact about
   * live websockets, which only ws.ts knows; the caller supplies it.
   */
  listParkCandidates(): Array<{
    pane: PaneSpec;
    status: string | null;
    queued: number;
    openRounds: number;
    isSubChat: boolean;
    parked: boolean;
    lastActivityAt: number | null;
    retired: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT p.*,
                s.status AS _status,
                (SELECT COUNT(*) FROM agent_queue q WHERE q.pane_id = p.id) AS _queued,
                (SELECT COUNT(*) FROM spawn_rounds r
                  WHERE r.tab_id = p.tab_id AND r.ended_at IS NULL) AS _rounds,
                (t.spawned_by IS NOT NULL) AS _sub,
                t.last_activity_at AS _active,
                t.retired_at AS _retired
           FROM panes p
           JOIN tabs t ON t.id = p.tab_id
      LEFT JOIN agent_sessions s ON s.pane_id = p.id
          -- RETIRED TABS ARE INCLUDED, and they are the point. A chat that has
          -- left the live list is finished by definition, yet nothing ever
          -- stopped its process: measured here, 84 of 123 runners belonged to
          -- retired tabs. listAgentPanes excludes them precisely because they
          -- must not be auto-started, which is the same fact read the other way
          -- round — they are the safest thing on the machine to stop.
          WHERE p.startup_cmd LIKE 'muxpad agent%'`,
      )
      .all() as Array<
      PaneRow & {
        _status: string | null;
        _queued: number;
        _rounds: number;
        _sub: number;
        _active: number | null;
        _retired: number | null;
      }
    >;
    return rows.map((r) => ({
      pane: this.row(r) as PaneSpec,
      status: r._status,
      queued: r._queued,
      openRounds: r._rounds,
      isSubChat: r._sub === 1,
      parked: r.parked_at !== null,
      lastActivityAt: r._active,
      retired: r._retired !== null,
    }));
  }

  /** muxpad stopped this pane's process on purpose. */
  park(id: string, at: number = Date.now()): void {
    this.db.prepare('UPDATE panes SET parked_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * …and it is wanted again. Returns true if it WAS parked, which is what lets
   * the caller say "waking" exactly once rather than on every sweep.
   */
  unpark(id: string): boolean {
    // `AND parked_at IS NOT NULL` is load-bearing: SQLite counts rows MATCHED,
    // not rows whose value changed, so without it this reports true for a pane
    // that was never parked — and the caller uses the answer to decide whether
    // to say "waking", which would then be said on every ordinary send.
    return (
      this.db
        .prepare('UPDATE panes SET parked_at = NULL WHERE id = ? AND parked_at IS NOT NULL')
        .run(id).changes > 0
    );
  }

  isParked(id: string): boolean {
    const r = this.db.prepare('SELECT parked_at FROM panes WHERE id = ?').get(id) as
      | { parked_at: number | null }
      | undefined;
    return !!r && r.parked_at !== null;
  }

  listAgentPanes(): PaneSpec[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM panes p
           JOIN tabs t ON t.id = p.tab_id
      LEFT JOIN agent_sessions s ON s.pane_id = p.id
          WHERE p.startup_cmd LIKE 'muxpad agent%'
            AND t.retired_at IS NULL
            AND (
              s.status = 'running'
              OR EXISTS (SELECT 1 FROM agent_queue q WHERE q.pane_id = p.id)
              OR t.spawned_by IS NOT NULL
            )`,
      )
      .all() as PaneRow[];
    return rows.map((r) => this.row(r) as PaneSpec);
  }

  /**
   * Every supervised app-server pane: `muxpad serve --url … -- <command>`,
   * which runs a local web server in the pane and declares its URL. Same
   * durable marker idea as {@link listAgentPanes} — the startup_cmd is what
   * survives a ptyd restart, a reboot, and a main-server restart.
   *
   * Used by the serve supervisor (serve-supervisor.ts). Agent panes came back
   * after a ptyd restart because the dead-runner sweep rebuilt them; serve
   * panes did not, because nothing swept them and their pty is only created
   * lazily when a browser attaches to the TERMINAL face — which never happens
   * for a pane the user watches through its web face. The app just stayed down.
   *
   * `kind = 'shell'` is a hard filter, not decoration: ensurePane on a URL pane
   * (shell = NULL) crashes node-pty.
   *
   * Registered APPS are serve panes too — that reuse is the whole design (see
   * apps/AppRegistry.ts) — so they are swept by exactly this query, and get the
   * ptyd-restart recovery for free. The ONE exception is an app the user has
   * STOPPED: `enabled = 0` means "I turned this off", and a supervisor that
   * helpfully brought it back two seconds later would be overriding an explicit
   * decision, which is the same line this sweep already refuses to cross for a
   * Ctrl-C'd serve loop.
   */
  listServePanes(): PaneSpec[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM panes p
           WHERE p.kind = 'shell'
             AND p.startup_cmd LIKE 'muxpad serve%'
             AND NOT EXISTS (
               SELECT 1 FROM apps a WHERE a.pane_id = p.id AND a.enabled = 0
             )`,
      )
      .all() as PaneRow[];
    return rows.map((r) => this.row(r) as PaneSpec);
  }

  /**
   * Reparent a pane to a different tab. Used by the pane-move endpoint; the
   * pane's runtime/PTY is keyed by pane id and is unaffected (it keeps
   * running). Caller is responsible for fixing up the source and destination
   * tabs' layout trees.
   */
  setTab(id: string, tabId: string): void {
    this.db.prepare('UPDATE panes SET tab_id = ? WHERE id = ?').run(tabId, id);
  }

  /**
   * Persist the pane's current working directory. Called by the runtime when
   * it polls the live shell's cwd; this is what makes "respawn at the cwd
   * the user was actually in" work after a daemon restart, instead of
   * always falling back to creation-time cwd.
   */
  updateCwd(id: string, cwd: string): void {
    this.db.prepare('UPDATE panes SET cwd = ? WHERE id = ?').run(cwd, id);
  }

  /**
   * Snapshot of `(id, cwd)` for every shell pane that has a persisted cwd.
   * Used at startup to seed PtydCache before ptyd's first `flushCwds()`
   * arrives — without this, handlers that synchronously read `cache.getCwd()`
   * during the boot window would see null even when SQLite has a usable
   * last-known value. URL panes and shell panes with cwd=null are skipped.
   */
  listCwds(): Array<{ id: string; cwd: string }> {
    const rows = this.db
      .prepare("SELECT id, cwd FROM panes WHERE cwd IS NOT NULL AND kind = 'shell'")
      .all() as Array<{ id: string; cwd: string }>;
    return rows;
  }

  /**
   * Set (or clear) the pane's user-given name. Passing null/'' clears it,
   * reverting the tab-strip label to the live-derived title. Pure SQLite —
   * ptyd never sees this, so a rename can't disturb the running PTY.
   */
  setName(id: string, name: string | null): void {
    const trimmed = name?.trim();
    this.db.prepare('UPDATE panes SET name = ? WHERE id = ?').run(trimmed ? trimmed : null, id);
  }

  updateUrl(id: string, url: string): void {
    this.db.prepare('UPDATE panes SET url = ? WHERE id = ? AND kind = ?').run(url, id, 'url');
  }

  /**
   * Persist which face the pane shows (terminal | web | chat) and, for the
   * web face, the chosen URL. `face_url` is kept when omitted so a
   * terminal⇄chat flip doesn't forget the last web URL.
   */
  setFace(id: string, face: 'terminal' | 'web' | 'chat', face_url?: string | null): void {
    if (face_url === undefined) {
      this.db.prepare('UPDATE panes SET face = ? WHERE id = ?').run(face, id);
    } else {
      this.db
        .prepare('UPDATE panes SET face = ?, face_url = ? WHERE id = ?')
        .run(face, face_url, id);
    }
  }

  /**
   * Update only the pane's startup command. Used by the agent-runner attach
   * path to make agent panes self-healing: once the session id is known the
   * startup command becomes `muxpad agent --resume <sid>`, so a ptyd restart
   * (or reboot) re-runs it and the pane springs back into the same session.
   */
  setStartupCmd(id: string, startup_cmd: string | null): void {
    this.db
      .prepare("UPDATE panes SET startup_cmd = ? WHERE id = ? AND kind = 'shell'")
      .run(startup_cmd, id);
  }

  /**
   * Flip a pane between kind=shell and kind=url. Caller is responsible for
   * killing any live PTY before calling this (the row mutation is
   * unconditional and lossy by design — switching kinds discards whatever
   * was in the old kind's columns).
   */
  updateKind(
    id: string,
    next: {
      kind: 'shell' | 'url';
      url?: string | null;
      shell?: string | null;
      cwd?: string | null;
      startup_cmd?: string | null;
    },
  ): void {
    this.db
      .prepare(
        'UPDATE panes SET kind = ?, url = ?, shell = ?, cwd = ?, startup_cmd = ? WHERE id = ?',
      )
      .run(
        next.kind,
        next.url ?? null,
        next.shell ?? null,
        next.cwd ?? null,
        next.startup_cmd ?? null,
        id,
      );
  }

  private row(r: unknown): PaneSpec | null {
    if (!r) return null;
    const x = r as PaneRow;
    return {
      id: x.id,
      tab_id: x.tab_id,
      kind: x.kind,
      url: x.url,
      shell: x.shell,
      startup_cmd: x.startup_cmd,
      cwd: x.cwd,
      env: x.env ? (JSON.parse(x.env) as Record<string, string>) : null,
      name: x.name ?? null,
      face: x.face ?? 'terminal',
      face_url: x.face_url ?? null,
      unread: !!x.unread,
      // Anything unrecognized (a NULL from before the column existed, a
      // pre-rename 'do'/'deep' written by an older build someone downgraded
      // to and back) reads through the tolerant coercion, then falls to the
      // BASELINE — 'agent', nothing injected. A row can therefore never
      // surface a value AgentModeSchema would reject.
      mode: coerceAgentMode(x.mode) ?? BASELINE_AGENT_MODE,
      created_at: x.created_at,
    };
  }

  /**
   * Set the pane's agent mode (Chat / Agent). Pure SQLite — the
   * live session is told separately (a `mode` frame relayed to its runner);
   * see agent-modes.ts for why a running session can only be NOTIFIED, not
   * re-prompted.
   */
  setMode(id: string, mode: AgentMode): void {
    this.db.prepare('UPDATE panes SET mode = ? WHERE id = ?').run(mode, id);
  }

  /**
   * "Done, unreviewed" flag (bold name). Set true when an agent turn finishes
   * here unobserved (or manually); cleared when the pane is viewed. Persisted,
   * so results found while you were away survive a restart. Distinct from the
   * runtime BEL attention (red dot), which lives in the ptyd cache.
   */
  setUnread(id: string, unread: boolean): void {
    this.db.prepare('UPDATE panes SET unread = ? WHERE id = ?').run(unread ? 1 : 0, id);
  }
}
