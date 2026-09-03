// THE STALL REAPER'S PRODUCTION PATH (9a9f191), end to end.
//
// subagent-stall.test.ts calls `reapStalledEntries` and `isMaterialProgress`
// directly. Nothing has ever run the layer they live inside: the 60s
// `setInterval(sweepStalledSubagents)`, the `done` broadcast it fans to chat
// clients, and `syncSubagentCount` — against a roster built by a REAL runner
// over a REAL socket. That is the whole claim of the commit ("fixes the count
// without requiring a respawn"), and a pure-function test cannot make it.
//
// So: an isolated instance (own data dir, own in-process ptyd on its own unix
// socket, 127.0.0.1, ephemeral port), the fake-runner harness (the real Claude
// backend and the real SubagentRoster behind scripted SDK messages), a real
// chat client socket to observe broadcasts, and the real ws.ts handler.
//
// THE CLOCK. The stall window is 20 minutes and the sweep is a 60s interval.
// Both are driven by vitest fake timers installed BEFORE `attachWsServer`, so
// the interval registered by production code is the faked one and the sweep
// that fires is the real `sweepStalledSubagents` — no seam, no injected
// threshold, no direct call to the pure function. `setTimeout` is deliberately
// left REAL so socket I/O and the harness's own awaits still work; only
// `Date`, `setInterval` and `clearInterval` are faked.
//
// WHAT IT FINDS. The claimed property holds at the instant of the sweep (case
// 1). It does NOT hold durably for any runner that keepalives, which is every
// runner built since 2026-08-30 (cases 3 and 4): the reap deletes the entry,
// which throws away the very state `isMaterialProgress` needs, so the next
// keepalive re-announce is indistinguishable from a first sighting and the row
// comes straight back. See the comments on those two cases.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubagentProgress } from '@muxpad/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Must precede the fakeRunner import: constructing the Claude backend calls
// query(), which would otherwise spawn a real Agent SDK session.
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));

import { EventBus } from '../events.js';
import { PtydCache, decoratePane } from '../ptyd-cache.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { resetFakeAgentSdk } from '../test-helpers/fakeAgentSdk.js';
import { type FakeRunner, startFakeRunner } from '../test-helpers/fakeRunner.js';
import { backgroundLaunch, liveTask, sdk } from '../test-helpers/sdkScript.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { SUBAGENT_STALL_MS, attachWsServer } from '../ws.js';

/** The runner's own keepalive cadence (SUBAGENT_KEEPALIVE_MS in claude.ts). */
const KEEPALIVE_MS = 5_000;
const MINUTE = 60_000;
const SID = '11111111-2222-3333-4444-555555555555';

// The backend reads its instruction files from the data dir at construction and
// the runner logs there. Never the real ~/.muxpad.
let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'muxpad-stall-reap-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
  return () => {
    rmSync(dataDir, { recursive: true, force: true });
    process.env.MUXPAD_DATA_DIR = undefined;
  };
});

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  // Real timers first: teardown (socket close, ptyd stop) needs a real clock.
  vi.useRealTimers();
  if (cleanup) await cleanup();
  cleanup = null;
  resetFakeAgentSdk();
});

interface Fixture {
  paneId: string;
  cache: PtydCache;
  runner: FakeRunner;
  /** Every frame the chat client received, in order. */
  chat: Array<Record<string, unknown>>;
  /** What `GET /api/panes` renders as `agents:` — the pane's reported count. */
  count(): number;
  /** What the sidebar renders for this pane. */
  status(): string;
  /** Let real socket I/O drain (setTimeout is not faked). */
  flush(): Promise<void>;
  /** Advance the FAKED clock, firing production intervals along the way. */
  advance(ms: number): Promise<void>;
}

/**
 * One isolated instance + one connected runner + one connected chat client.
 * Fake timers are installed between "listen" and "attachWsServer" so that the
 * stall sweep, the ws heartbeat and the runner's keepalive all hang off the
 * faked clock, while ptyd (spawned above) keeps its real one.
 */
