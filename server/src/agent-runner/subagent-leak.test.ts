// THE REPRODUCTION.
//
// The pane's `agents: N` badge has now been "fixed" twice and is still wrong in
// the field (live: pane says 8, ground truth 1, with 7–8 rows carrying real step
// counts). Both fixes were reasoned from reading code and pinned by tests that
// stopped at a seam:
//
//   subagent-roster.test.ts   calls the roster's methods directly
//   claude.test.ts            calls applyTaskLifecycle directly
//   relay.test.ts             sends hand-written `subagent` wire frames
//
// Nothing has ever run the layer BETWEEN those: claude.ts's `for await (const
// msg of session)` dispatch, which decides which roster method a given SDK
// message shape reaches. That layer is where the count is actually computed,
// and a test that hand-writes the roster calls cannot disagree with it.
//
// This file closes that gap. Scripted SDK messages — shapes and ORDERS
// transcribed from a live 0.3.220 probe (scripts/sdk-task-probe.mjs) — go into
// the real backend, whose real roster emits real frames down a real socket into
// the real ws.ts handler and the real PtydCache. The assertion at the end of
// every scenario is the property no existing test pins:
//
//     when everything has finished, the count is EXACTLY ZERO.
//
// The fleet sequence (the last test) is the one the user's panes actually
// produce: many turns, subagents outliving their launching turn, some finishing
// mid-turn, some after it, one killed, one Stop with launches outstanding, a
// reconnect mid-flight, and a nested launch.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { backgroundFinish, backgroundLaunch, liveTask, sdk } from '../test-helpers/sdkScript.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

// Never touch the real ~/.muxpad: the backend reads agent-instructions.md and
// do-mode.md from the data dir at construction, and the runner writes a log
// there. Point both at a throwaway directory for the whole file.
let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'muxpad-leak-test-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
  return () => rmSync(dataDir, { recursive: true, force: true });
});

const SID = '11111111-2222-3333-4444-555555555555';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
  resetFakeAgentSdk();
});

interface Fixture {
  port: number;
  paneId: string;
  cache: PtydCache;
  ptyd: SpawnedPtyd;
}

async function boot(): Promise<Fixture> {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
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
  attachWsServer({ http, db, ptyd: ptyd.client, cache, events });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { port, paneId: pane.id, cache, ptyd };
}

/** Boot server + runner together; the runner's hello has already landed. */
async function bootPair(): Promise<Fixture & { runner: FakeRunner }> {
  const fx = await boot();
  const runner = await startFakeRunner({ port: fx.port, paneId: fx.paneId, sid: SID });
  const prev = cleanup;
  cleanup = async () => {
    await runner.kill().catch(() => {});
    if (prev) await prev();
  };
  return { ...fx, runner };
}

/** The two numbers that must always agree: what the RUNNER believes and what
 *  the SERVER renders. A divergence between them localizes the bug instantly. */
function counts(fx: Fixture, runner: FakeRunner): { runner: number; server: number } {
  const live = new Set<string>();
  for (const f of runner.sent) {
    if (f.t !== 'subagent') continue;
    if (f.progress.done) live.delete(f.progress.toolUseId);
    else live.add(f.progress.toolUseId);
  }
  return { runner: live.size, server: fx.cache.getSubagentCount(fx.paneId) };
}

/** Assert both layers agree with the ground truth. */
function expectCount(fx: Fixture, runner: FakeRunner, truth: number, where: string): void {
  const c = counts(fx, runner);
  expect({ where, ...c }, `${where}: runner=${c.runner} server=${c.server} truth=${truth}`).toEqual(
    { where, runner: truth, server: truth },
  );
}

