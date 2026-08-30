import type { App } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import { queuePaneKill } from '../pane-reaper.js';
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import { safeCwd } from '../safe-cwd.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';

/**
 * The app registry's RUNTIME half: turning rows into running processes.
 *
 * THE ONE DESIGN DECISION
 * -----------------------
 * An app is a `muxpad serve` PANE that has no presence in the tab tree. It
 * lives in a hidden workspace (`workspaces.hidden`, migration 19 — the same
 * mechanism the retired resident pane used, and the reason `visibleWorkspaces()`
 * already filters it out of the sidebar).
 *
 * This is not a convenience. Apps must survive a MAIN-SERVER restart, and the
 * only thing in muxpad that does is ptyd. A second process supervisor living in
 * the main server would die with it and take every app down on each deploy —
 * precisely the split ptyd exists to prevent. So: no new supervisor. An app
 * borrows every mechanism a pane already has —
 *
 *   · ptyd owns the process and outlives us;
 *   · `muxpad serve` gives it crash-loop backoff inside the pane;
 *   · serve-supervisor.ts already sweeps `muxpad serve%` panes and rebuilds any
 *     that lost their pty (a ptyd restart), with cooldown/attempt-cap/probation
 *     rails that treat "ptyd unreachable" as unknown rather than dead;
 *   · `/p/:paneId` already renders a pane's terminal, so an app's LOGS are a
 *     surface that already exists.
 *
 * What is genuinely new is small and lives here: a hidden container, a row that
 * remembers the app across the pane's lifetime, and reconciliation between the
 * two.
 *
 * THE INVARIANT
 * -------------
 *     a materialised pane exists  ⟺  the app row is enabled
 *
 * Stop tears the pane down; start builds a fresh one. That direction is what
 * keeps ptyd from accumulating orphan ptys for apps nobody is running, and the
 * reverse direction — a pane whose registry row is gone — is closed by
 * {@link remove} tearing the pane down before deleting the row, plus the
 * reconciler's disabled-app sweep as a crash-safety net.
 *
 * WHY NO EVENTS ARE EMITTED FOR THE CONTAINER
 * -------------------------------------------
 * Creating an app deliberately emits NO `tab.added` / `pane.added`. Those
 * events carry a workspace_id, and a client that received one for the hidden
 * container would be told about a workspace its navigator does not (and must
 * not) track. The Hosted view polls instead. Silence here is the strongest
 * guarantee that the container cannot leak into the sidebar.
 */

/** globals-KV pointer at the hidden container. */
export const APPS_WORKSPACE_KEY = 'apps_workspace_id';

/** Name of the hidden container. Never shown — it has no visible surface. */
export const APPS_WORKSPACE_NAME = '· apps ·';

/**
 * Floor between two materialisations of the SAME app. Nothing should ever hit
 * this — materialise sets `pane_id` synchronously, so the next reconcile sees a
 * pane and skips — but a reconcile is wired to ptyd's 'connected' event, and a
 * flapping socket is exactly the shape that turns "should never" into a tab
 * every 200ms. Cheap insurance against a storm we would otherwise only find in
 * production.
 */
export const MATERIALIZE_COOLDOWN_MS = 10_000;

/** The slice of PtydClient the registry needs. Structural, so tests can fake it. */
export interface AppRegistryPtyd {
  ensurePane(spec: PaneRuntimeSpec): Promise<void>;
  killPane(id: string): Promise<void>;
}