async function boot(): Promise<Fixture> {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  process.env.MUXPAD_PTYD_SOCKET = ptyd.socketPath;
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  new AgentSessionStore(db);
  const events = new EventBus();
  const wsRow = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  const cache = new PtydCache();
  cache.on('paneChange', (id: string) => {
    const p = panes.getById(id);
    if (p) events.emit({ type: 'pane.updated', tab_id: p.tab_id, pane: decoratePane(cache, p) });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;

  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const wsServer = attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache,
    events,
    // The liveness heartbeat pings and terminates any client that hasn't
    // ponged since the previous round. Under a clock we advance in one jump no
    // pong can ever land in between, so at its 15s default it would kill every
    // socket in this file. Pushed past the horizon of any test here; nothing
    // under test depends on it.
    heartbeatMs: 24 * 3_600_000,
  });

  const runner = await startFakeRunner({ port, paneId: pane.id, sid: SID });

  // A real chat client: the only audience for `bcastToPane`, and therefore the
  // only place a reap's `done` frame can be observed.
  const chat: Array<Record<string, unknown>> = [];
  const chatSock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${pane.id}`);
  chatSock.on('message', (d) => chat.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => {
    chatSock.once('open', () => res());
    chatSock.once('error', rej);
  });

  cleanup = async () => {
    try {
      chatSock.close();
    } catch {
      // already gone
    }
    await runner.kill().catch(() => {});
    await wsServer.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
    process.env.MUXPAD_PTYD_SOCKET = undefined;
  };

  const flush = () => new Promise<void>((r) => setTimeout(r, 25));
  await flush();

  return {
    paneId: pane.id,
    cache,
    runner,
    chat,
    count: () => cache.getSubagentCount(pane.id),
    status: () => cache.getStatus(pane.id, false),
    flush,
    async advance(ms: number) {
      // Async advance: fake-timers yields to the real event loop between each
      // fired timer, so a keepalive frame emitted at t+5s is actually parsed by
      // the server before the sweep at t+60s runs.
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
  };
}

/** Terminal frames the chat client saw for a given row, in order. */
const donesFor = (fx: Fixture, toolUseId: string) =>
  fx.chat.filter(
    (f) =>
      f.t === 'subagent' &&
      (f.progress as SubagentProgress | undefined)?.toolUseId === toolUseId &&
      (f.progress as SubagentProgress | undefined)?.done === true,
  );

/** Ids the LAST `session` frame advertised — the membership a reconnecting or
 *  polling client would rebuild the roster from. */
function lastSessionRoster(fx: Fixture): string[] {
  const frames = fx.chat.filter((f) => f.t === 'session');
  const last = frames[frames.length - 1] as { subagents?: SubagentProgress[] } | undefined;
  return (last?.subagents ?? []).map((p) => p.toolUseId).sort();
}

describe('subagent stall reaper — the production sweep, end to end', () => {
  it('retires a stalled ghost, spares the live row, and tells the client', async () => {
    // THE CLAIMED PROPERTY, on the population the commit names: a pane whose
    // runner predates `seenAt` (2026-08-30, bce4cb4) and leaks a row no
    // end-path can reach. Such a runner also predates the 5s keepalive (added
    // in the same push, cfd6fc2), so its ghost is announced and then simply
    // never mentioned again — which is what makes the reap stick. Case 3 is the
    // same ghost under a runner that DOES keepalive.
    const fx = await boot();
    const { runner } = fx;
    const LIVE = liveTask('task_live', 'live worker');

    // A genuine background subagent, through the real dispatch and roster.
    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_live', 'task_live', 'live worker', [LIVE]),
      sdk.result('success'),
    ]);

    // …and a leaked row from a pre-durable runner: no `seenAt`, so the server's
    // own `changedAt` stamp is the only freshness it will ever have. The real
    // roster cannot emit this shape any more, so it rides the same socket raw.
    const ghost: SubagentProgress = {
      toolUseId: 'toolu_ghost',
      steps: 7,
      label: 'ghost worker',
      lastTool: 'Bash',
    };
    runner.emitRaw({ t: 'subagent', progress: ghost });
    await fx.flush();
    expect(fx.count()).toBe(2);
    expect(fx.status()).toBe('working');

    // 19 minutes pass. The ghost is re-announced VERBATIM on the runner's
    // keepalive cadence the whole way — byte-identical payload, exactly what
    // `announceAll` does — while the live row does real work every 4 minutes.
    for (let m = 0; m < 19; m++) {
      for (let k = 0; k < MINUTE / KEEPALIVE_MS; k++) {
        runner.emitRaw({ t: 'subagent', progress: { ...ghost } });
        await fx.advance(KEEPALIVE_MS);
      }
      if (m % 4 === 3) await runner.feed([sdk.childActivity('toolu_live')]);
    }
    // 228 re-announces have not restarted the ghost's stall clock (that is
    // `isMaterialProgress`, on the real path) and have not retired it either.
    expect(fx.count()).toBe(2);
    expect(donesFor(fx, 'toolu_ghost')).toHaveLength(0);

    // Past the window. The pre-keepalive runner says nothing further.
    await fx.advance(3 * MINUTE);

    // 1. The ghost is gone and 2. the live row survived — its last real
    //    activity is ~7 minutes old, well inside the window.
    expect(fx.count()).toBe(1);
    // 3. …and the one row left is the live one, not the other way round.
    expect(donesFor(fx, 'toolu_ghost')).toHaveLength(1);
    expect(donesFor(fx, 'toolu_live')).toHaveLength(0);
    expect(lastSessionRoster(fx)).toEqual(['toolu_live']);
    // 4. The pane still reads working, because work IS still running.
    expect(fx.status()).toBe('working');
  }, 60_000);

  it('a reaped row that resumes real progress comes straight back', async () => {
    // The inverse safety property the commit trades on: "reaping unlists, it
    // never kills; a live agent's next frame re-inserts its row". Here the
    // reaped row is a genuinely live subagent that was parked in one long tool
    // call — the false-reap case — and it must be able to return.
    const fx = await boot();
    const { runner } = fx;
    const SLOW = liveTask('task_slow', 'slow worker');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_slow', 'task_slow', 'slow worker', [SLOW]),
      sdk.result('success'),
    ]);
    expect(fx.count()).toBe(1);

    // It is inside a single 22-minute tool call: the roster's keepalive keeps
    // re-announcing it (unchanged, with its original seenAt), but nothing about
    // it changes, so the server reaps it.
    await fx.advance(SUBAGENT_STALL_MS + 2 * MINUTE);
    expect(donesFor(fx, 'toolu_slow').length).toBeGreaterThanOrEqual(1);

    // The tool call returns and the subagent speaks again. (The row is already
    // physically back by now — the keepalive alone re-inserts it, see the
    // second describe — so what real progress has to buy is not PRESENCE but a
    // restarted stall clock. That is what the rest of this case measures.)
    await runner.feed([sdk.childActivity('toolu_slow', 'Bash', 'sleep 5')]);
    // The roster throttles progress frames to one per 500ms and the keepalive
    // has just sent one on this same faked millisecond, so let the next tick
    // carry the update out.
    await fx.advance(KEEPALIVE_MS);
    expect(fx.count()).toBe(1);
    expect(fx.status()).toBe('working');
    const back = fx.chat
      .filter((f) => f.t === 'subagent')
      .map((f) => f.progress as SubagentProgress)
      .filter((p) => p.toolUseId === 'toolu_slow' && !p.done)
      .pop();
    expect(back?.steps).toBeGreaterThan(0);
    expect(back?.lastTool).toBe('Bash: sleep 5');

    // Fifteen more minutes of sweeps and keepalives with no further reap: the
    // ONE real frame restarted the window, and the row is back for good rather
    // than being retired again on the next tick (which is precisely what the
    // keepalive-only resurrection in the next describe does get).
    const reapsBefore = donesFor(fx, 'toolu_slow').length;
    await fx.advance(15 * MINUTE);
    expect(donesFor(fx, 'toolu_slow')).toHaveLength(reapsBefore);
    expect(fx.count()).toBe(1);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// WHAT THE REAPER DOES NOT DO.
//
// `reapStalledEntries` deletes the entry from `conn.subagents` AND its stamp
// from `conn.subagentChangedAt`. That is the same state `isMaterialProgress`
// reads to tell a keepalive re-announce from real news — so once a row is
// reaped, its own keepalive is news by definition (`if (!prev) return true`),
// and ws.ts re-inserts it with a fresh `changedAt`.
//
// Every runner built since 2026-08-30 (cfd6fc2) re-announces every live roster
// entry every 5 seconds, ghosts included — ws.ts's own comment says so. So for
// every ghost a running runner is still holding, the reap is undone within one
// keepalive tick. The two cases below measure it.
// ───────────────────────────────────────────────────────────────────────────
describe('subagent stall reaper — the keepalive undoes the reap', () => {
  it('a pre-seenAt ghost returns within 5s and buys a FULL fresh 20m lease', async () => {
    const fx = await boot();
    const { runner } = fx;
    const ghost: SubagentProgress = { toolUseId: 'toolu_ghost', steps: 7, label: 'ghost worker' };
    const announce = () => runner.emitRaw({ t: 'subagent', progress: { ...ghost } });

    await runner.feed([sdk.init(), sdk.result('success')]);
    announce();
    await fx.flush();
    expect(fx.count()).toBe(1);

    // Same as case 1, except the runner keeps keepaliving past the reap.
    for (let m = 0; m < 22; m++) {
      for (let k = 0; k < MINUTE / KEEPALIVE_MS; k++) {
        announce();
        await fx.advance(KEEPALIVE_MS);
      }
    }
    // The sweep DID fire and DID retire it…
    expect(donesFor(fx, 'toolu_ghost').length).toBeGreaterThanOrEqual(1);
    // …and it is back anyway. The pane reads working on a subagent that has not
    // moved in 22 minutes — the exact state the commit set out to end.
    expect(fx.count()).toBe(1);
    expect(fx.status()).toBe('working');

    // And it is not a flicker: the re-insert stamped a NEW changedAt, so the
    // ghost now owns another entire 20-minute window. Nineteen more minutes of
    // heartbeats, no further reap.
    const donesAfterFirstLease = donesFor(fx, 'toolu_ghost').length;
    for (let m = 0; m < 19; m++) {
      for (let k = 0; k < MINUTE / KEEPALIVE_MS; k++) {
        announce();
        await fx.advance(KEEPALIVE_MS);
      }
    }
    expect(donesFor(fx, 'toolu_ghost')).toHaveLength(donesAfterFirstLease);
    expect(fx.count()).toBe(1);
  }, 120_000);

  it('a modern ghost flickers once a minute forever instead of retiring', async () => {
    // No raw frames at all here: a REAL roster entry from the REAL backend that
    // simply never ends (a leaked end-path — the bug this all exists for),
    // re-announced by the REAL 5s keepalive with its original `seenAt`.
    //
    // Because that frozen `seenAt` outranks the server's fresh `changedAt`, the
    // resurrected row is stale on arrival: the next sweep reaps it, the next
    // keepalive brings it back, forever. One `done` frame and one `[ws] pane …
    // retired 1 subagent row(s)` warning per minute, for the life of the pane.
    const fx = await boot();
    const { runner } = fx;
    const LIVE = liveTask('task_live', 'live worker');
    const DEAD = liveTask('task_dead', 'leaked worker');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_live', 'task_live', 'live worker', [LIVE]),
      ...backgroundLaunch('toolu_dead', 'task_dead', 'leaked worker', [LIVE, DEAD]),
      sdk.result('success'),
    ]);
    expect(fx.count()).toBe(2);

    // 21 minutes: the live one works every 4 minutes, the leaked one never
    // again. Nothing but the real keepalive is driving the socket.
    for (let m = 0; m < 21; m++) {
      await fx.advance(MINUTE);
      if (m % 4 === 3) await runner.feed([sdk.childActivity('toolu_live')]);
    }
    const firstReap = donesFor(fx, 'toolu_dead').length;
    expect(firstReap).toBeGreaterThanOrEqual(1);

    // Five more minutes. A retirement that stuck would produce nothing further.
    await fx.advance(5 * MINUTE);
    const laterReaps = donesFor(fx, 'toolu_dead').length - firstReap;
    // Instead: roughly one reap per sweep, because the row keeps coming back.
    expect(laterReaps).toBeGreaterThanOrEqual(3);
    // The live row is never touched.
    expect(donesFor(fx, 'toolu_live')).toHaveLength(0);
    // And the count is back at the wrong number, which is where a human looking
    // at the sidebar finds it: 2 rows, 1 real.
    expect(fx.count()).toBe(2);
    expect(lastSessionRoster(fx)).toEqual(['toolu_dead', 'toolu_live']);
  }, 120_000);
});
