// A WORKER'S WHOLE LIFE, against a REAL isolated instance: HTTP + WS + an
// in-process ptyd on its own unix socket, its own data dir, an ephemeral port,
// and a FAKE runner speaking the /ws/agent-runner protocol. Nothing here touches
// a live daemon or ~/.muxpad.
//
// Every other test of this feature drives one seam. This one wires the lifecycle
// THE WAY index.ts WIRES IT — ws.ts's dead-runner sweep, ChatRetirer on the bus,
// SpawnReportWriter hung off `onFinished` — and then asks the questions a person
// asks while watching the sidebar:
//
//   Does the row stay while the worker is working?
//   Does its round stay open across its turn boundaries?
//   When it finishes, does a CARD appear, with the work in it?
//   Handed a second job, does that get its own card?
//   When its runner is killed, does the row leave, saying it DIED?
//
// The answers are read back through the same HTTP the web app reads — including
// `GET /api/tabs/:id/spawn-rounds`, which is the card's actual data source — so a
// pass here means the bytes the UI renders are right, not just the rows.
//
// Every bug this file was written for was a WIRING bug: a verdict that existed
// and nothing consumed, or a turn boundary mistaken for the end of a job.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { SpawnRound, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { type AgentBridge, createAgentBridge } from '../agent-bridge.js';
import { SpawnReportWriter } from '../chat/SpawnReportWriter.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { RESPAWN_COOLDOWN_MS, RESPAWN_MAX_ATTEMPTS } from '../respawn-policy.js';
import { createApp } from '../server.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { ChatRetirer } from '../tab-retire.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

/**
 * The settle this instance runs with.
 *
 * Real timer, real frames, real sweep — only the WINDOW is shortened. The
 * production 90 s is sized for the gap between two turns of one job
 * (JOB_SETTLE_MS); a test needs the same mechanism at a length a suite can wait
 * out. Everything asserted below is about ordering, not duration.
 */
const SETTLE_MS = 2_000;

/**
 * Per-test ceiling. These drive a real ptyd, a real HTTP server and a real
 * settle timer, so they are seconds not milliseconds — and the default 10 s is
 * not enough on a machine running anything else.
 */
const E2E_TIMEOUT_MS = 60_000;

/** What the stub generator returns, standing in for the model. */
const REPORT_ONE = 'Counted the TODO comments: 41 across 6 files, listed in /tmp/todos.md.';
const REPORT_TWO = 'Then renamed the stale ones and pushed the branch.';

