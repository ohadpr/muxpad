// The dead-runner sweep's most consequential distinction: "ptyd is
// unreachable" is NOT "the runner is dead".
//
// The sweep judges an agent pane by its pty foreground. `getForegroundCommand`
// only REJECTS when the ptyd socket isn't open (an unknown pane RESOLVES with
// null), so a rejection means liveness is unknown. Treating it as death meant a
// multi-minute ptyd outage spent every agent pane's whole restart budget on
// panes that were fine, marked them dead, and — the part that isn't
// recoverable — CLEARED THEIR DURABLE SEND QUEUES. Reconnect couldn't undo it:
// given-up panes are skipped.
//
// Driving this at its real cadence would take minutes (20s sweep, 45s
// cooldown, 3 attempts), so the sweep is exposed as a handle method and called
// directly. The FIRST sweep is the whole test: with the bug it already spends
// an attempt and announces "agent process died — restarting (attempt 1/3)".
// The give-up that clears the queue is three cooldowns further on, which no
// test can reach without an injectable clock — but it is only reachable
// through the attempt this test proves is never spent.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import {
  RESPAWN_COOLDOWN_MS,
  RESPAWN_MAX_ATTEMPTS,
  RESPAWN_STARTUP_GRACE_MS,
} from './respawn-policy.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { PaneStore } from './store/PaneStore.js';
import { SpawnRoundStore } from './store/SpawnRoundStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { clockIndex, resolveTabClock } from './tab-clock.js';
import { ChatRetirer } from './tab-retire.js';
import { spawnPtyd } from './test-helpers/spawnPtyd.js';
import { attachWsServer } from './ws.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

/**
 * A ws server over a real ptyd with one agent pane.
 *
 * `subChat` makes that pane's tab a CHILD of another — the only shape whose
 * lifecycle a death ends, and the one the retirement tests need.
 */
async function boot(opts: { subChat?: boolean } = {}) {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const wsRow = workspaces.create({ name: 'W' });
  const parent = opts.subChat
    ? tabs.create({ name: 'parent', layout: 'p0', workspace_id: wsRow.id })
    : null;
  const tab = tabs.create({
    name: 'T',
    layout: 'p1',
    workspace_id: wsRow.id,
    ...(parent ? { spawned_by: parent.id } : {}),
  });
  const pane = panes.create({
    tab_id: tab.id,
    shell: '/bin/cat',
    cwd: '/tmp',
    // The durable marker the sweep selects on.
    startup_cmd: 'muxpad agent',
  });
  // Past the startup grace, so the sweep is willing to judge it.
  db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(
    Date.now() - RESPAWN_STARTUP_GRACE_MS * 10,
    pane.id,
  );
  const http = createServer();
  const events = new EventBus();
  const cache = new PtydCache();
  // The retirement half, wired exactly as index.ts wires it — the point of
  // driving this through the real sweep is that the WIRING is what regressed.
  const retirer = new ChatRetirer({ db, cache, events });
  const handle = attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache,
    events,
    onRunnerDead: (paneId) => retirer.onRunnerDead(paneId),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await handle.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  const doneReason = () => resolveTabClock(clockIndex(db), tab.id, Date.now()).done_reason;
  return { db, handle, ptyd, port, paneId: pane.id, tabId: tab.id, doneReason };
}

/** Open a chat socket and collect the frames the server broadcasts to it. */
async function openChat(port: number, paneId: string) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
  const frames: Array<Record<string, unknown>> = [];
  sock.on('message', (data: Buffer) => {
    try {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // non-JSON frame — not something this test looks at
    }
  });
  await new Promise<void>((r) => sock.once('open', () => r()));
  const restarts = () =>
    frames.filter(
      (f) => typeof f.message === 'string' && /agent process died|agent exited/.test(f.message),
    );
  return { sock, frames, restarts };
}

