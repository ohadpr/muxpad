import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export type ViewMode = 'terminal' | 'chat';
export type Writer = 'tui' | 'headless' | 'sdk' | 'none';

export interface AgentSession {
  /** muxpad's own stable handle — survives every provider session-id hop. */
  id: string;
  pane_id: string;
  assistant: string;
  cwd: string | null;
  /** The live provider session-id (last one the SessionStart hook reported). */
  current_sid: string | null;
  /** Every provider session-id this pane's session has carried, in order. */
  lineage: string[];
  view_mode: ViewMode;
  writer: Writer;
  /** PID of the Claude TUI (from the wrapper's $$), for a clean SIGTERM handoff. Null if unknown. */
  tui_pid: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface AgentSessionRow {
  id: string;
  pane_id: string;
  assistant: string;
  cwd: string | null;
  current_sid: string | null;
  lineage: string;
  view_mode: ViewMode;
  writer: Writer;
  tui_pid: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/**
 * Tracks the Claude (later Codex/Cursor) session running in a pane so it can
 * be viewed/driven as a terminal or as web chat and switched between them.
 *
 * muxpad owns every launch via the `muxpad claude` wrapper, so discovery is
 * deterministic rather than fs-watched:
 *   - `register()` is called by the wrapper before it exec's claude, with the
 *     session-id it minted via `--session-id`;
 *   - `recordSessionId()` is called by the SessionStart hook the wrapper
 *     installs, which fires on fresh start / resume / compact / fork — so it
 *     is both how we learn the real id (the TUI ignores our `--session-id`
 *     for local persistence) and how the lineage grows.
 *
 * See docs/plans/2026-07-01-web-chat-session-switching.md.
 */
export class AgentSessionStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Register (or reset) the agent session for a pane at launch time. Upsert
   * by pane_id — one live agent session per pane; a re-launch in the same
   * pane resets it to a fresh terminal-owned session seeded with the minted
   * id.
   */
  register(input: {
    pane_id: string;
    assistant?: string | undefined;
    cwd?: string | null | undefined;
    session_id?: string | null | undefined;
    pid?: number | null | undefined;
  }): AgentSession {
    const existing = this.getByPane(input.pane_id);
    // A resume relaunch registers WITHOUT a session_id (claude rejects
    // --session-id alongside --resume); the SessionStart hook re-reports the
    // real id moments later. Keep the existing sid/lineage across that window
    // — wiping them to null bricks chat ("no session to drive") if the hook
    // is slow, fails, or the resume itself dies before it fires.
    return this.upsert(existing, {
      pane_id: input.pane_id,
      assistant: input.assistant ?? 'claude',
      cwd: input.cwd ?? null,
      current_sid: input.session_id ?? existing?.current_sid ?? null,
      // A fresh launch RESETS the lineage to the minted id (it's a new
      // conversation); a sid-less relaunch keeps the old lineage.
      lineage: input.session_id ? [input.session_id] : (existing?.lineage ?? []),
      tui_pid: input.pid ?? null,
      view_mode: 'terminal',
      writer: 'tui',
    });
  }

  /**
   * Record the real provider session-id reported by the SessionStart hook.
   * Sets `current_sid` and appends to the lineage if it's new. No-op (returns
   * null) if the pane has no registered session — a session muxpad didn't
   * launch is out of scope by design.
   */
  recordSessionId(pane_id: string, session_id: string): AgentSession | null {
    const existing = this.getByPane(pane_id);
    if (!existing) return null;
    const lineage = existing.lineage.includes(session_id)
      ? existing.lineage
      : [...existing.lineage, session_id];
    this.db
      .prepare(
        'UPDATE agent_sessions SET current_sid = ?, lineage = ?, updated_at = ? WHERE pane_id = ?',
      )
      .run(session_id, JSON.stringify(lineage), Date.now(), pane_id);
    return this.getByPane(pane_id);
  }

  /** Update the single-writer token — which surface currently drives the session. */
  setWriter(pane_id: string, writer: Writer): void {
    this.db
      .prepare('UPDATE agent_sessions SET writer = ?, updated_at = ? WHERE pane_id = ?')
      .run(writer, Date.now(), pane_id);
  }

  /** Update the live activity flag — 'running' while a headless turn is in flight, else 'idle'. */
  setStatus(pane_id: string, status: 'running' | 'idle'): void {
    this.db
      .prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE pane_id = ?')
      .run(status, Date.now(), pane_id);
  }

  /**
   * Attach an SDK agent runner to a pane's session: the runner (a long-lived
   * process inside the pane's pty, launched by `muxpad agent`) becomes the
   * single writer and the pane's shared face flips to chat. Upserts — a pane
   * that never ran `muxpad claude` gets a fresh row; an existing row keeps its
   * lineage and gains the runner's sid.
   */
  attachRunner(input: {
    pane_id: string;
    cwd?: string | null;
    session_id?: string | null;
  }): AgentSession {
    const existing = this.getByPane(input.pane_id);
    const sid = input.session_id ?? existing?.current_sid ?? null;
    const lineage = existing ? existing.lineage.slice() : [];
    if (sid && !lineage.includes(sid)) lineage.push(sid);
    return this.upsert(existing, {
      pane_id: input.pane_id,
      assistant: 'claude',
      cwd: input.cwd ?? existing?.cwd ?? null,
      current_sid: sid,
      lineage,
      tui_pid: null,
      view_mode: 'chat',
      writer: 'sdk',
    });
  }

  /** Shared launch-time upsert: one live agent session per pane. */
  private upsert(
    existing: AgentSession | null,
    next: {
      pane_id: string;
      assistant: string;
      cwd: string | null;
      current_sid: string | null;
      lineage: string[];
      tui_pid: number | null;
      view_mode: ViewMode;
      writer: Writer;
    },
  ): AgentSession {
    const now = Date.now();
    const lineage = JSON.stringify(next.lineage);
    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_sessions
             SET assistant = ?, cwd = ?, current_sid = ?, lineage = ?, tui_pid = ?,
                 view_mode = ?, writer = ?, status = 'idle', updated_at = ?
           WHERE pane_id = ?`,
        )
        .run(
          next.assistant,
          next.cwd,
          next.current_sid,
          lineage,
          next.tui_pid,
          next.view_mode,
          next.writer,
          now,
          next.pane_id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_sessions
             (id, pane_id, assistant, cwd, current_sid, lineage, tui_pid, view_mode, writer, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
        )
        .run(
          ulid(),
          next.pane_id,
          next.assistant,
          next.cwd,
          next.current_sid,
          lineage,
          next.tui_pid,
          next.view_mode,
          next.writer,
          now,
          now,
        );
    }
    return this.getByPane(next.pane_id) as AgentSession;
  }

  /** The pane's runner disconnected — release the single-writer token (only if a runner holds it). */
  detachRunner(pane_id: string): void {
    this.db
      .prepare(
        "UPDATE agent_sessions SET writer = 'none', status = 'idle', updated_at = ? WHERE pane_id = ? AND writer = 'sdk'",
      )
      .run(Date.now(), pane_id);
  }

  /**
   * Startup reconciliation. Headless turns live in the server process (the
   * ws layer's in-memory runner map), so any 'headless' writer or 'running'
   * status still in the DB when we come up belongs to a turn that died with
   * the previous process (restart mid-turn). Clear them so panes recover
   * instead of looking permanently driven/busy. SDK runners outlive the
   * server (they live in ptyd panes) but re-hello within seconds of the
   * server coming back — clear their writer too so a runner that died while
   * the server was down doesn't leave the pane looking driven forever.
   */
  reconcileStartup(): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE agent_sessions SET writer = 'none', updated_at = ? WHERE writer = 'headless' OR writer = 'sdk'",
      )
      .run(now);
    this.db
      .prepare("UPDATE agent_sessions SET status = 'idle', updated_at = ? WHERE status != 'idle'")
      .run(now);
  }

  /** Record the view muxpad last showed for this pane (terminal | chat). */
  setViewMode(pane_id: string, view_mode: ViewMode): void {
    this.db
      .prepare('UPDATE agent_sessions SET view_mode = ?, updated_at = ? WHERE pane_id = ?')
      .run(view_mode, Date.now(), pane_id);
  }

  getByPane(pane_id: string): AgentSession | null {
    return this.row(this.db.prepare('SELECT * FROM agent_sessions WHERE pane_id = ?').get(pane_id));
  }

  getById(id: string): AgentSession | null {
    return this.row(this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id));
  }

  list(): AgentSession[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC')
      .all() as AgentSessionRow[];
    return rows.map((r) => this.hydrate(r));
  }

  private row(raw: unknown): AgentSession | null {
    return raw ? this.hydrate(raw as AgentSessionRow) : null;
  }

  private hydrate(r: AgentSessionRow): AgentSession {
    return {
      id: r.id,
      pane_id: r.pane_id,
      assistant: r.assistant,
      cwd: r.cwd,
      current_sid: r.current_sid,
      lineage: JSON.parse(r.lineage) as string[],
      view_mode: r.view_mode,
      writer: r.writer,
      tui_pid: r.tui_pid ?? null,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}
