// THE STALL REAPER'S PRODUCTION PATH, end to end.
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
// WHAT IT FOUND. Against the reaper as first written (9a9f191) the claimed
// property held only at the INSTANT of the sweep. For any runner that
// keepalives — every runner built since 2026-08-30 — the reap deleted the entry
// and with it the state `isMaterialProgress` needs, so the runner's next
// re-announce read as a first sighting and the row came straight back: a
// pre-`seenAt` ghost bought a whole fresh 20-minute lease on every
// resurrection, and a `seenAt`-bearing one (stale on arrival) was reaped again
// by every single sweep, flapping the count and spraying a bogus `done` a
// minute, forever. The tombstone (fe4d544) made the reap stick, and scoping the
// sweep to rows with no `seenAt` (ff9ac6f) kept it from durably HIDING a merely
// quiet live agent. This file is the harness that found all of it; it now pins
// the settled behaviour, which is:
//
//   pre-`seenAt` row, 20m without a content change  → retired, once, and it
//                                                     stays retired under the
//                                                     runner's own echoes
//   …then one materially different frame            → back, with a fresh window
//   `seenAt`-bearing row, however quiet             → never touched

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

    // 1. The ghost is gone and 2. the live row survived — it is doubly safe,
    //    both because its last real activity is ~7 minutes old and because a
    //    `seenAt`-bearing row is out of scope entirely (ff9ac6f, last case).
    expect(fx.count()).toBe(1);
    // 3. …and the one row left is the live one, not the other way round.
    expect(donesFor(fx, 'toolu_ghost')).toHaveLength(1);
    expect(donesFor(fx, 'toolu_live')).toHaveLength(0);
    expect(lastSessionRoster(fx)).toEqual(['toolu_live']);
    // 4. The pane still reads working, because work IS still running.
    expect(fx.status()).toBe('working');
  }, 60_000);

  it('a reaped row that resumes real progress comes back, with a fresh window', async () => {
    // THE INVERSE SAFETY PROPERTY, and the thing that makes reaping a row that
    // MIGHT be alive defensible: reaping unlists, it never kills, and one
    // materially different frame restores the row.
    //
    // It has to be a pre-`seenAt` row, since ff9ac6f scoped the sweep to those
    // (the last case in this file is why). So: a legacy runner whose subagent
    // spends 22 minutes inside one tool call, echoing the same payload, and
    // then comes back with its step count moved.
    const fx = await boot();
    const { runner } = fx;
    const slow: SubagentProgress = {
      toolUseId: 'toolu_slow',
      steps: 3,
      label: 'slow worker',
      lastTool: 'Bash: pnpm test',
    };
    const announce = (over: Partial<SubagentProgress> = {}) =>
      runner.emitRaw({ t: 'subagent', progress: { ...slow, ...over } });

    await runner.feed([sdk.init(), sdk.result('success')]);
    announce();
    await fx.flush();
    expect(fx.count()).toBe(1);

    // 22 minutes, re-announced along the way (once a minute here — the full 5s
    // cadence is exercised in the next describe, and the echo RATE is not what
    // the reaper reads).
    for (let m = 0; m < 22; m++) {
      announce();
      await fx.advance(MINUTE);
    }
    expect(donesFor(fx, 'toolu_slow')).toHaveLength(1);
    expect(fx.count()).toBe(0);

    // The tool call returns and the subagent speaks again.
    announce({ steps: 4, lastTool: 'Read: notes.md' });
    await fx.flush();
    expect(fx.count()).toBe(1);
    expect(fx.status()).toBe('working');
    const back = fx.chat
      .filter((f) => f.t === 'subagent')
      .map((f) => f.progress as SubagentProgress)
      .filter((p) => p.toolUseId === 'toolu_slow' && !p.done)
      .pop();
    expect(back?.steps).toBe(4);
    expect(back?.lastTool).toBe('Read: notes.md');

    // …and the restored row owns a FRESH window: fifteen more minutes of echoes
    // at the new payload, no second reap. (The frame lifted the tombstone and
    // re-stamped `changedAt` — a row that came back only to be retired again on
    // the next tick would be no better than the flapping this replaced.)
    for (let m = 0; m < 15; m++) {
      announce({ steps: 4, lastTool: 'Read: notes.md' });
      await fx.advance(MINUTE);
    }
    expect(donesFor(fx, 'toolu_slow')).toHaveLength(1);
    expect(fx.count()).toBe(1);
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────────────────
// DOES THE REAP STICK?
//
// The reaper as first written (9a9f191) could not make it stick, and these two
// cases are what found that. Reaping deleted the entry from `conn.subagents`
// AND its stamp from `conn.subagentChangedAt` — the same state
// `isMaterialProgress` reads to tell a keepalive echo from real news. With the
// row gone, its own keepalive re-announce became news by definition
// (`if (!prev) return true`), so ws.ts re-inserted it within one 5s tick, the
// next sweep reaped it again, and the count flapped between N and N+1 forever
// while every chat client took a bogus `done` a minute. Measured here, against
// that build: the pre-`seenAt` ghost bought an entire FRESH 20-minute lease on
// every resurrection, and the modern ghost (frozen `seenAt`, so stale on
// arrival) produced one reap per sweep indefinitely. The reaper worked only for
// runners old enough to have no keepalive at all — the population that ages out
// and the one case 1 above covers.
//
// The fix (fe4d544) is a TOMBSTONE: the payload a row died with, kept on the
// conn, with the insert path ignoring an echo of it and the tombstone lifting
// on real progress. The first case below pins that and fails against 9a9f191.
// The second pins ff9ac6f's scope decision, which the tombstone forced: a
// suppression that sticks is also a suppression that can HIDE a live agent, so
// the sweep no longer touches a row whose runner is new enough to say `seenAt`.
// ───────────────────────────────────────────────────────────────────────────
describe('subagent stall reaper — the reap survives the keepalive', () => {
  it('a pre-seenAt ghost stays retired under a keepalive that never stops', async () => {
    const fx = await boot();
    const { runner } = fx;
    const ghost: SubagentProgress = { toolUseId: 'toolu_ghost', steps: 7, label: 'ghost worker' };
    const announce = (over: Partial<SubagentProgress> = {}) =>
      runner.emitRaw({ t: 'subagent', progress: { ...ghost, ...over } });

    await runner.feed([sdk.init(), sdk.result('success')]);
    announce();
    await fx.flush();
    expect(fx.count()).toBe(1);

    // Case 1's ghost, except the runner keeps re-announcing it past the reap.
    for (let m = 0; m < 22; m++) {
      for (let k = 0; k < MINUTE / KEEPALIVE_MS; k++) {
        announce();
        await fx.advance(KEEPALIVE_MS);
      }
    }
    // Reaped ONCE — not once per sweep — and it is still gone with the echoes
    // still arriving.
    expect(donesFor(fx, 'toolu_ghost')).toHaveLength(1);
    expect(fx.count()).toBe(0);
    expect(fx.status()).not.toBe('working');

    // Nineteen more minutes of the same echo: still one reap, still zero. (This
    // is the assertion the pre-fix build inverted — there the re-insert stamped
    // a new `changedAt` and handed the ghost another full 20-minute lease.)
    for (let m = 0; m < 19; m++) {
      for (let k = 0; k < MINUTE / KEEPALIVE_MS; k++) {
        announce();
        await fx.advance(KEEPALIVE_MS);
      }
    }
    expect(donesFor(fx, 'toolu_ghost')).toHaveLength(1);
    expect(fx.count()).toBe(0);

    // …and the suppression is content-based, not an id blacklist: the same id
    // carrying REAL news (steps moved) is a live agent and gets its row back.
    announce({ steps: 8, lastTool: 'Bash: pnpm test' });
    await fx.flush();
    expect(fx.count()).toBe(1);
    expect(fx.status()).toBe('working');
  }, 180_000);

  it('a seenAt-bearing row is never reaped, however long it goes quiet', async () => {
    // No raw frames at all here: two REAL roster entries from the REAL backend,
    // one of which goes silent for forty minutes — a rate-limit hold, or one
    // enormous tool call (`muxpad agent wait --timeout=3600` is a thing this
    // codebase does). The runner knows that row is fine; the server cannot see
    // why, because `sweepSuspended` and the rest never survive `wireProgress`.
    //
    // Since ff9ac6f the presence of `seenAt` is read as a CAPABILITY probe — a
    // runner new enough to send it is new enough to end its own subagents on
    // four paths plus the level signal — so a quiet row from one is left alone.
    // Before that scoping, with the tombstone in place, this pane would have
    // shown a `done` for a live agent and then kept its row hidden until it
    // happened to speak again.
    const fx = await boot();
    const { runner } = fx;
    const LIVE = liveTask('task_live', 'live worker');
    const QUIET = liveTask('task_quiet', 'parked worker');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_live', 'task_live', 'live worker', [LIVE]),
      ...backgroundLaunch('toolu_quiet', 'task_quiet', 'parked worker', [LIVE, QUIET]),
      sdk.result('success'),
    ]);
    expect(fx.count()).toBe(2);

    // Forty minutes — twice the stall window. The live one works every 4
    // minutes; the parked one says nothing at all, and only the real 5s
    // keepalive keeps re-announcing it.
    for (let m = 0; m < 40; m++) {
      await fx.advance(MINUTE);
      if (m % 4 === 3) await runner.feed([sdk.childActivity('toolu_live')]);
    }
    expect(donesFor(fx, 'toolu_quiet')).toHaveLength(0);
    expect(donesFor(fx, 'toolu_live')).toHaveLength(0);
    expect(fx.count()).toBe(2);
    expect(lastSessionRoster(fx)).toEqual(['toolu_live', 'toolu_quiet']);
    expect(fx.status()).toBe('working');
  }, 180_000);
});
