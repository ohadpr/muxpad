import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { type PtydCache, decoratePane } from './ptyd-cache.js';
import type { PaneNotifier } from './push.js';
import {
  RESPAWN_COOLDOWN_MS,
  RESPAWN_MAX_ATTEMPTS,
  RESPAWN_PROBATION_MS,
  RESPAWN_STARTUP_GRACE_MS,
  RESPAWN_SWEEP_MS,
} from './respawn-policy.js';
import type { PaneRuntimeSpec } from './runtime/PaneRuntime.js';
import { safeCwd } from './safe-cwd.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

/**
 * Supervision for `muxpad serve` panes — the local app servers muxpad runs
 * inside a pane and shows through its web face.
 *
 * WHY THIS EXISTS
 * ---------------
 * ws.ts sweeps agent panes (`startup_cmd LIKE 'muxpad agent%'`) and respawns
 * them when their runner dies. Nothing swept `muxpad serve` panes, and their
 * pty is created LAZILY — ptyd only holds a runtime while something attaches
 * to the pane's terminal face. A user watching the app through the web face
 * never attaches, so after a ptyd restart the pane's shell was simply never
 * recreated, `./start` never ran, and the app stayed down until someone
 * noticed a blank iframe and hit POST /api/panes/:id/respawn by hand. That
 * really happened, to two panes, silently.
 *
 * THE LIVENESS SIGNAL IS DELIBERATELY NARROW
 * ------------------------------------------
 * Dead means "ptyd has no pty for this pane" — `hasPane === false`. That is
 * exactly the failure above, and it is unambiguous.
 *
 * We deliberately do NOT use the agent sweep's foreground probe here:
 *   - `muxpad serve` is a shell loop that already restarts its own child with
 *     backoff, so a crashing `./start` is not our problem to solve — the pty
 *     stays alive and the CLI handles it. Respawning on top of that would
 *     fight it and lose information (the pane's scrollback of failures).
 *   - the loop's foreground is the CHILD (`node`, `./start`, `sleep` during
 *     backoff), never a stable string we could match on;
 *   - "the foreground is the shell" means the loop exited — and the single
 *     most common way for it to exit is the user pressing Ctrl-C, which
 *     `muxpad serve` documents as "stops for real". Auto-restarting there
 *     would override an explicit user decision. Not worth the blast radius.
 *
 * Concretely: after a ptyd restart the app comes back on its own; a broken
 * `./start` keeps looping visibly inside its own pane exactly as before; and
 * a Ctrl-C'd server stays stopped.
 *
 * RAILS
 * -----
 * Identical to the agent sweep's, from the shared respawn-policy module:
 * startup grace, cooldown, attempt cap, probation. Two deliberate
 * refinements, both safe-side:
 *
 *   1. `hasPane` throwing means PTYD IS UNREACHABLE, not "pane is dead" — the
 *      RPC returns `false` for an unknown pane and only throws when the socket
 *      is down. So a throw burns no attempt. (The agent sweep now makes the
 *      same distinction with `getForegroundCommand`, which likewise resolves
 *      `null` for an unknown pane and only rejects on a downed socket.)
 *      Without this, a 2-minute ptyd outage would exhaust every serve pane's
 *      budget and leave them all given-up right when ptyd came back.
 *   2. Liveness is evaluated BEFORE the give-up short-circuit, so a pane that
 *      was written off but is alive again (user respawned it by hand, or
 *      opened its terminal face) serves its probation and gets a full fresh
 *      budget. Giving up is a pause, not a tombstone.
 */

/** The slice of PtydClient this supervisor needs. Structural so tests can fake it. */
export interface ServeSupervisorPtyd {
  hasPane(id: string): Promise<boolean>;
  ensurePane(spec: PaneRuntimeSpec): Promise<void>;
}

interface ServeState {
  /** Respawns issued since the last forgiven run. */
  attempts: number;
  /** When the last respawn was issued (cooldown anchor). */
  lastAt: number;
  /** Budget exhausted — paused until the pane is seen alive through probation. */
  gaveUp: boolean;
  /**
   * First sweep in the current continuous run of "seen alive". Undefined when
   * the pane is dead or its liveness is unknown. Probation is measured from
   * here, so a pane that flaps (up on one sweep, down on the next) never
   * refreshes its budget — same lesson the agent sweep learned about hello.
   */
  aliveSince?: number | undefined;
}

export interface ServeSupervisorDeps {
  db: Database.Database;
  ptyd: ServeSupervisorPtyd;
  /** Optional: decorates the pane in the `pane.updated` emitted on give-up. */
  cache?: PtydCache;
  events?: EventBus;
  /** Optional push channel; a given-up app server is worth a buzz. */
  notifyPane?: PaneNotifier;
  /** Fallback when a pane row has no shell recorded. */
  defaultShell?: string;
  /** Injectable clock so tests can drive cooldown/probation without waiting. */
  now?: () => number;
  /** Injectable log sink; defaults to console. */
  log?: (msg: string) => void;
}

export interface ServeSupervisor {
  /** Run one pass. Single-flight: a call while one is in flight is a no-op. */
  sweep(): Promise<void>;
  /** Test/introspection hook: the live ledger, keyed by pane id. */
  readonly states: ReadonlyMap<string, Readonly<ServeState>>;
}

function serveGaveUpMessage(paneName: string | null | undefined): string {
  return `${paneName ?? 'app server'} could not be restarted after ${RESPAWN_MAX_ATTEMPTS} attempts — open the pane's terminal face and run its command by hand`;
}