export interface AppRegistryDeps {
  db: Database.Database;
  ptyd: AppRegistryPtyd;
  events?: EventBus;
  /** Fallback when no shell is recorded. */
  defaultShell?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * The pane startup command for an app.
 *
 * `muxpad serve` — not the bare command — because that wrapper is what gives
 * the app its in-pane crash-loop backoff, its OSC url declaration, and (via the
 * `muxpad serve%` prefix) its place in the existing supervisor's sweep. The
 * prefix is load-bearing: change it and serve-supervisor.ts silently stops
 * supervising every app.
 *
 * Quoting: url and label are single-quoted (both are validated to contain no
 * quote character upstream); `command` is pasted verbatim because it IS a shell
 * command line — that is the feature, not an oversight. An app's command runs
 * with the user's own privileges in the user's own pane, exactly as if they had
 * typed it, so there is no privilege boundary here to breach.
 */
export function appStartupCmd(app: Pick<App, 'url' | 'name' | 'command'>): string {
  const label = app.name.replace(/['\n\r;]/g, '').slice(0, 64);
  return `muxpad serve --url '${app.url}' --label '${label}' -- ${app.command}`;
}

export interface AppRegistry {
  /** Ensure the hidden container exists; returns its workspace id. */
  containerId(): string;
  /** Build the app's pane (tab + pane + pty). No-op if it already has one. */
  materialize(appId: string): Promise<App | null>;
  /** enabled = 1, then materialise. */
  start(appId: string): Promise<App | null>;
  /** enabled = 0, then tear the pane down. */
  stop(appId: string): Promise<App | null>;
  /** Tear the pane down, then delete the row. */
  remove(appId: string): Promise<boolean>;
  /**
   * Make the world match the registry. Called at boot and on every ptyd
   * (re)connect. Single-flight.
   */
  reconcile(opts?: { boot?: boolean }): Promise<void>;
}

export function createAppRegistry(deps: AppRegistryDeps): AppRegistry {
  const apps = new AppStore(deps.db);
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  const workspaces = new WorkspaceStore(deps.db);
  const globals = new GlobalsStore(deps.db);
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(m));
  const defaultShell = deps.defaultShell ?? process.env.SHELL ?? '/bin/zsh';
  const lastMaterializeAt = new Map<string, number>();
  let reconciling = false;

  const containerId = (): string => {
    const saved = globals.get(APPS_WORKSPACE_KEY);
    // Validate the pointer rather than trusting it: a workspace deleted by
    // hand would otherwise have every app materialise into a dangling
    // workspace_id, and the tabs would be unreachable AND undeletable.
    if (saved && workspaces.getById(saved)) return saved;
    const ws = workspaces.createHidden({ name: APPS_WORKSPACE_NAME });
    globals.set(APPS_WORKSPACE_KEY, ws.id);
    return ws.id;
  };

  const materialize = async (appId: string): Promise<App | null> => {
    const app = apps.getById(appId);
    if (!app) return null;
    // Already materialised — and the row is real, not a stale pointer.
    if (app.pane_id && panes.getById(app.pane_id)) return app;
    const t = now();
    const last = lastMaterializeAt.get(app.id) ?? 0;
    if (t - last < MATERIALIZE_COOLDOWN_MS) return app;
    lastMaterializeAt.set(app.id, t);

    const workspaceId = containerId();
    const startupCmd = appStartupCmd(app);
    const cwd = safeCwd(app.cwd);
    // One transaction: a mid-create failure must not leave a tab with no pane
    // (invisible, in a hidden workspace, with nothing that would ever clean it
    // up) or a pane the registry has no pointer to.
    const created = deps.db.transaction(() => {
      const tab = tabs.create({ name: app.name, layout: '', workspace_id: workspaceId });
      const pane = panes.create({
        tab_id: tab.id,
        shell: defaultShell,
        cwd,
        startup_cmd: startupCmd,
        // Pre-set the web face so the pane is coherent before `muxpad serve`
        // announces its OSC marker. index.ts's paneUrlsSeen handler then sees
        // face_url already equal to the marker and leaves it alone.
        face: 'web',
      });
      panes.setFace(pane.id, 'web', app.url);
      tabs.update(tab.id, { layout: pane.id });
      apps.setPane(app.id, pane.id);
      return { tabId: tab.id, paneId: pane.id };
    })();

    try {
      await deps.ptyd.ensurePane({
        id: created.paneId,
        shell: defaultShell,
        startup_cmd: startupCmd,
        cwd,
        env: null,
        tab_id: created.tabId,
        workspace_id: workspaceId,
      });
    } catch {
      // ptyd unreachable. The rows are committed and `pane_id` is set, so the
      // serve supervisor's sweep (and its reconnect hook) brings the pty up
      // shortly — with the cooldown rails. Nothing to undo.
      log(`[apps] ${app.slug}: ptyd unreachable while starting — supervisor will retry`);
    }
    return apps.getById(app.id);
  };

  /**
   * Delete the app's tab + pane and clear the pointer. Best-effort on the ptyd
   * side: a kill lost in transit is queued for the reaper rather than aborting
   * the teardown, or we would leave a pty running with no row and no surface
   * that could ever reach it.
   */
  const teardown = async (app: App): Promise<void> => {
    if (!app.pane_id) return;
    const pane = panes.getById(app.pane_id);
    apps.setPane(app.id, null);
    lastMaterializeAt.delete(app.id);
    if (!pane) return;
    try {
      await deps.ptyd.killPane(pane.id);
    } catch {
      queuePaneKill(deps.db, pane.id);
    }
    // Delete the whole tab: an app's tab holds exactly one pane, and leaving an
    // empty tab behind in the hidden container is litter nothing would collect.
    // Guarded anyway — if something else moved a pane in, keep the tab.
    const siblings = panes.listByTab(pane.tab_id).filter((p) => p.id !== pane.id);
    panes.delete(pane.id);
    if (siblings.length === 0) tabs.delete(pane.tab_id);
  };

  const start = async (appId: string): Promise<App | null> => {
    const app = apps.getById(appId);
    if (!app) return null;
    // enabled FIRST: while it reads 0 the serve supervisor skips this pane, and
    // a sweep landing between the flag and the materialise would otherwise be
    // told to leave alone the pty we are about to create.
    if (!app.enabled) apps.update(app.id, { enabled: true });
    return materialize(app.id);
  };

  const stop = async (appId: string): Promise<App | null> => {
    const app = apps.getById(appId);
    if (!app) return null;
    // enabled = 0 BEFORE the teardown, so a serve-supervisor sweep racing this
    // call sees a disabled app and declines to respawn the pty we are killing.
    // The reverse order is a live restart-loop.
    apps.update(app.id, { enabled: false });
    await teardown(app);
    return apps.getById(app.id);
  };

  const remove = async (appId: string): Promise<boolean> => {
    const app = apps.getById(appId);
    if (!app) return false;
    // Disable first for the same race as stop(), then tear down, then delete.
    // Deleting the row first would strand the pane: `disabledPaneIds()` would
    // no longer name it, so the supervisor would adopt it as an ordinary serve
    // pane and keep it alive forever with nothing pointing at it.
    apps.update(app.id, { enabled: false });
    await teardown(app);
    apps.delete(app.id);
    lastMaterializeAt.delete(app.id);
    return true;
  };

  /**
   * Make the world match the registry.
   *
   * `enabled` is the whole rule: an enabled app must have a live pane, a
   * disabled one must not. `autostart` is consulted at BOOT only, and it acts
   * by TRANSLATION rather than by exception — an enabled app with
   * `autostart = 0` is stopped at boot (enabled → 0) instead of being left
   * enabled-but-paneless. That keeps the invariant total: there is no state in
   * which the registry says "running" and no pane exists, so the Hosted view
   * never has to render a fourth kind of nothing. The user sees an honest
   * "stopped" with a Start button, which is exactly what they asked for by
   * turning autostart off.
   */
  const reconcile = async (opts?: { boot?: boolean }): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const app of apps.list()) {
        if (opts?.boot && app.enabled && !app.autostart) {
          log(`[apps] ${app.slug}: autostart off — leaving it stopped`);
          apps.update(app.id, { enabled: false });
          await teardown(app);
          continue;
        }
        if (!app.enabled) {
          // Crash-safety: a process that died between `enabled = 0` and the
          // teardown would otherwise leave a pane running for a stopped app.
          if (app.pane_id) await teardown(app);
          continue;
        }
        const pane = app.pane_id ? panes.getById(app.pane_id) : null;
        // Has a live row — the serve supervisor owns its pty from here.
        if (pane) continue;
        if (app.pane_id) {
          apps.setPane(app.id, null);
          log(`[apps] ${app.slug}: pane row is gone — rebuilding`);
        }
        await materialize(app.id);
      }
    } finally {
      reconciling = false;
    }
  };

  return { containerId, materialize, start, stop, remove, reconcile };
}

