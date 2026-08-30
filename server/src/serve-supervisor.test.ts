// Supervision for `muxpad serve` panes. The contract under test: an app
// server whose pty vanished comes back on its own, a broken one converges to a
// visible give-up instead of crash-looping, and neither a ptyd outage nor a
// flapping pane can be mistaken for either.
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import {
  RESPAWN_COOLDOWN_MS,
  RESPAWN_MAX_ATTEMPTS,
  RESPAWN_PROBATION_MS,
  RESPAWN_STARTUP_GRACE_MS,
} from './respawn-policy.js';
import type { PaneRuntimeSpec } from './runtime/PaneRuntime.js';
import {
  type ServeSupervisorPtyd,
  createServeSupervisor,
  startServeSupervisor,
} from './serve-supervisor.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

const SERVE_CMD = 'muxpad serve --url http://127.0.0.1:4321 -- ./start';

/**
 * ptyd stand-in. `live` is the set of pane ids that currently have a pty;
 * `down` makes every RPC throw the way a disconnected socket does; and
 * `ensureFails` models a pane that can never come up (bad shell, bad cwd) —
 * the only shape that can actually crash-loop this supervisor.
 */
function fakePtyd() {
  const f = {
    live: new Set<string>(),
    ensured: [] as PaneRuntimeSpec[],
    down: false,
    ensureFails: false,
    ptyd: undefined as unknown as ServeSupervisorPtyd,
  };
  f.ptyd = {
    async hasPane(id) {
      if (f.down) throw new Error('ptyd disconnected');
      return f.live.has(id);
    },
    async ensurePane(spec) {
      if (f.down) throw new Error('ptyd disconnected');
      f.ensured.push(spec);
      if (f.ensureFails) throw new Error('spawn failed');
      f.live.add(spec.id);
    },
  };
  return f;
}

/** Backdate a pane past the startup grace so the sweep will judge it. */
function agePane(db: Database.Database, id: string, ms = RESPAWN_STARTUP_GRACE_MS * 10) {
  db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(Date.now() - ms, id);
}

