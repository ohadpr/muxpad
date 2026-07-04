import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { PaneSpec } from '@muxpad/shared';

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
  created_at: number;
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
  }): PaneSpec {
    const id = ulid();
    const now = Date.now();
    const kind = input.kind ?? 'shell';
    const url = input.url ?? null;
    const shell = input.shell ?? null;
    const cwd = input.cwd ?? null;
    const startup_cmd = input.startup_cmd ?? null;
    const env = input.env ?? null;
    this.db
      .prepare(
        'INSERT INTO panes (id, tab_id, kind, url, shell, startup_cmd, cwd, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.tab_id, kind, url, shell, startup_cmd, cwd, env ? JSON.stringify(env) : null, now);
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
    this.db
      .prepare('UPDATE panes SET name = ? WHERE id = ?')
      .run(trimmed ? trimmed : null, id);
  }

  updateUrl(id: string, url: string): void {
    this.db.prepare('UPDATE panes SET url = ? WHERE id = ? AND kind = ?').run(url, id, 'url');
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
      created_at: x.created_at,
    };
  }
}
