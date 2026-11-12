// R2-4, IN THE PRODUCTION ORDER.
//
// `tab-retire.test.ts` calls `ChatRetirer.onTurnEnded` directly, and its
// fixture sets the pane unread BEFORE the retirer runs. That is the reverse of
// what ws.ts does, and the ordering is the entire finding: at turn-done,
// `emitTurn('done')` is a SYNCHRONOUS bus emit, so the retirer has already run
// and already cleared this pane's marks by the time the handler reaches
// `panes.setUnread(paneId, true)` thirty lines below. A test that pre-sets the
// mark proves the retirer can clear one; it cannot see the write that lands
// after it.
//
// So this file drives the real sequence: real ws.ts, a real `ChatRetirer` on
// the real bus, real runner frames over a real socket. What it asserts is the
// property the unit test structurally cannot — that when the dust settles, a
// row is not simultaneously `done` and `ready`.
//
// No ptyd: nothing on the runner ws path touches it, and a real pty daemon is
// the flakiest dependency in the suite (the pattern is subagent-mirror.test.ts's).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { clockIndex, resolveTabClock } from './tab-clock.js';
import { ChatRetirer } from './tab-retire.js';
import { attachWsServer } from './ws.js';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

/** Enough PtydClient for the runner ws path, which never calls into it. */
const stubPtyd = () =>
  ({
    socketPath: '/tmp/muxpad-test-never-connected.sock',
    getForegroundCommand: async () => null,
    killPane: async () => {},
    ensurePane: async () => {},
    on: () => {},
  }) as unknown as PtydClient;

/**
 * The settle these tests run with.
 *
 * Real timer, real frames — only the WINDOW is shortened. The production 90 s
 * is sized for the gap between two turns of one job (see JOB_SETTLE_MS); what
 * these tests need is the same mechanism at a length a suite can wait out, and
 * the ordering they exist to pin is unaffected by its size.
 */
const SETTLE_MS = 60;

async function boot() {
  const db = openDb(':memory:');
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const events = new EventBus();
  const cache = new PtydCache();
  const w = new WorkspaceStore(db).create({ name: 'W' });

  const parent = tabs.create({ name: 'parent', layout: '', workspace_id: w.id });
  panes.create({ tab_id: parent.id, startup_cmd: 'muxpad agent', face: 'chat' });
  const child = tabs.create({
    name: 'worker',
    layout: 'p1',
    workspace_id: w.id,
    spawned_by: parent.id,
  });
  const childPane = panes.create({
    tab_id: child.id,
    shell: '/bin/cat',
    cwd: '/tmp',
    startup_cmd: 'muxpad agent',
    face: 'chat',
  });

  const http = createServer();
  const wsServer = attachWsServer({ http, db, ptyd: stubPtyd(), cache, events });
  // The same wiring index.ts does — the retirer is what makes turn-done
  // retire a sub-chat, and it is subscribed to the same bus ws.ts emits on.
  const retirer = new ChatRetirer({ db, cache, events }, SETTLE_MS);
  retirer.start();
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    retirer.stop();
    await wsServer.close();
    await new Promise<void>((r) => http.close(() => r()));
  };

  return {
    port,
    cache,
    childTab: child.id,
    childPane: childPane.id,
    done: () => resolveTabClock(clockIndex(db), child.id, Date.now()),
    unread: () => panes.getById(childPane.id)?.unread === true,
  };
}

async function openSock(url: string): Promise<WebSocket> {
  const sock = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    sock.once('open', () => resolve());
    sock.once('error', reject);
  });
  return sock;
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 15));
}

const SID = '11111111-2222-3333-4444-555555555555';
const hello = JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 4242, turnActive: false });