describe('subagent count — the SDK message stream, end to end', () => {
  it('one background subagent: launch, work, finish → 1 then 0', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a', 'worker A');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'worker A', [A]),
      sdk.text('launched'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'after launch + turn end');

    await runner.feed([
      sdk.childActivity('toolu_a'),
      sdk.taskProgress('task_a', 'toolu_a'),
      ...backgroundFinish('toolu_a', 'task_a', []),
    ]);
    expectCount(fx, runner, 0, 'after the background finish');
  });

  it('a subagent that OUTLIVES its turn is not dropped, and still zeroes', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'long worker', [A]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'turn over, agent still running');

    // A second, unrelated turn runs to completion while A is still working.
    await runner.feed([sdk.text('another turn'), sdk.result('success')]);
    expectCount(fx, runner, 1, 'a later turn must not retire it');

    await runner.feed(backgroundFinish('toolu_a', 'task_a', []));
    expectCount(fx, runner, 0, 'out-of-turn finish');
  });

  it('a NESTED launch never gets its own row (the first bug)', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');
    const N = liveTask('task_nested', 'nested worker');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'launcher', [A]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'parent only');

    // The child spawns its own agent. Everything about the grandchild arrives
    // on THIS stream, but always under an id that never launched at top level.
    await runner.feed([
      sdk.nestedLaunch('toolu_a', 'toolu_nested'),
      sdk.level([A, N]),
      sdk.taskStarted('task_nested', 'toolu_nested', 'nested worker'),
      sdk.childActivity('toolu_nested'),
      sdk.childActivity('toolu_nested'),
    ]);
    expectCount(fx, runner, 1, 'a grandchild must not add a row');

    await runner.feed([
      sdk.level([A]),
      sdk.taskNotification('task_nested', 'toolu_nested'),
      ...backgroundFinish('toolu_a', 'task_a', []),
    ]);
    expectCount(fx, runner, 0, 'both gone');
  });

  it('a killed subagent zeroes (task_updated carries no tool_use_id)', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'doomed', [A]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'launched');

    await runner.feed([sdk.level([]), sdk.taskUpdated('task_a', 'killed')]);
    expectCount(fx, runner, 0, 'killed');
  });

  it('a foreground Task ends on its tool_result, not on the launch ack', async () => {
    const fx = await bootPair();
    const { runner } = fx;

    // A foreground Task never appears in a level payload at all.
    await runner.feed([
      sdk.init(),
      sdk.launchToolUse('toolu_f', 'foreground worker', 'Task'),
      sdk.taskStarted('task_f', 'toolu_f', 'foreground worker'),
      sdk.childActivity('toolu_f'),
    ]);
    expectCount(fx, runner, 1, 'foreground running');

    await runner.feed([sdk.foregroundResult('toolu_f'), sdk.result('success')]);
    expectCount(fx, runner, 0, 'foreground finished');
  });

  it('a runner disconnect/reconnect mid-flight preserves the count', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');
    const B = liveTask('task_b');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'A', [A]),
      ...backgroundLaunch('toolu_b', 'task_b', 'B', [A, B]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 2, 'two running');

    await runner.disconnect();
    expect(fx.cache.getSubagentCount(fx.paneId)).toBe(0); // the runner is gone

    // While the socket is down, A finishes. The frame is DROPPED (index.ts's
    // sendFrame is a no-op with no socket) — the reconnect must still land the
    // server on the truth, not on the pre-disconnect set.
    await runner.feed(backgroundFinish('toolu_a', 'task_a', [B]));
    await runner.reconnect();
    expectCount(fx, runner, 1, 'reconnect re-announces only what is live');

    await runner.feed(backgroundFinish('toolu_b', 'task_b', []));
    expectCount(fx, runner, 0, 'last one finished');
  });

  it('a Stop with launches outstanding lands on the truth, not above it', async () => {
    // The SDK's ACTUAL interrupt behaviour, from a live probe
    // (--stop-after 14): the interrupt kills the tasks of the interrupted turn
    // and ANNOUNCES each one — `task_updated{status:'killed'}` followed by
    // `task_notification{status:'stopped'}` WITH its tool_use_id — and the
    // level payload emitted at the same instant still lists the background
    // tasks that were NOT part of that turn. Those survivors go on to complete
    // normally (observed: one finished 19s after the Stop, another 28s after).
    //
    // That contradicts end-path #4's stated premise, that a Stop's background
    // tasks "announce it NOWHERE — no tool_result, no finish notice".
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');
    const B = liveTask('task_b');

    // Turn 1 launches A, which outlives the turn.
    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'A', [A]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'A running');

    // Turn 2 launches B; the user hits Stop before it settles.
    runner.backend.send('do more');
    await runner.feed([sdk.text('working'), ...backgroundLaunch('toolu_b', 'task_b', 'B', [A, B])]);
    expectCount(fx, runner, 2, 'A and B both running');

    runner.backend.stop();
    // The interrupt's own frames, in the probe's exact order: the level (still
    // carrying the survivor A), the kill edges for B, then the turn result.
    await runner.feed([
      sdk.level([A]),
      sdk.taskUpdated('task_b', 'killed'),
      sdk.taskNotification('task_b', 'toolu_b', 'stopped'),
      sdk.result('error_during_execution'),
    ]);
    // A belongs to the PREVIOUS turn and is demonstrably still running. Nothing
    // further need arrive from the SDK — no more membership changes are due
    // until A itself ends — so the count has to be right at THIS point, not
    // merely recoverable if another level payload happens along.
    expectCount(fx, runner, 1, 'A survived the Stop on turn 2');

    await runner.feed(backgroundFinish('toolu_a', 'task_a', []));
    expectCount(fx, runner, 0, 'A finished');
  });

  it('a DISPLACED runner hands the count to its successor, whose own work counts', async () => {
    // Displacement is NOT the reconnect above. A respawned runner can register
    // BEFORE the old socket's close fires, and the old conn's teardown then
    // refuses to act (it would detach its successor) — so the teardown that
    // zeroes the count never runs. My reconnect case goes through teardown and
    // could never have caught this; roster-server found it and fixed it by
    // deriving the count from the REGISTERED conn at every registry mutation.
    //
    // What this adds on top of their coverage is a REAL roster on both sides:
    // the predecessor is a live backend that still believes in its subagents,
    // and the successor goes on to launch its own through the real dispatch. The
    // count has to follow the registered runner in both directions — drop the
    // predecessor's entirely, then track the successor's from zero.
    const fx = await boot();
    const first = await startFakeRunner({ port: fx.port, paneId: fx.paneId, sid: SID });
    const A = liveTask('task_a');
    const B = liveTask('task_b');
    await first.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'A', [A]),
      ...backgroundLaunch('toolu_b', 'task_b', 'B', [A, B]),
      sdk.result('success'),
    ]);
    expectCount(fx, first, 2, 'predecessor has two running');

    // A second runner process takes the pane over while the first socket is
    // still open. Awaiting the 4001 close is a deterministic barrier for "the
    // swap happened" rather than a guess at a sleep.
    const displaced = new Promise<void>((r) => {
      const t = setInterval(() => {
        if (!first.connected()) {
          clearInterval(t);
          r();
        }
      }, 10);
    });
    const second = await startFakeRunner({ port: fx.port, paneId: fx.paneId, sid: SID });
    const prev = cleanup;
    cleanup = async () => {
      await second.kill().catch(() => {});
      await first.kill().catch(() => {});
      if (prev) await prev();
    };
    await displaced;

    // The predecessor still BELIEVES in its two subagents — it is a live process
    // with a live roster until it exits. The pane must not care: the successor
    // is the registered runner and its roster is empty.
    expect(counts(fx, first).runner).toBe(2);
    expect(fx.cache.getSubagentCount(fx.paneId)).toBe(0);
    expect(fx.cache.getStatus(fx.paneId, false)).not.toBe('working');

    // …and the successor's OWN launches count from zero, neither inheriting the
    // predecessor's two nor being suppressed by them.
    const C = liveTask('task_c');
    await second.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_c', 'task_c', 'C', [C]),
      sdk.result('success'),
    ]);
    expectCount(fx, second, 1, 'the successor counts its own work');
    await second.feed(backgroundFinish('toolu_c', 'task_c', []));
    expectCount(fx, second, 0, 'and drains to zero');
  });

  it('runner death zeroes the pane', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'A', [A]),
      sdk.result('success'),
    ]);
    expect(fx.cache.getSubagentCount(fx.paneId)).toBe(1);

    await runner.kill();
    expect(fx.cache.getSubagentCount(fx.paneId)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE FLEET SEQUENCE. Everything above, in one session, over many turns —
  // the shape a real muxpad pane produces and the shape neither previous fix
  // was ever run against.
  // ───────────────────────────────────────────────────────────────────────────
  it('twelve subagents over six turns end at EXACTLY zero', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const t = (n: number) => liveTask(`task_${n}`, `worker ${n}`);
    const tu = (n: number) => `toolu_${n}`;
    /** The tasks the SDK considers live, as the script believes them. */
    let live: number[] = [];
    const levelOf = () => live.map(t);

    await runner.feed([sdk.init()]);

    // ── Turn 1: two launches, one finishes mid-turn.
    live = [1, 2];
    await runner.feed([
      ...backgroundLaunch(tu(1), 'task_1', 'worker 1', [t(1)]),
      ...backgroundLaunch(tu(2), 'task_2', 'worker 2', levelOf()),
      sdk.childActivity(tu(1)),
      sdk.childActivity(tu(2)),
    ]);
    expectCount(fx, runner, 2, 'turn 1: two launched');
    live = [2];
    await runner.feed([...backgroundFinish(tu(1), 'task_1', levelOf()), sdk.result('success')]);
    expectCount(fx, runner, 1, 'turn 1 over, worker 2 outlives it');

    // ── Turn 2: three more launches; worker 2 finishes OUT of any turn.
    runner.backend.send('turn 2');
    live = [2, 3, 4, 5];
    await runner.feed([
      ...backgroundLaunch(tu(3), 'task_3', 'worker 3', [t(2), t(3)]),
      ...backgroundLaunch(tu(4), 'task_4', 'worker 4', [t(2), t(3), t(4)]),
      ...backgroundLaunch(tu(5), 'task_5', 'worker 5', levelOf()),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 4, 'turn 2: 2,3,4,5 live');
    live = [3, 4, 5];
    await runner.feed(backgroundFinish(tu(2), 'task_2', levelOf()));
    expectCount(fx, runner, 3, 'worker 2 finished between turns');

    // ── Turn 3: a nested fan-out under worker 3. No new top-level rows.
    runner.backend.send('turn 3');
    await runner.feed([
      sdk.nestedLaunch(tu(3), 'toolu_nested_a'),
      sdk.level([...levelOf(), liveTask('task_nested_a', 'nested a')]),
      sdk.taskStarted('task_nested_a', 'toolu_nested_a', 'nested a'),
      sdk.nestedLaunch(tu(3), 'toolu_nested_b'),
      sdk.level([
        ...levelOf(),
        liveTask('task_nested_a', 'nested a'),
        liveTask('task_nested_b', 'nested b'),
      ]),
      sdk.taskStarted('task_nested_b', 'toolu_nested_b', 'nested b'),
      sdk.childActivity('toolu_nested_a'),
      sdk.childActivity('toolu_nested_b'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 3, 'turn 3: nested agents add no rows');

    await runner.feed([
      sdk.level(levelOf()),
      sdk.taskNotification('task_nested_a', 'toolu_nested_a'),
      sdk.taskNotification('task_nested_b', 'toolu_nested_b'),
    ]);
    expectCount(fx, runner, 3, 'nested finishes touch nothing');

    // ── Turn 4: a Stop with a fresh launch outstanding. 3,4,5 predate it.
    runner.backend.send('turn 4');
    live = [3, 4, 5, 6];
    await runner.feed([...backgroundLaunch(tu(6), 'task_6', 'worker 6', levelOf())]);
    expectCount(fx, runner, 4, 'turn 4: worker 6 launched');
    runner.backend.stop();
    live = [3, 4, 5];
    // The probe's exact interrupt order: the level (still listing 3, 4 and 5,
    // which the Stop did not touch), then worker 6's kill edges, then the
    // result. Workers 3–5 were launched by EARLIER turns and keep running.
    await runner.feed([
      sdk.level(levelOf()),
      sdk.taskUpdated('task_6', 'killed'),
      sdk.taskNotification('task_6', tu(6), 'stopped'),
      sdk.result('error_during_execution'),
    ]);
    expectCount(fx, runner, 3, 'the Stop took only worker 6');

    // ── A ws blip mid-flight.
    await runner.disconnect();
    live = [4, 5];
    await runner.feed(backgroundFinish(tu(3), 'task_3', levelOf()));
    await runner.reconnect();
    expectCount(fx, runner, 2, 'reconnect rebuilds the live set only');

    // ── Turn 5: three launches, one killed, one that never runs at all.
    runner.backend.send('turn 5');
    live = [4, 5, 7, 8];
    await runner.feed([
      ...backgroundLaunch(tu(7), 'task_7', 'worker 7', [t(4), t(5), t(7)]),
      ...backgroundLaunch(tu(8), 'task_8', 'worker 8', levelOf()),
      // A Task call that is delivered and then never executes: no task_started,
      // no child traffic, never in a level payload.
      sdk.launchToolUse(tu(9), 'worker 9 (retracted)'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 4, 'turn 5: the retracted launch is swept at result');

    live = [4, 5, 8];
    await runner.feed([sdk.level(levelOf()), sdk.taskUpdated('task_7', 'killed')]);
    expectCount(fx, runner, 3, 'worker 7 killed');

    // ── Turn 6: a rate-limit pause on worker 8, then it resumes and finishes.
    runner.backend.send('turn 6');
    await runner.feed([sdk.taskUpdated('task_8', 'paused'), sdk.level([t(4), t(5)])]);
    expectCount(fx, runner, 3, 'a paused agent is still a live agent');
    await runner.feed([sdk.level(levelOf()), sdk.taskUpdated('task_8', 'running')]);
    expectCount(fx, runner, 3, 'resumed');

    // ── Everything drains.
    live = [5, 8];
    await runner.feed(backgroundFinish(tu(4), 'task_4', levelOf()));
    expectCount(fx, runner, 2, 'worker 4 done');
    live = [8];
    await runner.feed(backgroundFinish(tu(5), 'task_5', levelOf()));
    expectCount(fx, runner, 1, 'worker 5 done');
    live = [];
    await runner.feed([...backgroundFinish(tu(8), 'task_8', levelOf()), sdk.result('success')]);

    // THE PROPERTY. Everything that ever launched has finished; the pane must
    // read zero, on both sides of the wire.
    expectCount(fx, runner, 0, 'the fleet has fully drained');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Shapes the SDK DECLARES as possible. A live probe of 0.3.220
// (scripts/sdk-task-probe.mjs, 12 task_started / 12 task_notification, 5
// top-level launches) saw `tool_use_id` present on every one — but the type
// declares it optional on BOTH bookends, and the roster's whole end-path
// depends on it. An optional field the happy path always sets is exactly the
// kind of assumption that survives two rounds of code review and then bites.
//
// The property is the same one as above: once every task has ended, ZERO.
// ───────────────────────────────────────────────────────────────────────────
describe('subagent count — SDK shapes the declarations permit', () => {
  it('survives a task_started that omits tool_use_id, then a normal finish', async () => {
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');

    await runner.feed([
      sdk.init(),
      sdk.launchToolUse('toolu_a', 'worker'),
      sdk.level([A]),
      // `tool_use_id` is optional on SDKTaskStartedMessage. With it omitted the
      // task channel cannot bind this row — but the launch ack can, and does:
      // it carries `agentId: <task_id>` (11/11 background launches across two
      // captures, always equal to the task_started task_id).
      sdk.taskStarted('task_a', null, 'worker'),
      sdk.launchAck('toolu_a', 'task_a'),
      sdk.childActivity('toolu_a'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'running');

    // The task ends the ordinary way: level drops it, then both edges fire.
    await runner.feed([
      sdk.level([]),
      sdk.taskUpdated('task_a', 'completed'),
      sdk.taskNotification('task_a', 'toolu_a'),
    ]);
    expectCount(fx, runner, 0, 'the ack binding must survive a task_started with no tool_use_id');
  });

  it('survives a launch with NO id link anywhere — ack, start and finish all bare', async () => {
    // The pathological shape: no `agentId:` on the ack, no `tool_use_id` on
    // either bookend. Nothing observed live produces this (every captured ack
    // carried agentId, every captured bookend carried tool_use_id), so it is a
    // backstop, not a repro — but an entry with steps that no id can reach is
    // precisely the field symptom, so the floor has to hold without an id.
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');

    await runner.feed([
      sdk.init(),
      sdk.launchToolUse('toolu_a', 'idless worker'),
      sdk.level([A]),
      sdk.taskStarted('task_a', null, 'idless worker'),
      sdk.launchAck('toolu_a', null),
      sdk.childActivity('toolu_a'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'running');

    // `retireUnstarted` deliberately spares it (it has steps), and no task-keyed
    // path can find it. Only the level signal going EMPTY — "no background task
    // is running at all" — can settle it.
    await runner.feed([
      sdk.level([]),
      sdk.taskUpdated('task_a', 'completed'),
      sdk.taskNotification('task_a', null),
    ]);
    expectCount(fx, runner, 0, 'the level signal must catch what the edges lost');
  });

  it('a paused agent that later completes still zeroes', async () => {
    // Rate limits pause background tasks, and a fleet hits rate limits. The
    // roster makes a paused entry ineligible for the level sweep on purpose
    // (absence must not kill a live agent) — but the SDK's documented
    // membership changes are "start, completion, kill, backgrounding", so a
    // RESUME may never re-list it. The completion edges have to carry it.
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'rate-limited worker', [A]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'running');

    await runner.feed([sdk.taskUpdated('task_a', 'paused'), sdk.level([])]);
    expectCount(fx, runner, 1, 'paused is still live — absence must not evict it');

    // It resumes with NO level payload (resume is not a membership change) and
    // then finishes normally.
    await runner.feed([
      sdk.taskUpdated('task_a', 'running'),
      sdk.childActivity('toolu_a'),
      sdk.level([]),
      sdk.taskUpdated('task_a', 'completed'),
      sdk.taskNotification('task_a', 'toolu_a'),
    ]);
    expectCount(fx, runner, 0, 'a paused-then-finished agent must not be immortal');
  });

  it('a finish signalled ONLY by the level signal still zeroes', async () => {
    // `background_tasks_changed` is documented as the signal a missed bookend
    // cannot wedge: "consumers that only need 'is background work running'
    // should replace their set with each payload rather than pairing edges".
    // That promise is only kept if a dropped edge pair is survivable.
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');
    const B = liveTask('task_b');

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'A', [A]),
      ...backgroundLaunch('toolu_b', 'task_b', 'B', [A, B]),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 2, 'two running');

    // No task_updated, no task_notification — only the level.
    await runner.feed([sdk.level([B])]);
    expectCount(fx, runner, 1, 'the level alone retires A');
    await runner.feed([sdk.level([])]);
    expectCount(fx, runner, 0, 'the level alone retires B');
  });

  it('a launch whose level payload never arrives is still retirable', async () => {
    // The level is emitted on membership change, but its ordering against the
    // bookends is explicitly "unspecified" and it is per-process. An entry never
    // SEEN in a level payload must still have a way out.
    const fx = await bootPair();
    const { runner } = fx;

    await runner.feed([
      sdk.init(),
      sdk.launchToolUse('toolu_a', 'level-less worker'),
      sdk.taskStarted('task_a', 'toolu_a', 'level-less worker'),
      sdk.launchAck('toolu_a', 'task_a'),
      sdk.childActivity('toolu_a'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'running, never level-listed');

    await runner.feed([sdk.level([]), sdk.taskNotification('task_a', 'toolu_a')]);
    expectCount(fx, runner, 0, 'the edge retires it');
  });

  it('background BASH tasks in the level payload cannot move the count', async () => {
    // The level signal is not agent-only: the captures show `local_bash` task
    // ids sharing the payload with agents (6 of 11 across two runs). They are
    // never launched at top level, so they must neither create a row nor — the
    // subtler half — count as "the background set is non-empty" in a way that
    // rescues an agent row that should have been swept.
    const fx = await bootPair();
    const { runner } = fx;
    const A = liveTask('task_a');
    const BASH = { task_id: 'bn911erx6', task_type: 'local_bash', description: 'sleep 30' };

    await runner.feed([
      sdk.init(),
      ...backgroundLaunch('toolu_a', 'task_a', 'A', [A]),
      // A top-level background Bash starts: it joins the level payload and gets
      // its own task_started under the Bash call's tool_use id.
      sdk.level([A, BASH]),
      sdk.taskStarted('bn911erx6', 'toolu_bash', 'sleep 30'),
      sdk.result('success'),
    ]);
    expectCount(fx, runner, 1, 'the bash task adds no row');

    // The agent finishes while the bash task is still running, so the level is
    // NOT empty when the agent leaves it.
    await runner.feed([
      sdk.level([BASH]),
      sdk.taskUpdated('task_a', 'completed'),
      sdk.taskNotification('task_a', 'toolu_a'),
    ]);
    expectCount(fx, runner, 0, 'a non-empty level of bash tasks must not keep the agent alive');

    // …and the bash task's own finish is a no-op either way.
    await runner.feed([sdk.level([]), sdk.taskNotification('bn911erx6', 'toolu_bash')]);
    expectCount(fx, runner, 0, 'still zero');
  });

  it('a version-skewed runner cannot push the pane past the cap', async () => {
    // The pane observed in the field is served by a runner process that booted
    // 2026-08-21 — nine days before the durable roster existed. It emits
    // launches and NEVER a terminal frame, and it only picks up new code when
    // its pane respawns. The server cannot fix its accounting; it must bound it.
    const fx = await boot();
    const runner = await startFakeRunner({ port: fx.port, paneId: fx.paneId, sid: SID });
    const prev = cleanup;
    cleanup = async () => {
      await runner.kill().catch(() => {});
      if (prev) await prev();
    };

    const msgs: unknown[] = [sdk.init()];
    for (let i = 0; i < 45; i++) {
      msgs.push(sdk.launchToolUse(`toolu_skew_${i}`, `worker ${i}`));
      msgs.push(sdk.taskStarted(`task_skew_${i}`, `toolu_skew_${i}`, `worker ${i}`));
      msgs.push(sdk.childActivity(`toolu_skew_${i}`));
    }
    await runner.feed(msgs);
    // Bounded on BOTH sides — and the bound is the same number, so the two
    // layers cannot oscillate against each other.
    expect(fx.cache.getSubagentCount(fx.paneId)).toBeLessThanOrEqual(32);
    expect(fx.cache.getSubagentCount(fx.paneId)).toBeGreaterThan(0);
  });
});
