import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { PaneSpec } from '@muxpad/shared';

const ulid = monotonicFactory();

interface PaneRow {
  id: string;
  tab_id: string;
  shell: string;
  startup_cmd: string | null;
  cwd: string;
  env: string | null;
  created_at: number;
}

export class PaneStore {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    tab_id: string;
    shell: string;
    cwd: string;
    startup_cmd?: string | null;
    env?: Record<string, string> | null;
  }): PaneSpec {
    const id = ulid();
    const now = Date.now();
    const startup_cmd = input.startup_cmd ?? null;
    const env = input.env ?? null;
    this.db
      .prepare(
        'INSERT INTO panes (id, tab_id, shell, startup_cmd, cwd, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.tab_id,
        input.shell,
        startup_cmd,
        input.cwd,
        env ? JSON.stringify(env) : null,
        now,
      );
    return {
      id,
      tab_id: input.tab_id,
      shell: input.shell,
      startup_cmd,
      cwd: input.cwd,
      env,
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
   * Persist the pane's current working directory. Called by the runtime when
   * it polls the live shell's cwd; this is what makes "respawn at the cwd
   * the user was actually in" work after a daemon restart, instead of
   * always falling back to creation-time cwd.
   */
  updateCwd(id: string, cwd: string): void {
    this.db.prepare('UPDATE panes SET cwd = ? WHERE id = ?').run(cwd, id);
  }

  private row(r: unknown): PaneSpec | null {
    if (!r) return null;
    const x = r as PaneRow;
    return {
      id: x.id,
      tab_id: x.tab_id,
      shell: x.shell,
      startup_cmd: x.startup_cmd,
      cwd: x.cwd,
      env: x.env ? (JSON.parse(x.env) as Record<string, string>) : null,
      created_at: x.created_at,
    };
  }
}