describe('a retired sub-chat does not come back wearing a READY dot', () => {
  it('finishes the turn done and NOT ready, in the real order', async () => {
    // The runner never sent a user message, so `conn.lastHumanSendAt` is 0 and
    // the two-minute interactivity gate is wide open — which is the state any
    // turn longer than two minutes ends in, i.e. most real work.
    const t = await boot();
    const runner = await openSock(`ws://127.0.0.1:${t.port}/ws/agent-runner/${t.childPane}`);
    runner.send(hello);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));

    await waitUntil(() => t.done().done);
    expect(t.done().done_reason).toBe('delivered');
    // The write that lands AFTER the retirement. Give it room to happen: the
    // point of the test is that it does not, not that it is slow.
    await new Promise((r) => setTimeout(r, 120));
    expect(t.unread()).toBe(false);
    runner.close();
  });

  it('still marks a TOP-LEVEL chat ready — the gate is retirement, not turn-done', async () => {
    // The other half, and the reason this is not a blanket "stop marking
    // unread": a conversation you are having does not retire when the agent
    // stops talking, and the bold in the nav is the whole quiet-channel
    // signal that it finished while you were away.
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const events = new EventBus();
    const cache = new PtydCache();
    const w = new WorkspaceStore(db).create({ name: 'W' });
    const top = tabs.create({ name: 'top', layout: 'p1', workspace_id: w.id });
    const pane = panes.create({
      tab_id: top.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
      face: 'chat',
    });
    const http = createServer();
    const wsServer = attachWsServer({ http, db, ptyd: stubPtyd(), cache, events });
    const retirer = new ChatRetirer({ db, cache, events }, SETTLE_MS);
    retirer.start();
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      retirer.stop();
      await wsServer.close();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    runner.send(hello);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));

    await waitUntil(() => panes.getById(pane.id)?.unread === true);
    expect(panes.getById(pane.id)?.unread).toBe(true);
    expect(resolveTabClock(clockIndex(db), top.id, Date.now()).done).toBe(false);
    runner.close();
  });
});

/**
 * A WORKER KILLED MID-TURN IS A CRASH, NOT A DELIVERY.
 *
 * Found by an adversarial review of the sub-chat lifecycle. The teardown
 * balanced its turn pair with `done`, which is true of the PAIR and false
 * about the work: a resume starts a fresh turn, it never continues the one
 * that was cut off. So the retirement settle saw a worker that had ended a
 * turn and come back idle, retired it as `delivered`, and the parent got a
 * green "finished" card and a confident summary of half-done work.
 *
 * Driven here rather than in the unit file because the thing under test IS the
 * phase ws.ts puts on the bus when a socket dies — the retirer only believes
 * what it is told.
 */
