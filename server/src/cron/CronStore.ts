import type { Cron, CronRun } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { nextAfter, scheduleJitterMs } from './schedule.js';

const ulid = monotonicFactory();

/**
 * How many runs we keep per cron. The run log's whole job is turning silence
 * into a record you can look at — 50 is several weeks of a daily job and half
 * a day of a 15-minute one, which is the window anyone actually reads. Trimmed
 * on every insert (one indexed DELETE), because "prune it later" is how a
 * table that grows once per fire becomes the biggest thing in the DB.
 */
export const CRON_RUNS_KEEP = 50;

interface CronRow {
  id: string;
  name: string;
  schedule: string;
  tz: string;
  prompt: string;
  target_kind: string;
  target_pane: string | null;
  workspace_id: string | null;
  cwd: string | null;
  model: string | null;
  backend: string | null;
  mode: string | null;
  enabled: number;
  catchup: string;
  overlap: string;
  on_context: string;
  quiet_mins: number;
  jitter_ms: number;
  max_open: number;
  close_when_done: number;
  open_tabs: string;
  next_due_at: number;
  last_fire_at: number | null;
  last_status: string | null;
  fail_streak: number;
  created_at: number;
}

export interface CronCreateInput {
  name: string;
  schedule: string;
  tz: string;
  prompt: string;
  target_kind: 'pane' | 'new-tab';
  target_pane?: string | null;
  workspace_id?: string | null;
  cwd?: string | null;
  model?: string | null;
  backend?: string | null;
  mode?: string | null;
  catchup?: string;
  overlap?: string;
  on_context?: string;
  quiet_mins?: number;
  max_open?: number;
  close_when_done?: boolean;
  /** The NOMINAL next slot. `create` adds this cron's deterministic jitter and
   *  stores the sum — every reader sees when it will actually fire. */
  next_due_at: number;
}

