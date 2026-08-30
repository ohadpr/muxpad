import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { CronScheduler } from '../cron/CronScheduler.js';
import { emitCronTabUpdate } from '../cron/CronScheduler.js';
import {
  ScheduleError,
  compileSchedule,
  isValidTimezone,
  nextAfter,
  systemTimezone,
} from '../cron/schedule.js';
import type { EventBus } from '../events.js';
import type { PtydCache } from '../ptyd-cache.js';
import { safeCwd } from '../safe-cwd.js';
import { PaneStore } from '../store/PaneStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';

/**
 * REST for `muxpad cron`. Thin: every scheduling decision lives in
 * CronScheduler, every schedule interpretation in cron/schedule.ts. What DOES
 * live here is validation, because two of these fields end up in a shell
 * command (`model`) or a spawned pane (`cwd`) and one is a user-authored
 * schedule that must fail loudly at creation rather than silently at 3am.
 */
export function cronsRoutes(deps: {
  db: Database.Database;
  cache: PtydCache;
  events: EventBus;
  scheduler?: CronScheduler | undefined;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);
  const workspaces = new WorkspaceStore(deps.db);
  // The scheduler owns the store; without one (HTTP-only tests) the routes
  // still work — they just can't fire.
  const store = () => deps.scheduler?.store ?? null;

  const bad = (message: string) => ({ error: { code: 'bad_request' as const, message } });

  app.get('/', (c) => {
    const s = store();
    if (!s) return c.json([]);
    return c.json(s.list());
  });

  app.post('/', async (c) => {
    const s = store();
    if (!s) return c.json(bad('scheduler unavailable'), 503);
    const parsed = z
      .object({
        // Names are a CLI handle (`muxpad cron pause pr-sweep`) and land in the
        // fire marker, so keep them plain.
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'name must be 1-64 chars of [A-Za-z0-9._-]'),
        // A cron expression OR a friendly phrase; compiled below.
        schedule: z.string().min(1),
        tz: z.string().optional(),
        prompt: z.string().min(1).max(8000),
        target_kind: z.enum(['pane', 'new-tab']),
        target_pane: z.string().optional(),
        workspace_id: z.string().optional(),
        cwd: z.string().optional(),
        // Baked into the pane's startup command (a shell string) — same gate
        // as POST /api/tabs.
        model: z
          .string()
          .regex(/^[A-Za-z0-9._[\]-]{1,64}$/)
          .optional(),
        backend: z.enum(['claude', 'codex', 'cursor']).optional(),
        mode: z.enum(['do', 'deep']).optional(),
        catchup: z.enum(['once', 'skip', 'all']).optional(),
        overlap: z.enum(['skip', 'queue']).optional(),
        on_context: z.enum(['fire', 'compact-first', 'rotate', 'skip']).optional(),
        quiet_mins: z
          .number()
          .int()
          .min(0)
          .max(24 * 60)
          .optional(),
        max_open: z.number().int().min(1).max(20).optional(),
        close_when_done: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad(parsed.error.issues[0]?.message ?? 'invalid body'), 400);
    const body = parsed.data;

    let schedule: string;
    try {
      schedule = compileSchedule(body.schedule);
    } catch (e) {
      if (e instanceof ScheduleError) return c.json(bad(e.message), 400);
      throw e;
    }
    const tz = body.tz ?? systemTimezone();
    if (!isValidTimezone(tz))
      return c.json(
        bad(`unknown timezone "${tz}" — use an IANA name like America/Los_Angeles`),
        400,
      );

    if (body.target_kind === 'pane') {
      if (!body.target_pane) return c.json(bad('target_pane required for a pane cron'), 400);
      const pane = panes.getById(body.target_pane);
      if (!pane) return c.json(bad(`pane ${body.target_pane} not found`), 400);
      // `pane_id` is the durable handle (the sid rotates on /clear and on
      // resume-drift), but only a RUNNER-OWNED pane has a drainer at all — a
      // read-only TUI pane would reject every fire forever. Refuse at creation.
      if (!pane.startup_cmd?.startsWith('muxpad agent'))
        return c.json(
          bad('target pane has no agent runner — crons can only drive `muxpad agent` panes'),
          400,
        );
    } else {
      if (!body.workspace_id) return c.json(bad('workspace_id required for a new-tab cron'), 400);
      if (!workspaces.getById(body.workspace_id))
        return c.json(bad(`workspace ${body.workspace_id} not found`), 400);
    }

    const now = Date.now();
    const cron = s.create({
      name: body.name,
      schedule,
      tz,
      prompt: body.prompt,
      target_kind: body.target_kind,
      target_pane: body.target_pane ?? null,
      workspace_id: body.workspace_id ?? null,
      cwd: body.cwd ? safeCwd(body.cwd) : null,
      model: body.model ?? null,
      backend: body.backend ?? null,
      // A scheduled job's report wants terse + result-first, so a NEW-TAB cron
      // defaults to ⚡ Do (agent-modes.ts). Pane mode inherits the pane's own
      // mode and ignores this column entirely.
      mode: body.target_kind === 'new-tab' ? (body.mode ?? 'do') : null,
      ...(body.catchup ? { catchup: body.catchup } : {}),
      ...(body.overlap ? { overlap: body.overlap } : {}),
      ...(body.on_context ? { on_context: body.on_context } : {}),
      ...(body.quiet_mins !== undefined ? { quiet_mins: body.quiet_mins } : {}),
      ...(body.max_open !== undefined ? { max_open: body.max_open } : {}),
      // Tabs pile up otherwise, and closing one loses nothing: every session is
      // archived + FTS-searchable, and the scheduler keeps the tab anyway when
      // the agent left a question or an artifact. So new-tab crons default ON.
      close_when_done: body.close_when_done ?? body.target_kind === 'new-tab',
      next_due_at: nextAfter(schedule, tz, now),
    });
    emitCronTabUpdate(deps, cron.target_pane);
    return c.json(cron, 201);
  });

  app.get('/:ref', (c) => {
    const s = store();
    const cron = s?.resolve(c.req.param('ref'));
    if (!cron) return c.json({ error: { code: 'not_found', message: 'cron not found' } }, 404);
    return c.json({ ...cron, runs: s?.runs(cron.id) ?? [] });
  });

  app.patch('/:ref', async (c) => {
    const s = store();
    const cron = s?.resolve(c.req.param('ref'));
    if (!s || !cron)
      return c.json({ error: { code: 'not_found', message: 'cron not found' } }, 404);
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().min(1).max(8000).optional(),
        schedule: z.string().min(1).optional(),
        tz: z.string().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad(parsed.error.issues[0]?.message ?? 'invalid body'), 400);
    const body = parsed.data;
    let schedule = cron.schedule;
    if (body.schedule !== undefined) {
      try {
        schedule = compileSchedule(body.schedule);
      } catch (e) {
        if (e instanceof ScheduleError) return c.json(bad(e.message), 400);
        throw e;
      }
    }
    const tz = body.tz ?? cron.tz;
    if (!isValidTimezone(tz)) return c.json(bad(`unknown timezone "${tz}"`), 400);
    if (body.prompt !== undefined || body.schedule !== undefined || body.tz !== undefined) {
      deps.db
        .prepare('UPDATE crons SET prompt = ?, schedule = ?, tz = ? WHERE id = ?')
        .run(body.prompt ?? cron.prompt, schedule, tz, cron.id);
      // A schedule/zone edit invalidates the persisted anchor; re-anchor from
      // NOW so the change takes effect at the next real slot rather than
      // firing immediately off a stale next_due_at.
      if (body.schedule !== undefined || body.tz !== undefined)
        s.setNextDue(cron.id, nextAfter(schedule, tz, Date.now()));
    }
    if (body.enabled !== undefined) {
      // RESUMING re-anchors: a cron paused for a week must not wake up to a
      // week of catch-up it was deliberately not meant to run.
      s.setEnabled(
        cron.id,
        body.enabled,
        body.enabled ? nextAfter(schedule, tz, Date.now()) : undefined,
      );
      emitCronTabUpdate(deps, cron.target_pane);
    }
    return c.json(s.getById(cron.id));
  });

  app.delete('/:ref', (c) => {
    const s = store();
    const cron = s?.resolve(c.req.param('ref'));
    if (!s || !cron)
      return c.json({ error: { code: 'not_found', message: 'cron not found' } }, 404);
    s.delete(cron.id);
    emitCronTabUpdate(deps, cron.target_pane);
    return c.body(null, 204);
  });

  // Fire now, ignoring the schedule. This is the affordance a session-scoped
  // harness cron structurally cannot offer: test it before you trust it.
  app.post('/:ref/run', async (c) => {
    const s = store();
    const cron = s?.resolve(c.req.param('ref'));
    if (!deps.scheduler || !cron)
      return c.json({ error: { code: 'not_found', message: 'cron not found' } }, 404);
    const result = await deps.scheduler.runNow(cron.id);
    return c.json({
      ok: result?.outcome !== 'rejected' && !result?.outcome.startsWith('error'),
      ...result,
    });
  });

  return app;
}