describe('serve supervisor', () => {
  let clock = 0;
  beforeEach(() => {
    clock = Date.now();
  });
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  /** Past the cooldown, so the next dead sweep is allowed to act. */
  const pastCooldown = () => advance(RESPAWN_COOLDOWN_MS + 1);

  function setup(opts?: { notifyPane?: (id: string, body: string) => void }) {
    const db = openDb(':memory:');
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const ws = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: '', workspace_id: ws.id });
    const ptydFake = fakePtyd();
    const events = new EventBus();
    const emitted: unknown[] = [];
    events.subscribe((e) => emitted.push(e));
    const logs: string[] = [];
    // Construct WITH a cache: production always has one, so the emitted
    // pane.updated is DECORATED (status/agents/app_urls). The undecorated
    // branch is a fallback for cache-less callers, not the contract — a test
    // that omitted the cache quietly pinned the fallback as if it were.
    const cache = new PtydCache();
    const sup = createServeSupervisor({
      db,
      ptyd: ptydFake.ptyd,
      cache,
      events,
      now,
      log: (m) => logs.push(m),
      ...(opts?.notifyPane ? { notifyPane: opts.notifyPane } : {}),
    });
    const addServePane = (over?: { cwd?: string; startup_cmd?: string }) => {
      const pane = panes.create({
        tab_id: tab.id,
        shell: '/bin/zsh',
        cwd: over?.cwd ?? '/tmp',
        startup_cmd: over?.startup_cmd ?? SERVE_CMD,
      });
      agePane(db, pane.id);
      return pane;
    };
    return { db, panes, tabs, ws, tab, ptydFake, sup, emitted, logs, cache, addServePane };
  }

  it('respawns a serve pane whose pty is gone, with the full runtime spec', async () => {
    const f = setup();
    const pane = f.addServePane();
    // ptyd has no pty for it — the exact post-ptyd-restart state.
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(1);
    expect(f.ptydFake.ensured[0]).toMatchObject({
      id: pane.id,
      shell: '/bin/zsh',
      startup_cmd: SERVE_CMD,
      cwd: '/tmp',
      tab_id: f.tab.id,
      workspace_id: f.ws.id,
    });
    // And it is alive afterwards, so the next sweep does nothing.
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(1);
  });

  it('leaves a live serve pane completely alone', async () => {
    const f = setup();
    const pane = f.addServePane();
    f.ptydFake.live.add(pane.id);
    await f.sup.sweep();
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(0);
    expect(f.sup.states.size).toBe(0);
  });

  it('ignores agent panes, plain shell panes and url panes', async () => {
    const f = setup();
    const agent = f.panes.create({
      tab_id: f.tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent --resume abc',
    });
    const plain = f.panes.create({ tab_id: f.tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    // A url pane has shell = NULL; ensurePane on it would crash node-pty, so
    // it must never be picked up even if something wrote a startup_cmd.
    const urlPane = f.panes.create({
      tab_id: f.tab.id,
      kind: 'url',
      url: 'http://x',
      startup_cmd: SERVE_CMD,
    });
    for (const p of [agent, plain, urlPane]) agePane(f.db, p.id);
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(0);
  });

  it('does not judge a pane still inside its startup grace', async () => {
    const f = setup();
    const pane = f.panes.create({
      tab_id: f.tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: SERVE_CMD,
    });
    // Freshly created: the request that made it is still ensuring it.
    expect(Date.now() - pane.created_at).toBeLessThan(RESPAWN_STARTUP_GRACE_MS);
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(0);
  });

  it('honours the cooldown between attempts on the same pane', async () => {
    const f = setup();
    const pane = f.addServePane();
    f.ptydFake.ensureFails = true; // stays dead, so every sweep sees it dead
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(1);
    // Several sweeps inside the cooldown: no further attempts.
    advance(RESPAWN_COOLDOWN_MS - 1);
    await f.sup.sweep();
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(1);
    advance(2);
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(2);
    expect(f.sup.states.get(pane.id)?.attempts).toBe(2);
  });

  it('gives up after the attempt cap and says so exactly once', async () => {
    const notes: Array<[string, string]> = [];
    const f = setup({ notifyPane: (id, body) => notes.push([id, body]) });
    const pane = f.addServePane();
    f.ptydFake.ensureFails = true;
    for (let i = 0; i < RESPAWN_MAX_ATTEMPTS; i++) {
      await f.sup.sweep();
      pastCooldown();
    }
    expect(f.ptydFake.ensured).toHaveLength(RESPAWN_MAX_ATTEMPTS);
    expect(f.sup.states.get(pane.id)?.gaveUp).toBe(false);

    // The attempt past the cap gives up instead of spawning.
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(RESPAWN_MAX_ATTEMPTS);
    expect(f.sup.states.get(pane.id)?.gaveUp).toBe(true);

    // Visible: unread bold in the sidebar, a pane.updated so open browsers see
    // it live, and a push. Once — not once per sweep.
    expect(f.panes.getById(pane.id)?.unread).toBe(true);
    const updates = f.emitted.filter((e) => (e as { type: string }).type === 'pane.updated');
    expect(updates).toHaveLength(1);
    // Decorated, like every other pane.updated: a partial payload blanks the
    // client's status rail (see decoratePane).
    expect((updates[0] as { pane: Record<string, unknown> }).pane).toMatchObject({
      id: pane.id,
      unread: true,
      status: expect.any(String),
      agents: expect.any(Number),
      app_urls: expect.any(Array),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[0]).toBe(pane.id);
    expect(notes[0]?.[1]).toMatch(/could not be restarted/);

    for (let i = 0; i < 5; i++) {
      pastCooldown();
      await f.sup.sweep();
    }
    expect(f.ptydFake.ensured).toHaveLength(RESPAWN_MAX_ATTEMPTS);
    expect(notes).toHaveLength(1);
  });

  it('stop() detaches the reconnect listener and neuters a stale one', async () => {
    // `stop()` used to clear only the interval, leaving `ptyd.on('connected')`
    // wired for ptyd's whole lifetime: start/stop cycles accumulated live
    // supervisors, and a reconnect landing during shutdown respawned serve
    // panes right after shutdown said to stop doing that.
    const f = setup();
    f.addServePane();
    const listeners: Array<() => void> = [];
    const handle = startServeSupervisor({
      db: f.db,
      ptyd: f.ptydFake.ptyd,
      cache: f.cache,
      now,
      log: () => {},
      sweepMs: 1_000_000, // never on its own; we fire the reconnect hook by hand
      onPtydConnected: (fn) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    });
    expect(listeners).toHaveLength(1);
    // Armed: a reconnect sweeps, and the dead pane comes back.
    const staleHandler = listeners[0] as () => void;
    staleHandler();
    await handle.sweep(); // drains the in-flight pass (single-flight)
    expect(f.ptydFake.ensured.length).toBeGreaterThan(0);

    handle.stop();
    // Detached from the emitter…
    expect(listeners).toHaveLength(0);
    // …AND inert if something already held a reference to it (a 'connected'
    // emit that was in flight when stop() ran).
    f.ptydFake.live.clear();
    pastCooldown();
    const before = f.ptydFake.ensured.length;
    staleHandler();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.ptydFake.ensured).toHaveLength(before);
  });

  it('forgives a pane only after it stays up through probation', async () => {
    const f = setup();
    const pane = f.addServePane();
    await f.sup.sweep(); // attempt 1 → now live
    await f.sup.sweep(); // first observation of "alive" starts the clock
    expect(f.sup.states.get(pane.id)?.attempts).toBe(1);

    // Alive, but not yet long enough: the record survives.
    advance(RESPAWN_PROBATION_MS - 1);
    await f.sup.sweep();
    expect(f.sup.states.get(pane.id)?.attempts).toBe(1);

    advance(2);
    await f.sup.sweep();
    expect(f.sup.states.has(pane.id)).toBe(false);
  });

  it('does not let a flapping pane refresh its budget', async () => {
    const f = setup();
    const pane = f.addServePane();
    // Up briefly then down again, over and over — never a continuous run long
    // enough to be forgiven, so the cap still bites.
    for (let i = 0; i < RESPAWN_MAX_ATTEMPTS; i++) {
      await f.sup.sweep(); // dead → respawn (pane becomes live)
      advance(RESPAWN_PROBATION_MS / 3);
      await f.sup.sweep(); // alive, but short of probation
      f.ptydFake.live.delete(pane.id); // dies again
      pastCooldown();
    }
    expect(f.sup.states.get(pane.id)?.attempts).toBe(RESPAWN_MAX_ATTEMPTS);
    await f.sup.sweep();
    expect(f.sup.states.get(pane.id)?.gaveUp).toBe(true);
    expect(f.ptydFake.ensured).toHaveLength(RESPAWN_MAX_ATTEMPTS);
  });

  it('burns no attempts while ptyd is unreachable, and recovers when it returns', async () => {
    const f = setup();
    const pane = f.addServePane();
    f.ptydFake.down = true;
    for (let i = 0; i < 10; i++) {
      pastCooldown();
      await f.sup.sweep();
    }
    expect(f.ptydFake.ensured).toHaveLength(0);
    expect(f.sup.states.get(pane.id)?.attempts ?? 0).toBe(0);
    expect(f.sup.states.get(pane.id)?.gaveUp ?? false).toBe(false);

    // ptyd comes back with no pty for the pane — now it's genuinely dead.
    f.ptydFake.down = false;
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(1);
  });

  it('resumes supervising a given-up pane that comes back by hand', async () => {
    const f = setup();
    const pane = f.addServePane();
    f.ptydFake.ensureFails = true;
    for (let i = 0; i <= RESPAWN_MAX_ATTEMPTS; i++) {
      await f.sup.sweep();
      pastCooldown();
    }
    expect(f.sup.states.get(pane.id)?.gaveUp).toBe(true);

    // The user fixes ./start and respawns the pane themselves.
    f.ptydFake.ensureFails = false;
    f.ptydFake.live.add(pane.id);
    await f.sup.sweep();
    advance(RESPAWN_PROBATION_MS + 1);
    await f.sup.sweep();
    expect(f.sup.states.has(pane.id)).toBe(false);

    // Full fresh budget: it dies again and gets restarted, not written off.
    f.ptydFake.live.delete(pane.id);
    pastCooldown();
    const before = f.ptydFake.ensured.length;
    await f.sup.sweep();
    expect(f.ptydFake.ensured).toHaveLength(before + 1);
  });

  it('forgets panes that are deleted or stop being serve panes', async () => {
    const f = setup();
    const pane = f.addServePane();
    await f.sup.sweep();
    expect(f.sup.states.size).toBe(1);
    f.panes.delete(pane.id);
    await f.sup.sweep();
    expect(f.sup.states.size).toBe(0);
  });

  it('is single-flight: overlapping sweeps do not double-spawn', async () => {
    const f = setup();
    f.addServePane();
    await Promise.all([f.sup.sweep(), f.sup.sweep()]);
    expect(f.ptydFake.ensured).toHaveLength(1);
  });

  it('respawns into home when the recorded cwd no longer exists', async () => {
    const f = setup();
    f.addServePane({ cwd: '/tmp/definitely-not-a-real-dir-9f3a2b' });
    await f.sup.sweep();
    expect(f.ptydFake.ensured[0]?.cwd).not.toBe('/tmp/definitely-not-a-real-dir-9f3a2b');
  });

  it('re-reads the startup command at respawn time', async () => {
    const f = setup();
    const pane = f.addServePane();
    f.panes.setStartupCmd(pane.id, 'muxpad serve --url http://127.0.0.1:9999 -- ./start2');
    await f.sup.sweep();
    expect(f.ptydFake.ensured[0]?.startup_cmd).toContain('./start2');
  });
});