/** SQLite access for `crons` + `cron_runs`. No policy — see CronScheduler. */
export class CronStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CronCreateInput): Cron {
    const id = ulid();
    // Deterministic, id-derived offset so N daily crons don't all fire in the
    // same second. Stored alongside the jittered `next_due_at` so the nominal
    // slot is recoverable exactly (next_due_at - jitter_ms) instead of being
    // re-derived — a re-derivation would drift the moment the estimate moved.
    const jitter = scheduleJitterMs(id, input.schedule, input.tz, input.next_due_at);
    this.db
      .prepare(
        `INSERT INTO crons (
           id, name, schedule, tz, prompt, target_kind, target_pane, workspace_id,
           cwd, model, backend, mode, enabled, catchup, overlap, on_context,
           quiet_mins, jitter_ms, max_open, close_when_done, open_tabs, next_due_at,
           last_fire_at, last_status, fail_streak, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, NULL, 0, ?)`,
      )
      .run(
        id,
        input.name,
        input.schedule,
        input.tz,
        input.prompt,
        input.target_kind,
        input.target_pane ?? null,
        input.workspace_id ?? null,
        input.cwd ?? null,
        input.model ?? null,
        input.backend ?? null,
        input.mode ?? null,
        input.catchup ?? 'once',
        input.overlap ?? 'skip',
        input.on_context ?? 'fire',
        input.quiet_mins ?? 0,
        jitter,
        input.max_open ?? 1,
        input.close_when_done ? 1 : 0,
        input.next_due_at + jitter,
        Date.now(),
      );
    return this.getById(id) as Cron;
  }

  getById(id: string): Cron | null {
    const r = this.db.prepare('SELECT * FROM crons WHERE id = ?').get(id) as CronRow | undefined;
    return r ? rowToCron(r) : null;
  }

  /** Resolve by id OR (case-insensitive) name — the CLI accepts both, since a
   *  ulid is not something a human retypes. Ambiguous names resolve to the
   *  oldest match; `cron list` shows the ids to disambiguate with. */
  resolve(ref: string): Cron | null {
    return (
      this.getById(ref) ??
      (() => {
        const r = this.db
          .prepare('SELECT * FROM crons WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC')
          .get(ref) as CronRow | undefined;
        return r ? rowToCron(r) : null;
      })()
    );
  }

  list(): Cron[] {
    return (this.db.prepare('SELECT * FROM crons ORDER BY created_at ASC').all() as CronRow[]).map(
      rowToCron,
    );
  }

  /** Enabled crons whose slot has arrived. The tick's ONE query per pass. */
  listDue(now: number): Cron[] {
    return (
      this.db
        .prepare('SELECT * FROM crons WHERE enabled = 1 AND next_due_at <= ? ORDER BY next_due_at')
        .all(now) as CronRow[]
    ).map(rowToCron);
  }

  /** Enabled crons targeting any of `paneIds` — the sidebar's ⏱ source. */
  listEnabledByPanes(paneIds: string[]): Cron[] {
    if (paneIds.length === 0) return [];
    const marks = paneIds.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT * FROM crons WHERE enabled = 1 AND target_kind = 'pane' AND target_pane IN (${marks})`,
        )
        .all(...paneIds) as CronRow[]
    ).map(rowToCron);
  }

  delete(id: string): boolean {
    const n = this.db.prepare('DELETE FROM crons WHERE id = ?').run(id).changes;
    this.db.prepare('DELETE FROM cron_runs WHERE cron_id = ?').run(id);
    return n > 0;
  }

  setEnabled(id: string, enabled: boolean, reanchorFrom?: number): void {
    if (reanchorFrom !== undefined) {
      // Re-anchoring on RESUME is what stops a paused-for-a-week cron waking up
      // to a week of catch-up it was deliberately not meant to run.
      const at = this.nextFireAfter(id, reanchorFrom);
      this.db
        .prepare('UPDATE crons SET enabled = ?, next_due_at = ?, fail_streak = 0 WHERE id = ?')
        .run(enabled ? 1 : 0, at, id);
    } else {
      this.db.prepare('UPDATE crons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    }
  }

  /**
   * When this cron next FIRES after `from` — the nominal slot plus its stored
   * jitter. ONE place computes it, so the tick's re-anchor, a resume and an
   * edit can't disagree about what "next" means.
   */
  nextFireAfter(id: string, from: number): number {
    const c = this.getById(id);
    if (!c) return from;
    return nextAfter(c.schedule, c.tz, from) + c.jitter_ms;
  }

  /** Apply an edit to the schedule/zone/prompt and re-anchor. The jitter is
   *  recomputed because its CAP depends on the interval — a cron moved from
   *  daily to every-2-minutes must not keep a 27-minute offset. */
  reschedule(
    id: string,
    opts: { schedule: string; tz: string; prompt: string; from: number },
  ): void {
    const jitter = scheduleJitterMs(id, opts.schedule, opts.tz, opts.from);
    this.db
      .prepare(
        'UPDATE crons SET prompt = ?, schedule = ?, tz = ?, jitter_ms = ?, next_due_at = ? WHERE id = ?',
      )
      .run(
        opts.prompt,
        opts.schedule,
        opts.tz,
        jitter,
        nextAfter(opts.schedule, opts.tz, opts.from) + jitter,
        id,
      );
  }

  /** How many crons are currently enabled — the runaway guard's input. */
  countEnabled(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM crons WHERE enabled = 1').get() as { n: number }
    ).n;
  }

  setNextDue(id: string, at: number): void {
    this.db.prepare('UPDATE crons SET next_due_at = ? WHERE id = ?').run(at, id);
  }

  /** Record the verdict of a fire. `ok` resets the failure streak; anything
   *  else increments it (see CronScheduler's auto-disable). */
  recordOutcome(id: string, opts: { at: number; status: string; ok: boolean }): number {
    this.db
      .prepare(
        `UPDATE crons SET last_fire_at = ?, last_status = ?,
           fail_streak = CASE WHEN ? THEN 0 ELSE fail_streak + 1 END
         WHERE id = ?`,
      )
      .run(opts.at, opts.status, opts.ok ? 1 : 0, id);
    return (
      (
        this.db.prepare('SELECT fail_streak AS n FROM crons WHERE id = ?').get(id) as
          | { n: number }
          | undefined
      )?.n ?? 0
    );
  }

  addRun(run: {
    cron_id: string;
    due_at: number;
    fired_at: number;
    target_pane?: string | null;
    target_tab?: string | null;
    outcome: string;
    detail?: string | null;
  }): CronRun {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO cron_runs (id, cron_id, due_at, fired_at, target_pane, target_tab, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        run.cron_id,
        run.due_at,
        run.fired_at,
        run.target_pane ?? null,
        run.target_tab ?? null,
        run.outcome,
        run.detail ?? null,
      );
    // Trim in the same call that grows it — the only way the bound is real.
    this.db
      .prepare(
        `DELETE FROM cron_runs WHERE cron_id = ? AND id NOT IN (
           SELECT id FROM cron_runs WHERE cron_id = ? ORDER BY fired_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(run.cron_id, run.cron_id, CRON_RUNS_KEEP);
    return {
      id,
      cron_id: run.cron_id,
      due_at: run.due_at,
      fired_at: run.fired_at,
      target_pane: run.target_pane ?? null,
      target_tab: run.target_tab ?? null,
      outcome: run.outcome,
      detail: run.detail ?? null,
    };
  }

  runs(cronId: string, limit = CRON_RUNS_KEEP): CronRun[] {
    return this.db
      .prepare('SELECT * FROM cron_runs WHERE cron_id = ? ORDER BY fired_at DESC, id DESC LIMIT ?')
      .all(cronId, limit) as CronRun[];
  }

  /** Tab ids this cron has open (new-tab mode), as last recorded. */
  openTabs(id: string): string[] {
    const r = this.db.prepare('SELECT open_tabs FROM crons WHERE id = ?').get(id) as
      | { open_tabs: string }
      | undefined;
    if (!r) return [];
    try {
      const parsed = JSON.parse(r.open_tabs);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  setOpenTabs(id: string, tabIds: string[]): void {
    this.db.prepare('UPDATE crons SET open_tabs = ? WHERE id = ?').run(JSON.stringify(tabIds), id);
  }
}

function rowToCron(r: CronRow): Cron {
  return {
    id: r.id,
    name: r.name,
    schedule: r.schedule,
    tz: r.tz,
    prompt: r.prompt,
    target_kind: r.target_kind === 'new-tab' ? 'new-tab' : 'pane',
    target_pane: r.target_pane,
    workspace_id: r.workspace_id,
    cwd: r.cwd,
    model: r.model,
    backend: r.backend,
    mode: r.mode,
    enabled: r.enabled === 1,
    catchup: r.catchup === 'skip' || r.catchup === 'all' ? r.catchup : 'once',
    overlap: r.overlap === 'queue' ? 'queue' : 'skip',
    on_context:
      r.on_context === 'compact-first' || r.on_context === 'rotate' || r.on_context === 'skip'
        ? r.on_context
        : 'fire',
    quiet_mins: r.quiet_mins,
    jitter_ms: r.jitter_ms,
    max_open: r.max_open,
    close_when_done: r.close_when_done === 1,
    next_due_at: r.next_due_at,
    last_fire_at: r.last_fire_at,
    last_status: r.last_status,
    fail_streak: r.fail_streak,
    created_at: r.created_at,
  };
}