describe('a runner that dies mid-turn', () => {
  it('ends its turn FATAL, so the job is reported as crashed', async () => {
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const events = new EventBus();
    const cache = new PtydCache();
    const w = new WorkspaceStore(db).create({ name: 'W' });
    const top = tabs.create({ name: 'top', layout: 'p1', workspace_id: w.id });
    const pane = panes.create({
      tab_id: top.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
      face: 'chat',
    });
    const phases: string[] = [];
    events.subscribe((e) => {
      if (e.type === 'agent_turn') phases.push(e.phase);
    });
    const http = createServer();
    const wsServer = attachWsServer({
      http,
      db,
      ptyd: stubPtyd(),
      cache,
      events,
      // The real grace is 20 s. Only its LENGTH is shortened — what is under
      // test is which way the question is answered, not how long it waits.
      reconnectGraceMs: 120,
    });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      await wsServer.close();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    runner.send(hello);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await waitUntil(() => phases.includes('start'));
    // The runner dies with the turn still open — a SIGKILL, an OOM, a ptyd
    // bounce. No `turn-done` is ever sent.
    runner.terminate();

    await waitUntil(() => phases.length > 1);
    expect(phases).toEqual(['start', 'fatal']);
  });

  /**
   * …AND A BLIP IS NOT A DEATH. THIS IS THE EXPENSIVE HALF.
   *
   * The runner survives its socket: it retries every 2 s and hellos back
   * mid-turn, still working. The heartbeat note in ws.ts measured 382 of these
   * in ONE pane in a day. Calling each of them a crash is worse than the bug
   * `fatal` was added to fix — a cron `--new-tab` schedule writes a durable
   * `kept` row and wedges on max_open for ever, and `muxpad agent wait` exits
   * 2 for a worker that is still working, which an orchestrator reads as
   * "respawn it".
   *
   * So the bus must hear NOTHING at all here: no `fatal`, and no second
   * `start` either — the turn never ended, and two starts for one turn
   * unbalances the pair the other way.
   */
  it('says nothing at all when the runner comes back mid-turn', async () => {
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const events = new EventBus();
    const cache = new PtydCache();
    const w = new WorkspaceStore(db).create({ name: 'W' });
    const top = tabs.create({ name: 'top', layout: 'p1', workspace_id: w.id });
    const pane = panes.create({
      tab_id: top.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
      face: 'chat',
    });
    const phases: string[] = [];
    events.subscribe((e) => {
      if (e.type === 'agent_turn') phases.push(e.phase);
    });
    const http = createServer();
    const wsServer = attachWsServer({
      http,
      db,
      ptyd: stubPtyd(),
      cache,
      events,
      reconnectGraceMs: 400,
    });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      await wsServer.close();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    runner.send(hello);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await waitUntil(() => phases.includes('start'));
    runner.terminate();

    // Back inside the grace, STILL MID-TURN — which is what a reconnecting
    // runner reports, because its turn really is still running.
    const back = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    back.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 4242, turnActive: true }));

    // Long enough that a parked `fatal` would have fired.
    await new Promise((r) => setTimeout(r, 700));
    expect(phases).toEqual(['start']);

    // …and the turn still ends exactly once, when it really ends.
    back.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await waitUntil(() => phases.length > 1);
    expect(phases).toEqual(['start', 'done']);
    back.close();
  });

  it('calls it a crash when the runner comes back IDLE — the turn did end', async () => {
    // The case `fatal` exists for, reached the other way: the process was
    // killed and restarted, so it is back, but its turn is gone. A resume
    // starts a fresh turn; it never continues the one that was cut off.
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const events = new EventBus();
    const cache = new PtydCache();
    const w = new WorkspaceStore(db).create({ name: 'W' });
    const top = tabs.create({ name: 'top', layout: 'p1', workspace_id: w.id });
    const pane = panes.create({
      tab_id: top.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
      face: 'chat',
    });
    const phases: string[] = [];
    events.subscribe((e) => {
      if (e.type === 'agent_turn') phases.push(e.phase);
    });
    const http = createServer();
    const wsServer = attachWsServer({
      http,
      db,
      ptyd: stubPtyd(),
      cache,
      events,
      // Deliberately long: the verdict must come from the IDLE hello, not
      // from the grace running out.
      reconnectGraceMs: 30_000,
    });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      await wsServer.close();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    runner.send(hello);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await waitUntil(() => phases.includes('start'));
    runner.terminate();

    const back = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    back.send(hello); // turnActive: false

    await waitUntil(() => phases.length > 1);
    expect(phases).toEqual(['start', 'fatal']);
    back.close();
  });
});

/**
 * WHETHER A ROW GOES BOLD MUST NOT DEPEND ON HOW LONG THE TURN TOOK.
 *
 * Reported as "the sidebar isn't consistent in marking tabs that have new
 * messages in bold", and it was not. `panes.setUnread(…, true)` sat inside the
 * PUSH gate — `Date.now() - conn.lastHumanSendAt > 2 min` — so a turn you kicked
 * off and walked away from got a bold row only if it ran long enough. Send,
 * switch tabs, turn lands in 90 seconds → nothing. The identical turn taking
 * three minutes → bold. Same chat, same reader, opposite answers, and no way for
 * the reader to tell which rule applied.
 *
 * The gate's reason was "a turn you're actively driving isn't unread (you're
 * watching it)" — a claim about LOOKING, answered by a timer about TYPING. Those
 * come apart the moment you send something and go elsewhere. The claim already
 * has an exact answer elsewhere: TabView clears the mark on the tab you actually
 * have open (`seenSignature`), on the same edge.
 *
 * The push KEEPS the gate. A vibration mid-conversation is a real cost; a bold
 * name is the quiet channel and costs nothing.
 *
 * Real frames, real socket, real sequence — a `lastHumanSendAt` only moves when
 * the server actually relays a human message to the runner, which is what the
 * queue drain below does.
 */