/**
 * How often the reconciler re-checks the registry against reality. Slow on
 * purpose: reconcile is cheap but it is a REPAIR pass, not a supervisor — the
 * per-pty work belongs to serve-supervisor.ts, which has its own rails.
 */
export const APP_RECONCILE_MS = 30_000;

export interface AppReconcilerHandle {
  stop(): void;
  reconcile(): Promise<void>;
}

/**
 * Wire the reconciler into a running server: a boot pass, a slow interval, and
 * a pass on every ptyd (re)connect.
 *
 * THE INTERVAL IS NOT BELT-AND-BRACES. An app's pane can be destroyed by paths
 * that know nothing about the registry — `DELETE /api/panes/:id`, a tab delete
 * cascade, a hand-run SQL fix. `pane_id` then points at nothing, and until this
 * runs the app is down while reporting `starting` forever. Reconciling only on
 * ptyd's reconnect would mean waiting for the next daemon restart, which on a
 * healthy machine is days.
 *
 * The reconnect pass still matters and is not redundant: it repairs in a beat
 * rather than up to 30 seconds, at exactly the moment things are most likely to
 * be broken.
 */
export function startAppReconciler(
  deps: AppRegistryDeps & {
    registry?: AppRegistry;
    /** Ptyd's reconnect signal. Returns a detach fn so stop() can let go —
     *  otherwise start/stop cycles accumulate listeners that outlive us and a
     *  reconnect landing during shutdown materialises panes for the next boot
     *  to adopt. Same lesson as startServeSupervisor. */
    onPtydConnected?: (fn: () => void) => (() => void) | undefined;
    intervalMs?: number;
  },
): AppReconcilerHandle {
  const registry = deps.registry ?? createAppRegistry(deps);
  let stopped = false;
  // The BOOT pass is the one that honours autostart=0; every later pass is a
  // plain repair, so it must not re-apply that translation.
  void registry.reconcile({ boot: true });
  const timer = setInterval(() => {
    if (!stopped) void registry.reconcile();
  }, deps.intervalMs ?? APP_RECONCILE_MS);
  timer.unref?.();
  const onConnected = () => {
    if (stopped) return;
    void registry.reconcile();
  };
  const detach = deps.onPtydConnected?.(onConnected);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      detach?.();
    },
    reconcile: () => registry.reconcile(),
  };
}
