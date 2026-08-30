// `muxpad cron` end-to-end against a REAL isolated instance: HTTP + WS + an
// in-process ptyd on its own unix socket, its own data dir, an ephemeral port,
// and a FAKE runner speaking the /ws/agent-runner protocol. Nothing here
// touches a live daemon or ~/.muxpad, and everything is torn down in afterAll.
//
// What only an e2e can prove: that a cron fire travels the SAME road a human
// message does — the real `submitSend`, the real durable queue, the real
// one-message-per-turn drain — and lands in the runner as a `send` frame.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { Cron, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAgentBridge } from '../agent-bridge.js';
import { CronScheduler } from '../cron/CronScheduler.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('muxpad cron e2e (isolated instance, fake runner)', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let db: Database.Database;
  let ptyd: SpawnedPtyd;
  let cache: PtydCache;
  let events: EventBus;
  let wsServer: ReturnType<typeof attachWsServer>;
  let scheduler: CronScheduler;
  let wsId: string;
  let now: number;
  const pushes: Array<{ title: string; body: string }> = [];
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-cron-e2e-'));
    // Sandbox every path the server derives from the environment, so this test
    // can never read or write the real instance's state.
    process.env.MUXPAD_DATA_DIR = tmp;
    db = openDb(join(tmp, 'db.sqlite'));
    events = new EventBus();
    const agentBridge = createAgentBridge();
    ptyd = await spawnPtyd();
    process.env.MUXPAD_PTYD_SOCKET = ptyd.socketPath;
    cache = new PtydCache();
    cache.attach(ptyd.client);
    now = Date.parse('2026-08-30T10:00:00Z');
    scheduler = new CronScheduler({
      db,
      ptyd: ptyd.client,
      cache,
      events,
      submitSend: (paneId, text) => agentBridge.submitSend(paneId, text),
      turnActive: (paneId) => agentBridge.turnActive(paneId),
      contextPct: (paneId) => agentBridge.contextPct(paneId),
      lastHumanSendAt: (paneId) => agentBridge.lastSendAt(paneId),
      blocked: (paneId) => agentBridge.blocked(paneId),
      notify: (title, body) => {
        pushes.push({ title, body });
      },
      now: () => now,
    });
    const app = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir: tmp,
      events,
      agentBridge,
      cronScheduler: scheduler,
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
    wsServer = attachWsServer({
      http: server as unknown as Server,
      db,
      ptyd: ptyd.client,
      cache,
      events,
      agentBridge,
    });
    // The scheduler subscribes to turn lifecycle here (close-when-done); the
    // TICK itself is driven by hand below, never by its interval.
    scheduler.start();
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  afterAll(async () => {
    scheduler.stop();
    for (const s of openSockets) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    await wsServer.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
    process.env.MUXPAD_DATA_DIR = undefined;
    process.env.MUXPAD_PTYD_SOCKET = undefined;
  });

  const base = () => `http://127.0.0.1:${port}`;
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  async function agentTab(body: Record<string, unknown> = {}) {
    const tab = await api<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', ...body }),
    });
    const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${tab.id}`);
    return { tab, paneId: detail.panes[0]?.id as string };
  }

  /** A fake runner: records every server→runner frame and can end a turn. */
  async function connectRunner(paneId: string, sid: string) {
    const sock = new WebSocket(`${base().replace('http', 'ws')}/ws/agent-runner/${paneId}`);
    const received: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => received.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      sock.once('open', () => res());
      sock.once('error', rej);
    });
    openSockets.push(sock);
    sock.send(JSON.stringify({ t: 'hello', sid, cwd: tmp, pid: 1, turnActive: false }));
    const deadline = Date.now() + 5_000;
    while (!received.some((f) => f.t === 'mode') && Date.now() < deadline) await settle(25);
    return {
      sock,
      received,
      sends: () => received.filter((f) => f.t === 'send') as Array<{ t: string; text: string }>,
      endTurn: () => sock.send(JSON.stringify({ t: 'turn-done', ok: true })),
    };
  }

  const makeCron = async (over: Record<string, unknown>) =>
    api<Cron>('/api/crons', {
      method: 'POST',
      body: JSON.stringify({
        tz: 'UTC',
        prompt: 'sweep the PRs',
        ...over,
      }),
    });

  /** Move the clock past the boot grace AND this cron's own jitter, then tick. */
  const tickAt = async (cron: Cron, extraMs = 0) => {
    now = Math.max(cron.next_due_at, now) + 1000 + extraMs;
    await scheduler.tick();
    await settle();
  };

  it('a due cron is DELIVERED to the live runner as a real send, and logged', async () => {
    const { paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-cron-1');
    const cron = await makeCron({
      name: 'delivered',
      schedule: 'every 5m',
      target_kind: 'pane',
      target_pane: paneId,
    });

    await tickAt(cron);

    // 1. It travelled the ordinary send road and reached the runner.
    expect(runner.sends()).toHaveLength(1);
    expect(runner.sends()[0]?.text).toContain('sweep the PRs');
    // 2. …marked, so the human and the agent both know it was scheduled.
    expect(runner.sends()[0]?.text).toContain(`<muxpad-cron id="${cron.id}" name="delivered"`);
    // 3. …and the run log records submitSend's own answer.
    const shown = await api<Cron & { runs: Array<{ outcome: string; target_pane: string }> }>(
      `/api/crons/${cron.id}`,
    );
    expect(shown.runs).toHaveLength(1);
    expect(shown.runs[0]?.outcome).toBe('sent');
    expect(shown.runs[0]?.target_pane).toBe(paneId);
    expect(shown.last_status).toBe('sent');
    runner.endTurn();
    await settle();
  });

  it('a fire lands BETWEEN turns — never mid-response', async () => {
    // This is inherited, not implemented: submitSend queues while a turn is in
    // flight and the queue drains one message per turn on turn-done. Proving it
    // here is what keeps a future "just send it directly" shortcut honest.
    const { paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-cron-between');
    // Put the pane mid-turn with a HUMAN send first.
    await api(`/api/agent-sessions/${paneId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'human message' }),
    });
    await settle();
    expect(runner.sends()).toHaveLength(1);

    const cron = await makeCron({
      name: 'between-turns',
      schedule: 'every 5m',
      target_kind: 'pane',
      target_pane: paneId,
    });
    await tickAt(cron);

    // Still one send: the fire is QUEUED, not injected into the running turn.
    expect(runner.sends()).toHaveLength(1);
    const queued = await api<Cron & { runs: Array<{ outcome: string }> }>(`/api/crons/${cron.id}`);
    expect(queued.runs[0]?.outcome).toBe('queued');

    // The turn ends → the queue drains → now it arrives.
    runner.endTurn();
    await settle();
    expect(runner.sends()).toHaveLength(2);
    expect(runner.sends()[1]?.text).toContain('sweep the PRs');
    runner.endTurn();
    await settle();
  });

  it('a DEAD pane fails fast: error, a fail streak, no spinning', async () => {
    const { paneId } = await agentTab();
    cache.setDead(paneId, true);
    const cron = await makeCron({
      name: 'dead-target',
      schedule: 'every 5m',
      target_kind: 'pane',
      target_pane: paneId,
    });
    await tickAt(cron);
    const shown = await api<Cron & { runs: Array<{ outcome: string; detail: string }> }>(
      `/api/crons/${cron.id}`,
    );
    expect(shown.runs[0]?.outcome).toBe('error');
    expect(shown.runs[0]?.detail).toBe('dead');
    expect(shown.fail_streak).toBe(1);
    expect(shown.enabled).toBe(true); // one failure is not three
    cache.setDead(paneId, false);
  });

  it('auto-disables and PUSHES after three consecutive failures', async () => {
    const { paneId } = await agentTab();
    cache.setDead(paneId, true);
    const cron = await makeCron({
      name: 'keeps-failing',
      schedule: 'every 5m',
      target_kind: 'pane',
      target_pane: paneId,
    });
    const before = pushes.length;
    for (let i = 0; i < 3; i++) {
      const fresh = await api<Cron>(`/api/crons/${cron.id}`);
      await tickAt(fresh);
    }
    const shown = await api<Cron>(`/api/crons/${cron.id}`);
    expect(shown.fail_streak).toBe(3);
    expect(shown.enabled).toBe(false);
    expect(pushes.slice(before)).toHaveLength(1);
    expect(pushes[pushes.length - 1]?.title).toContain('keeps-failing');
    cache.setDead(paneId, false);
  });

  it('catchup=once collapses a simulated downtime into ONE marked fire', async () => {
    const { paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-cron-catchup');
    const cron = await makeCron({
      name: 'catches-up',
      schedule: 'every 5m',
      target_kind: 'pane',
      target_pane: paneId,
      catchup: 'once',
    });
    // The laptop was asleep for two hours — 24 slots came and went.
    await tickAt(cron, 2 * 3_600_000);

    expect(runner.sends()).toHaveLength(1);
    const text = runner.sends()[0]?.text ?? '';
    expect(text).toMatch(/missed="\d\d"/);
    expect(text).toContain('missed while muxpad was offline');
    // …and it re-anchors forward rather than replaying the backlog next tick.
    const shown = await api<Cron>(`/api/crons/${cron.id}`);
    expect(shown.next_due_at).toBeGreaterThan(now);
    await scheduler.tick();
    await settle();
    expect(runner.sends()).toHaveLength(1);
    runner.endTurn();
    await settle();
  });

  it('new-tab mode creates a tab, drives it, and closes it when the run finishes', async () => {
    const cron = await makeCron({
      name: 'nightly',
      schedule: 'every 5m',
      target_kind: 'new-tab',
      workspace_id: wsId,
      cwd: tmp,
    });
    const tabsBefore = await api<Tab[]>(`/api/tabs?workspaceId=${wsId}`);
    await tickAt(cron);

    const tabsAfter = await api<Tab[]>(`/api/tabs?workspaceId=${wsId}`);
    expect(tabsAfter.length).toBe(tabsBefore.length + 1);
    const shown = await api<Cron & { runs: Array<{ target_tab: string; target_pane: string }> }>(
      `/api/crons/${cron.id}`,
    );
    const tabId = shown.runs[0]?.target_tab as string;
    const spawnedPane = shown.runs[0]?.target_pane as string;
    expect(tabId).toBeTruthy();

    // The runner comes up a beat later and drains the queued fire.
    const runner = await connectRunner(spawnedPane, 'sid-cron-newtab');
    await settle();
    expect(runner.sends()).toHaveLength(1);
    expect(runner.sends()[0]?.text).toContain('sweep the PRs');

    // Turn finishes cleanly with nothing pending → the tab closes. Nothing is
    // lost: the session is archived and FTS-searchable.
    runner.endTurn();
    await settle(500);
    const tabsFinal = await api<Tab[]>(`/api/tabs?workspaceId=${wsId}`);
    expect(tabsFinal.find((t) => t.id === tabId)).toBeUndefined();
  });

  it('the sidebar row carries the ⏱ data for a scheduled chat', async () => {
    const { tab, paneId } = await agentTab();
    const unscheduled = await agentTab();
    await makeCron({
      name: 'marks-the-tab',
      schedule: 'daily at 09:00',
      target_kind: 'pane',
      target_pane: paneId,
    });
    const rows = await api<Array<Tab & { crons?: number; next_cron?: { name: string } }>>(
      `/api/tabs?workspaceId=${wsId}`,
    );
    const row = rows.find((t) => t.id === tab.id);
    expect(row?.crons).toBe(1);
    expect(row?.next_cron?.name).toBe('marks-the-tab');
    // Per-TAB, not global: an identical agent tab with no schedule is unmarked,
    // so the ⏱ says something specific rather than decorating every row.
    // (And a schedule is not a STATUS by construction — `crons`/`next_cron`
    // are separate fields from `status`, which keeps its original meaning.)
    expect(rows.find((t) => t.id === unscheduled.tab.id)?.crons).toBeUndefined();
  });
});