describe('a worker’s life, end to end (isolated instance, fake runner)', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let db: Database.Database;
  let ptyd: SpawnedPtyd;
  let cache: PtydCache;
  let events: EventBus;
  let bridge: AgentBridge;
  let wsServer: ReturnType<typeof attachWsServer>;
  let retirer: ChatRetirer;
  let writer: SpawnReportWriter;
  let wsId: string;
  let reportsAsked = 0;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-worker-life-'));
    process.env.MUXPAD_DATA_DIR = tmp;
    mkdirSync(join(tmp, 'agent-transcripts'), { recursive: true });
    db = openDb(join(tmp, 'db.sqlite'));
    events = new EventBus();
    bridge = createAgentBridge();
    ptyd = await spawnPtyd();
    process.env.MUXPAD_PTYD_SOCKET = ptyd.socketPath;
    cache = new PtydCache();
    cache.attach(ptyd.client);

    // ── The lifecycle, wired as index.ts wires it ───────────────────────────
    writer = new SpawnReportWriter({
      db,
      events,
      cache,
      dataDir: tmp,
      // A stub where the model goes. The generator is not what this file tests;
      // WHETHER IT IS REACHED, and for which round, is.
      model: async () => (reportsAsked++ === 0 ? REPORT_ONE : REPORT_TWO),
    });
    retirer = new ChatRetirer(
      {
        db,
        cache,
        events,
        onFinished: writer.onFinished,
        // The real probe, as index.ts wires it: a worker with no runner has not
        // delivered, whatever its last turn-end looked like.
        turnActive: (paneId: string) => bridge.turnActive(paneId),
      },
      SETTLE_MS,
    );
    retirer.start();

    const app = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir: tmp,
      events,
      agentBridge: bridge,
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
      agentBridge: bridge,
      onRunnerDead: (paneId) => retirer.onRunnerDead(paneId),
    });
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    retirer.stop();
    writer.stop();
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

  // The stub generator's cursor is per-TEST: these run in one file against one
  // writer, and a counter shared across them makes the second test's assertions
  // depend on how many reports the first one asked for.
  beforeEach(() => {
    reportsAsked = 0;
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

  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  /** Longer than the settle, so a retirement has had every chance to happen. */
  const pastTheSettle = () => settle(SETTLE_MS * 4);

  /** A parent conversation, and a worker spawned under it — the real routes. */
  async function spawnWorker(name: string): Promise<{
    parentId: string;
    tabId: string;
    paneId: string;
  }> {
    const parent = await api<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', name: `muxpad-${name}` }),
    });
    const child = await api<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', name, spawned_by: parent.id }),
    });
    const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${child.id}`);
    const paneId = detail.panes[0]?.id as string;
    // ── NO REAL AGENT MAY BE LAUNCHED BY A TEST ──────────────────────────────
    // `bootstrap: 'agent'` gives the pane a startup_cmd of `muxpad agent …`, and
    // on a developer's machine `muxpad` IS on PATH — so ensurePane types it into
    // a real shell and a REAL agent-runner starts. Two problems, one fix: it
    // spawns actual agent processes from a test run, and the dead-runner sweep
    // then sees `agent-runner` in the pane's foreground and rightly refuses to
    // call it dead, so the death scenario could never reach a give-up.
    //
    // `/bin/cat` as the shell is this repo's existing answer (ws-respawn,
    // serve-respawn): the startup command is ECHOED and never executed, while
    // the row keeps the `muxpad agent%` marker the sweep selects on. The pty is
    // killed first so anything already launched goes with it.
    db.prepare('UPDATE panes SET shell = ? WHERE id = ?').run('/bin/cat', paneId);
    await ptyd.client.killPane(paneId).catch(() => {
      // never had a pty — ensurePane will make one with `cat` when needed
    });
    // A transcript on disk, because the report is READ OFF IT rather than asked
    // of the worker — the whole reason a summary survives a crash.
    const sid = `sid-${paneId}`;
    // `codex`, not `claude`: the reader picks its NORMALIZER off the assistant,
    // and muxpad's own JSONL shape is the identity one. A `claude` session would
    // find this file and then read nothing out of it.
    new AgentSessionStore(db).register({ pane_id: paneId, assistant: 'codex', session_id: sid });
    writeFileSync(
      join(tmp, 'agent-transcripts', `${sid}.jsonl`),
      `${[
        { id: '1', ts: 1, kind: 'user', text: 'count every TODO comment in the repo' },
        { id: '2', ts: 2, kind: 'assistant', text: 'found 41 in 6 files; wrote /tmp/todos.md' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n')}\n`,
    );
    return { parentId: parent.id, tabId: child.id, paneId };
  }

  /** A fake runner on the real protocol. */
  async function connectRunner(paneId: string) {
    const sock = new WebSocket(`${base().replace('http', 'ws')}/ws/agent-runner/${paneId}`);
    openSockets.push(sock);
    await new Promise<void>((resolve, reject) => {
      sock.once('open', () => resolve());
      sock.once('error', reject);
    });
    sock.send(
      JSON.stringify({
        t: 'hello',
        sid: `sid-${paneId}`,
        backend: 'codex',
        cwd: tmp,
        pid: 4242,
        turnActive: false,
      }),
    );
    await settle(80);
    return {
      sock,
      start: () => sock.send(JSON.stringify({ t: 'turn-start' })),
      done: () => sock.send(JSON.stringify({ t: 'turn-done', ok: true })),
    };
  }

  /**
   * Hand the worker a job the way a person does — through the real `submitSend`,
   * which is the ONE funnel that revives the chat and opens its round.
   */
  const giveJob = (paneId: string, text: string) => bridge.submitSend(paneId, text);

  /** The tab as the SIDEBAR sees it. */
  const lifecycle = async (tabId: string) => {
    const t = await api<Tab>(`/api/tabs/${tabId}`);
    return { done: t.done === true, reason: t.done_reason, state: t.spawn_report_state };
  };

  /** The rounds as THE CARD sees them — the UI's actual data source. */
  const cards = async (parentId: string, tabId: string): Promise<SpawnRound[]> => {
    const res = await api<{ rounds: Record<string, SpawnRound[]> }>(
      `/api/tabs/${parentId}/spawn-rounds`,
    );
    return res.rounds[tabId] ?? [];
  };

  async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 6_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await settle(40);
    }
  }

  it(
    'STAYS IN THE SIDEBAR while it works, then delivers ONE card',
    async () => {
      const w = await spawnWorker('multi-turn');
      const runner = await connectRunner(w.paneId);

      giveJob(w.paneId, 'count the TODOs');
      await settle();
      expect((await cards(w.parentId, w.tabId)).filter((r) => r.ended_at === null)).toHaveLength(1);

      // FOUR TURNS OF ONE JOB. Each boundary is what used to archive it mid-work.
      for (let i = 0; i < 4; i++) {
        runner.start();
        await settle(40);
        runner.done();
        await settle(120);
        expect((await lifecycle(w.tabId)).done, `turn ${i} must not retire it`).toBe(false);
        expect(
          (await cards(w.parentId, w.tabId)).filter((r) => r.ended_at === null),
          `turn ${i} must not close the round`,
        ).toHaveLength(1);
      }

      // Now it really stops.
      runner.start();
      await settle(40);
      runner.done();
      await waitUntil(async () => (await lifecycle(w.tabId)).done);

      const l = await lifecycle(w.tabId);
      expect(l.done).toBe(true);
      expect(l.reason).toBe('delivered');

      // THE CARD: one round, closed, carrying the summary the parent's log draws.
      await waitUntil(async () => (await cards(w.parentId, w.tabId))[0]?.report !== null);
      const rounds = await cards(w.parentId, w.tabId);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.ended_at).not.toBeNull();
      expect(rounds[0]?.report).toBe(REPORT_ONE);
      expect(rounds[0]?.report_state).toBe('ok');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'COMES BACK BY ITSELF if it turns out not to have finished',
    async () => {
      const w = await spawnWorker('resumes');
      const runner = await connectRunner(w.paneId);
      giveJob(w.paneId, 'go');
      await settle(80);
      runner.start();
      await settle(40);
      runner.done();
      await waitUntil(async () => (await lifecycle(w.tabId)).done);
      expect((await lifecycle(w.tabId)).done).toBe(true);

      // It speaks again — a background task came back, a wakeup fired.
      runner.start();
      await waitUntil(async () => !(await lifecycle(w.tabId)).done);

      expect((await lifecycle(w.tabId)).done).toBe(false);
      // The round it had closed is RUNNING AGAIN rather than a second one being
      // opened: the user asked for this once.
      const rounds = await cards(w.parentId, w.tabId);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.ended_at).toBeNull();
      // …and the premature summary is gone, to be replaced at the real end.
      expect(rounds[0]?.report).toBeNull();
      // Still live a full window later: a turn in flight is not a settle.
      await pastTheSettle();
      expect((await lifecycle(w.tabId)).done).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'gives a SECOND JOB its own card, handed over inside the interval',
    async () => {
      const w = await spawnWorker('two-jobs');
      const runner = await connectRunner(w.paneId);

      for (const text of ['job one', 'job two']) {
        giveJob(w.paneId, text);
        await settle(80);
        runner.start();
        await settle(40);
        runner.done();
        await waitUntil(async () => (await lifecycle(w.tabId)).done);
        await waitUntil(async () => {
          const rs = await cards(w.parentId, w.tabId);
          return rs.length > 0 && rs[rs.length - 1]?.report !== null;
        });
      }

      // TWO rounds, TWO cards, each with its own summary — seconds apart, well
      // inside the 30-minute per-tab report interval that used to swallow the
      // second one.
      const rounds = await cards(w.parentId, w.tabId);
      expect(rounds).toHaveLength(2);
      expect(rounds.map((r) => r.report)).toEqual([REPORT_ONE, REPORT_TWO]);
      expect(rounds.every((r) => r.ended_at !== null)).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'ARCHIVES A KILLED WORKER as died, with a closed round and an honest card',
    async () => {
      const w = await spawnWorker('killed');
      const runner = await connectRunner(w.paneId);
      giveJob(w.paneId, 'do the thing');
      await settle(80);
      runner.start();
      await settle(60);

      // The ptyd/node-pty bug, reproduced: the runner is gone and will never end a
      // turn. Nothing in the tab lifecycle can hear about it except the sweep.
      runner.sock.close();
      await settle(200);
      // Past the startup grace, so the sweep is willing to judge the pane.
      db.prepare('UPDATE panes SET created_at = 1 WHERE id = ?').run(w.paneId);
      // THIS WORKER, ALONE. The sweep judges every agent pane in the instance,
      // and the earlier scenarios left theirs behind — runner-less, so each pass
      // spends a real killPane + ensurePane on all of them against a real ptyd.
      // That is minutes of work for a verdict about one pane, and it is the
      // difference between this scenario being deterministic and it timing out.
      // Their assertions are finished; only this pane's death is under test.
      db.prepare('DELETE FROM panes WHERE id != ?').run(w.paneId);

      // Drive the sweep to its GIVE-UP. Date only is faked — the ptyd sockets and
      // every await stay real — because the three 45-second cooldowns are
      // otherwise unreachable in a suite (see ws-respawn.test.ts).
      const t0 = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      // UNTIL IT GIVES UP, not for a fixed count. An attempt is only spent when
      // the ptyd probe ANSWERS, and this instance is respawning every other
      // pane the earlier tests left behind — so a pass can legitimately skip
      // this pane and a fixed `RESPAWN_MAX_ATTEMPTS + 1` loop comes up one
      // attempt short. Bounded well above the cap so a genuine failure to die
      // still ends the test rather than hanging it.
      for (let pass = 1; pass <= RESPAWN_MAX_ATTEMPTS * 3 && !cache.isDead(w.paneId); pass++) {
        vi.setSystemTime(t0 + pass * (RESPAWN_COOLDOWN_MS + 1_000));
        await wsServer.sweepDeadRunners();
        // Room for ptyd to finish the kill/spawn this pass asked for, so the
        // next probe reads the pane as it now is rather than mid-respawn.
        await settle(30);
      }
      vi.useRealTimers();
      // The supervisor's verdict, which is what the retirement hangs off.
      expect(cache.isDead(w.paneId)).toBe(true);
      await waitUntil(async () => (await lifecycle(w.tabId)).done);

      const l = await lifecycle(w.tabId);
      expect(l.done).toBe(true);
      // NOT `delivered`. The work is incomplete and the row says so.
      expect(l.reason).toBe('died');
      // The card is a crash, not a green tick.
      await waitUntil(async () => (await lifecycle(w.tabId)).state === 'crashed');
      expect((await lifecycle(w.tabId)).state).toBe('crashed');
      // And its round is not left spinning in the parent's log.
      expect((await cards(w.parentId, w.tabId)).filter((r) => r.ended_at === null)).toHaveLength(0);
    },
    E2E_TIMEOUT_MS,
  );
});