export function createServeSupervisor(deps: ServeSupervisorDeps): ServeSupervisor {
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(m));
  const defaultShell = deps.defaultShell ?? process.env.SHELL ?? '/bin/zsh';
  const states = new Map<string, ServeState>();
  let inFlight = false;

  // A given-up app server has no chat socket to complain into (serve panes are
  // terminal/web, never chat), so "visible" means the surfaces a non-chat pane
  // actually has: the sidebar's unread bold, a pushed notification, and the
  // server log. Announced ONCE, at the moment we stop trying.
  const announceGaveUp = (paneId: string) => {
    const pane = panes.getById(paneId);
    if (!pane) return;
    const msg = serveGaveUpMessage(pane.name);
    log(`[serve] ${paneId} gave up: ${msg}`);
    try {
      panes.setUnread(paneId, true);
      const fresh = panes.getById(paneId);
      if (fresh && deps.events) {
        deps.events.emit({
          type: 'pane.updated',
          tab_id: fresh.tab_id,
          pane: deps.cache ? decoratePane(deps.cache, fresh) : fresh,
        });
      }
    } catch {
      // Surfacing the failure must never itself throw the sweep off course.
    }
    deps.notifyPane?.(paneId, msg);
  };

  const respawn = async (paneId: string): Promise<void> => {
    // Re-read: the sweep may be several awaits old by now, and the user could
    // have edited the command or moved the pane in between.
    const pane = panes.getById(paneId);
    if (!pane || pane.kind !== 'shell') return;
    const workspaceId = tabs.getWorkspaceId(pane.tab_id);
    await deps.ptyd.ensurePane({
      id: pane.id,
      shell: pane.shell ?? defaultShell,
      startup_cmd: pane.startup_cmd,
      cwd: safeCwd(pane.cwd),
      env: pane.env,
      tab_id: pane.tab_id,
      ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    });
  };

  const sweep = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const servePanes = panes.listServePanes();
      // Forget panes that are gone or no longer serve-owned, so a deleted pane
      // can't keep a stale give-up alive for an id that gets reused in spirit
      // (same app, new pane).
      const liveIds = new Set(servePanes.map((p) => p.id));
      for (const id of [...states.keys()]) if (!liveIds.has(id)) states.delete(id);

      for (const pane of servePanes) {
        const t = now();
        // A pane created moments ago may not have been ensured yet — the
        // creating request does that, and it races us. Judging it dead here
        // would double-spawn a healthy boot.
        if (t - pane.created_at < RESPAWN_STARTUP_GRACE_MS) continue;

        const st = states.get(pane.id) ?? { attempts: 0, lastAt: 0, gaveUp: false };

        let alive: boolean;
        try {
          alive = await deps.ptyd.hasPane(pane.id);
        } catch {
          // ptyd unreachable — liveness is UNKNOWN, not dead. Burn nothing and
          // break the alive-run (we can't claim continuous uptime we can't see).
          st.aliveSince = undefined;
          states.set(pane.id, st);
          continue;
        }

        if (alive) {
          // Probation: forgiveness requires STAYING up, not merely appearing.
          if (st.attempts === 0 && !st.gaveUp) {
            states.delete(pane.id); // nothing to remember about a healthy pane
            continue;
          }
          if (st.aliveSince === undefined) st.aliveSince = t;
          if (t - st.aliveSince >= RESPAWN_PROBATION_MS) states.delete(pane.id);
          else states.set(pane.id, st);
          continue;
        }

        // Dead from here down.
        st.aliveSince = undefined;
        if (st.gaveUp) {
          states.set(pane.id, st);
          continue;
        }
        if (t - st.lastAt < RESPAWN_COOLDOWN_MS) {
          states.set(pane.id, st);
          continue;
        }
        st.lastAt = t;
        st.attempts += 1;
        states.set(pane.id, st);
        if (st.attempts > RESPAWN_MAX_ATTEMPTS) {
          st.gaveUp = true;
          announceGaveUp(pane.id);
          continue;
        }
        log(
          `[serve] ${pane.id} has no pty — restarting (attempt ${st.attempts}/${RESPAWN_MAX_ATTEMPTS})`,
        );
        try {
          await respawn(pane.id);
        } catch {
          // ptyd unreachable mid-respawn: the attempt is spent, the next sweep
          // retries after the cooldown. Same shape as the agent sweep.
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return { sweep, states };
}

export interface ServeSupervisorHandle {
  stop(): void;
  sweep(): Promise<void>;
}

/**
 * Wire the supervisor into a running server: a slow steady interval plus a
 * sweep on every ptyd (re)connect. The reconnect hook is the one that matters
 * — a ptyd restart is exactly when every serve pane loses its pty, and it
 * brings the apps back in a beat instead of up to a sweep interval later.
 */
export function startServeSupervisor(
  deps: ServeSupervisorDeps & {
    /**
     * Ptyd's reconnect signal; optional so unit tests can omit it. Return a
     * detach function so `stop()` can actually let go — otherwise the listener
     * outlives the supervisor for ptyd's whole lifetime and keeps sweeping
     * (start/stop cycles accumulate supervisors, and a reconnect landing
     * during shutdown respawns serve panes we just said to stop respawning).
     */
    onPtydConnected?: (fn: () => void) => (() => void) | undefined;
    sweepMs?: number;
  },
): ServeSupervisorHandle {
  const sup = createServeSupervisor(deps);
  let stopped = false;
  const timer = setInterval(() => void sup.sweep(), deps.sweepMs ?? RESPAWN_SWEEP_MS);
  timer.unref?.();
  // Guarded even with the detach below: a 'connected' emit already in flight
  // when stop() runs would otherwise still reach us.
  const onConnected = () => {
    if (stopped) return;
    void sup.sweep();
  };
  const detach = deps.onPtydConnected?.(onConnected);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      detach?.();
    },
    sweep: sup.sweep,
  };
}