/** Let broadcast frames traverse the loopback socket before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('dead-runner sweep vs a ptyd outage', () => {
  it('spends an attempt when ptyd answers "no runner" — the control case', async () => {
    // ptyd is UP and resolves `cmd: null` (nothing ever attached to this pane,
    // so there is no pty and no foreground). That is a real dead runner, and
    // the sweep must act on it — otherwise the test below proves nothing.
    const { handle, port, paneId } = await boot();
    const chat = await openChat(port, paneId);
    await handle.sweepDeadRunners();
    await settle();
    expect(chat.restarts()).toHaveLength(1);
    chat.sock.close();
  });

  it('burns no attempt, says nothing, and keeps the queue when ptyd is unreachable', async () => {
    const { db, handle, ptyd, port, paneId } = await boot();
    const chat = await openChat(port, paneId);
    const queue = new AgentQueueStore(db);
    queue.enqueue(paneId, 'do the thing');
    // Take ptyd away. Every control RPC now rejects with 'ptyd disconnected' —
    // liveness UNKNOWN, not dead.
    await ptyd.client.close();

    for (let i = 0; i < 5; i++) await handle.sweepDeadRunners();
    await settle();

    expect(chat.restarts()).toEqual([]);
    // The queue is what makes this a data-loss bug rather than a noisy-log one.
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['do the thing']);
    chat.sock.close();
  });
});

/**
 * THE TAB LIFECYCLE END OF THE SAME SWEEP.
 *
 * Retirement fires at TURN-END, and a runner that dies never reaches one — so a
 * killed worker's tab kept `retired_at IS NULL` for ever. Three of them
 * (new-chat-fix, xws-build, artifact-urls) sat in the sidebar for hours reading
 * exactly like running ones, and had to be archived by hand.
 *
 * Driven through the REAL sweep rather than by calling `onRunnerDead` directly,
 * because the wiring is the thing that was missing: the verdict existed the
 * whole time (`pane list` said `dead`) and nothing consumed it.
 *
 * The clock is faked — Date ONLY, so ptyd's sockets and every await stay real —
 * which is what makes the give-up reachable at all: it is three 45-second
 * cooldowns away, and `ws-respawn`'s original note says no test could get there
 * without an injectable clock.
 */
/** Headroom for a real-ptyd supervision run — see the note on the first test.
 *  The default 10s is enough on an idle machine and not on a loaded one. */
const SUPERVISION_TIMEOUT_MS = 30_000;

describe('a sub-chat whose runner is given up on', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Sweep until the sweep gives up, letting each cooldown elapse. */
  async function sweepToGiveUp(handle: { sweepDeadRunners(): Promise<void> }) {
    const base = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    // One more than the cap: attempts 1..MAX restart it, and the sweep after
    // that is the one that declares it dead.
    for (let i = 0; i <= RESPAWN_MAX_ATTEMPTS; i++) {
      vi.setSystemTime(base + i * (RESPAWN_COOLDOWN_MS + 1_000));
      await handle.sweepDeadRunners();
    }
  }

  it(
    'retires it as DIED, with its round closed',
    async () => {
      const { db, handle, tabId, doneReason } = await boot({ subChat: true });
      const rounds = new SpawnRoundStore(db);
      rounds.open(tabId, 1_000);
      // The bad state, before: live, and a round mid-flight.
      expect(doneReason()).toBeUndefined();

      await sweepToGiveUp(handle);

      // Not `delivered`. The work is INCOMPLETE and the row now says so — which
      // is the difference between a job the user can see failed and three that
      // vanished quietly.
      expect(doneReason()).toBe('died');
      // …and the card is not left spinning in the parent's log.
      expect(rounds.openRound(tabId)).toBeNull();
      // Four supervision passes against a REAL ptyd, three of them a genuine
      // killPane + ensurePane. That is the thing being tested, and it is slower
      // than the 10s default allows for on a loaded machine.
    },
    SUPERVISION_TIMEOUT_MS,
  );

  it(
    'DOES NOT RETIRE ANYTHING WHEN PTYD IS BOUNCING — the one that would bite',
    async () => {
      // A pane reads dead transiently on every ptyd bounce, main-server restart
      // and runner respawn. Retiring on the first sighting would archive every
      // chat on the machine the next time ptyd restarted, which is strictly worse
      // than the bug being fixed.
      //
      // It cannot happen, and this proves the mechanism rather than the intent:
      // with ptyd unreachable the foreground probe REJECTS, the sweep skips the
      // pane before touching its attempt record, and the give-up branch — the
      // only caller of `onRunnerDead` — is never reached. Sweeping well past the
      // cap changes nothing at all.
      const { db, handle, ptyd, tabId, doneReason } = await boot({ subChat: true });
      const rounds = new SpawnRoundStore(db);
      rounds.open(tabId, 1_000);

      await ptyd.client.close();
      await sweepToGiveUp(handle);
      // And again, twice over the cap, in case an attempt was being banked.
      await sweepToGiveUp(handle);

      expect(doneReason()).toBeUndefined();
      expect(rounds.openRound(tabId)).not.toBeNull();
    },
    SUPERVISION_TIMEOUT_MS,
  );

  it(
    'leaves a TOP-LEVEL chat live even when its runner really is dead',
    async () => {
      // A conversation you are having. Its agent dying is a thing to fix; filing
      // the conversation away is not the response to it.
      const { handle, doneReason } = await boot();
      await sweepToGiveUp(handle);
      expect(doneReason()).toBeUndefined();
    },
    SUPERVISION_TIMEOUT_MS,
  );
});
