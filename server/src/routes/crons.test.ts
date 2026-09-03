import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cron } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronScheduler } from '../cron/CronScheduler.js';
import { EventBus } from '../events.js';
import type { PtydCache } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { createApp } from '../server.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * Route-level contract for /api/crons. The thing worth pinning here is
 * VALIDATION: a schedule that fails at 3am instead of at creation is exactly
 * the failure mode this feature exists to remove, and two of these fields
 * (model, cwd) end up in a shell command.
 */
describe('/api/crons', () => {
  let db: Database.Database;
  let tmp: string;
  let test: TestApp;
  let wsId: string;
  let paneId: string;
  let scheduler: CronScheduler;

  const json = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: T }> => {
    const res = await test.app.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status === 204) return { status: res.status, body: undefined as T };
    return { status: res.status, body: (await res.json()) as T };
  };

  const create = (over: Record<string, unknown> = {}) =>
    json<Cron>('/api/crons', {
      method: 'POST',
      body: JSON.stringify({
        name: 'pr-sweep',
        schedule: 'weekdays at 09:00',
        prompt: 'check my PRs',
        target_kind: 'pane',
        target_pane: paneId,
        tz: 'America/Los_Angeles',
        ...over,
      }),
    });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-crons-'));
    db = openDb(':memory:');
    const events = new EventBus();
    test = await createTestApp({ db, dataDir: tmp, events });
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
    // An agent tab so we have a runner-owned pane to target.
    const tab = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent' }),
      })
    ).json()) as { id: string };
    const detail = (await (await test.app.request(`/api/tabs/${tab.id}`)).json()) as {
      panes: Array<{ id: string }>;
    };
    paneId = detail.panes[0]?.id as string;
    // Re-create the app WITH a scheduler (the store lives on it).
    scheduler = new CronScheduler({
      db,
      ptyd: test.ptyd.client as unknown as PtydClient,
      cache: test.cache,
      events,
      submitSend: () => ({ status: 'queued' as const }),
    });
    const cache = test.cache as PtydCache;
    test.app = createApp({
      db,
      ptyd: test.ptyd.client,
      cache,
      dataDir: tmp,
      events,
      cronScheduler: scheduler,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a cron, compiling the friendly schedule and defaulting the policies', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.schedule).toBe('0 9 * * 1-5'); // compiled, not stored as prose
    expect(body.tz).toBe('America/Los_Angeles');
    expect(body.enabled).toBe(true);
    expect(body.catchup).toBe('once');
    expect(body.overlap).toBe('skip');
    expect(body.next_due_at).toBeGreaterThan(Date.now());
    // Pane mode inherits the pane's own agent mode; the column is meaningless.
    expect(body.mode).toBeNull();
    // close_when_done is a NEW-TAB affordance; a pane cron never closes anything.
    expect(body.close_when_done).toBe(false);
  });

  it('defaults a NEW-TAB cron to ⚡ Do and close-when-done', async () => {
    // A scheduled job's report wants terse + result-first; and every session is
    // archived + FTS-searchable, so closing a finished cron tab loses nothing.
    const { body } = await create({
      target_kind: 'new-tab',
      target_pane: undefined,
      workspace_id: wsId,
    });
    expect(body.mode).toBe('do');
    expect(body.close_when_done).toBe(true);
    expect(body.max_open).toBe(1);
  });

  it('rejects an unreadable schedule AT CREATION, with a usable message', async () => {
    const { status, body } = await create({ schedule: 'sometimes on tuesdays' });
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toContain(
      'could not read the schedule',
    );
  });

  it('rejects an unknown timezone', async () => {
    const { status, body } = await create({ tz: 'Mars/Olympus' });
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toContain(
      'unknown timezone',
    );
  });

  it('rejects a pane that has no agent runner (it could never drain a fire)', async () => {
    const plain = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: wsId, bootstrap: 'shell' }),
      })
    ).json()) as { id: string };
    const detail = (await (await test.app.request(`/api/tabs/${plain.id}`)).json()) as {
      panes: Array<{ id: string }>;
    };
    const { status, body } = await create({ target_pane: detail.panes[0]?.id });
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toContain(
      'no agent runner',
    );
  });

  it('rejects a missing target', async () => {
    expect((await create({ target_pane: undefined })).status).toBe(400);
    expect(
      (await create({ target_kind: 'new-tab', target_pane: undefined, workspace_id: undefined }))
        .status,
    ).toBe(400);
    expect((await create({ target_pane: 'no-such-pane' })).status).toBe(400);
  });

  it('gates the model against the shell charset (it is baked into startup_cmd)', async () => {
    const ok = await create({
      name: 'ok',
      target_kind: 'new-tab',
      target_pane: undefined,
      workspace_id: wsId,
      model: 'claude-opus-4-8[1m]',
    });
    expect(ok.status).toBe(201);
    const bad = await create({
      name: 'bad',
      target_kind: 'new-tab',
      target_pane: undefined,
      workspace_id: wsId,
      model: "x'; rm -rf /; '",
    });
    expect(bad.status).toBe(400);
  });

  it('rejects a name that is not a plain CLI handle', async () => {
    expect((await create({ name: 'has spaces' })).status).toBe(400);
    expect((await create({ name: '' })).status).toBe(400);
  });

  it('lists, resolves by NAME as well as id, and includes run history on show', async () => {
    const { body: cron } = await create();
    const list = await json<Cron[]>('/api/crons');
    expect(list.body.map((c) => c.id)).toEqual([cron.id]);

    const byName = await json<Cron & { runs: unknown[] }>('/api/crons/pr-sweep');
    expect(byName.body.id).toBe(cron.id);
    expect(byName.body.runs).toEqual([]);
    const byId = await json<Cron>(`/api/crons/${cron.id}`);
    expect(byId.body.id).toBe(cron.id);
    expect((await json('/api/crons/nope')).status).toBe(404);
  });

  it('pause keeps the schedule; resume RE-ANCHORS so a long pause does not replay', async () => {
    const { body: cron } = await create({ schedule: 'every 5m' });
    const paused = await json<Cron>(`/api/crons/${cron.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.body.enabled).toBe(false);

    // Backdate the anchor to simulate a week of pause.
    db.prepare('UPDATE crons SET next_due_at = ? WHERE id = ?').run(
      Date.now() - 7 * 86_400_000,
      cron.id,
    );
    const resumed = await json<Cron>(`/api/crons/${cron.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    expect(resumed.body.enabled).toBe(true);
    expect(resumed.body.next_due_at).toBeGreaterThan(Date.now());
  });

  it('editing the schedule recompiles, re-anchors, and re-jitters', async () => {
    const { body: cron } = await create({ schedule: 'daily at 09:00' });
    const patched = await json<Cron>(`/api/crons/${cron.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ schedule: 'every 2m', prompt: 'new prompt' }),
    });
    expect(patched.body.schedule).toBe('*/2 * * * *');
    expect(patched.body.prompt).toBe('new prompt');
    expect(patched.body.next_due_at).toBeGreaterThan(Date.now());
    // A cron moved from daily to every-2-minutes must not keep a 27-minute
    // offset — the jitter cap follows the interval.
    expect(patched.body.jitter_ms).toBeLessThanOrEqual(60_000);
  });

  it('rejects a bad schedule on PATCH too, without touching the stored one', async () => {
    const { body: cron } = await create();
    const bad = await json(`/api/crons/${cron.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ schedule: 'whenever' }),
    });
    expect(bad.status).toBe(400);
    expect((await json<Cron>(`/api/crons/${cron.id}`)).body.schedule).toBe('0 9 * * 1-5');
  });

  it('run fires immediately and reports the queue answer', async () => {
    const { body: cron } = await create();
    const before = (await json<Cron>(`/api/crons/${cron.id}`)).body.next_due_at;
    const res = await json<{ ok: boolean; outcome: string }>(`/api/crons/${cron.id}/run`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.body.outcome).toBe('queued');
    expect(res.body.ok).toBe(true);
    const after = await json<Cron & { runs: Array<{ outcome: string }> }>(`/api/crons/${cron.id}`);
    expect(after.body.runs[0]?.outcome).toBe('queued');
    // A manual run tests the cron; it must not move the schedule.
    expect(after.body.next_due_at).toBe(before);
  });

  it('delete removes the cron and its run history', async () => {
    const { body: cron } = await create();
    await json(`/api/crons/${cron.id}/run`, { method: 'POST', body: '{}' });
    expect((await json(`/api/crons/${cron.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(`/api/crons/${cron.id}`)).status).toBe(404);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM cron_runs WHERE cron_id = ?').get(cron.id) as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('folds the schedule into the TAB row, so the sidebar needs no extra request', async () => {
    const before = (
      await json<Array<{ id: string; crons?: number }>>(`/api/tabs?workspaceId=${wsId}`)
    ).body;
    expect(before.every((t) => !t.crons)).toBe(true);

    const { body: cron } = await create();
    const after = (
      await json<Array<{ id: string; crons?: number; next_cron?: { name: string } }>>(
        `/api/tabs?workspaceId=${wsId}`,
      )
    ).body;
    const row = after.find((t) => t.crons);
    expect(row?.crons).toBe(1);
    expect(row?.next_cron?.name).toBe('pr-sweep');

    // A PAUSED cron is not a live schedule — the mark must go.
    await json(`/api/crons/${cron.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    const paused = (await json<Array<{ crons?: number }>>(`/api/tabs?workspaceId=${wsId}`)).body;
    expect(paused.every((t) => !t.crons)).toBe(true);
  });

  it('the tab list costs ONE cron query however many tabs there are', async () => {
    // The sidebar polls this route every 5s; a per-row lookup would make it the
    // hottest query in the app. Count statements rather than trusting the shape.
    for (let i = 0; i < 6; i++) {
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: wsId, bootstrap: 'shell' }),
      });
    }
    await create();
    let cronQueries = 0;
    const original = db.prepare.bind(db);
    const spy = db as unknown as { prepare: (sql: string) => unknown };
    spy.prepare = (sql: string) => {
      if (/FROM crons/i.test(sql)) cronQueries += 1;
      return original(sql);
    };
    try {
      await json(`/api/tabs?workspaceId=${wsId}`);
    } finally {
      spy.prepare = original as unknown as (sql: string) => unknown;
    }
    expect(cronQueries).toBe(1);
  });
});