describe('the bold mark does not depend on how recently you typed', () => {
  it('marks a chat you sent to SECONDS ago and left', async () => {
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const w = new WorkspaceStore(db).create({ name: 'W' });
    const top = tabs.create({ name: 'top', layout: 'p1', workspace_id: w.id });
    const pane = panes.create({
      tab_id: top.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
      face: 'chat',
    });
    const http = createServer();
    const wsServer = attachWsServer({
      http,
      db,
      ptyd: stubPtyd(),
      cache: new PtydCache(),
      events: new EventBus(),
    });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      await wsServer.close();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    runner.send(hello);
    // A message the USER typed, waiting for the agent. The turn-done below
    // drains it, and THAT relay is what stamps `lastHumanSendAt` — so by the
    // time the second turn ends we are a few milliseconds inside the two-minute
    // window, which is where the old code went quiet.
    new AgentQueueStore(db).enqueue(pane.id, 'have a look at this');
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    // The drained message's own turn.
    await waitUntil(() => new AgentQueueStore(db).count(pane.id) === 0);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));

    // Bold. Before the fix this waited out its timeout and stayed false.
    await waitUntil(() => panes.getById(pane.id)?.unread === true);
    expect(panes.getById(pane.id)?.unread).toBe(true);
    runner.close();
  });
});

/**
 * THE TWIN, IN THE PRODUCTION ORDER: a worker archived while it was working.
 *
 * Observed live — two sub-chats with `retired_at` set and `spawn_report_state`
 * UNSET while both panes read `working`, a status bar saying "2 agents" over a
 * sidebar with no sub-chat rows in it. A worker's job is not one turn: a
 * background task coming back, a wakeup, a tool call resuming it all end a turn
 * and start another, and every one of those boundaries retired it.
 *
 * Driven with REAL runner frames over a REAL socket and a REAL timer, because
 * the sequence is the finding — the unit tests can force a settle, but only
 * this can show that an ordinary multi-turn conversation never reaches one.
 */
describe('a worker is not finished just because a turn ended', () => {
  /** Long enough for a settle to have fired if one was going to. */
  const pastTheSettle = () => new Promise((r) => setTimeout(r, SETTLE_MS * 4));

  it('STAYS LIVE across turn boundaries, and retires after the last one', async () => {
    const t = await boot();
    const runner = await openSock(`ws://127.0.0.1:${t.port}/ws/agent-runner/${t.childPane}`);
    runner.send(hello);

    // Three turns of ONE job. Each boundary is exactly what used to archive it.
    for (let i = 0; i < 3; i++) {
      runner.send(JSON.stringify({ t: 'turn-start' }));
      runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
      // The next turn begins before the window elapses — a background task
      // reporting back, which is the real shape of the failure.
      await new Promise((r) => setTimeout(r, SETTLE_MS / 3));
      expect(t.done().done).toBe(false);
    }

    // Now it really stops.
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await waitUntil(() => t.done().done);
    expect(t.done().done_reason).toBe('delivered');
    runner.close();
  });

  it('COMES BACK ON ITS OWN if it turns out not to have finished', async () => {
    // The case no window can cover: quiet for longer than the settle because
    // it was waiting on something no roster can see. It retires — and then
    // speaks again. It must rejoin the sidebar without the user doing anything,
    // which is the difference between a bug they never notice and the one they
    // reported.
    const t = await boot();
    const runner = await openSock(`ws://127.0.0.1:${t.port}/ws/agent-runner/${t.childPane}`);
    runner.send(hello);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));

    await waitUntil(() => t.done().done);
    expect(t.done().done).toBe(true);

    runner.send(JSON.stringify({ t: 'turn-start' }));

    await waitUntil(() => !t.done().done);
    expect(t.done().done).toBe(false);
    // …and it is not re-retired while that turn is still running.
    await pastTheSettle();
    expect(t.done().done).toBe(false);
    runner.close();
  });
});
