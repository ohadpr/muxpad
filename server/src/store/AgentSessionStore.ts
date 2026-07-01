import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export type ViewMode = 'terminal' | 'chat';
export type Writer = 'tui' | 'headless' | 'none';

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
  }): AgentSession {
    const now = Date.now();
    const assistant = input.assistant ?? 'claude';
    const cwd = input.cwd ?? null;
    const sid = input.session_id ?? null;
    const lineage = JSON.stringify(sid ? [sid] : []);
    const existing = this.getByPane(input.pane_id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_sessions
             SET assistant = ?, cwd = ?, current_sid = ?, lineage = ?,
                 view_mode = 'terminal', writer = 'tui', status = 'idle', updated_at = ?
           WHERE pane_id = ?`,
        )
        .run(assistant, cwd, sid, lineage, now, input.pane_id);
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_sessions
             (id, pane_id, assistant, cwd, current_sid, lineage, view_mode, writer, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'terminal', 'tui', 'idle', ?, ?)`,
        )
        .run(ulid(), input.pane_id, assistant, cwd, sid, lineage, now, now);
    }
    return this.getByPane(input.pane_id) as AgentSession;
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
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}
