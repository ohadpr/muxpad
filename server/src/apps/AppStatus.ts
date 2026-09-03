import type { App, AppState, AppWithStatus, UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { PaneStore } from '../store/PaneStore.js';
import { probeUrlHealth } from '../url-health.js';

/**
 * Real status for a registered app — MEASURED, never inferred from the row.
 *
 * The registry row says what the app is SUPPOSED to be doing. That is not
 * status, and reporting it as status is how a dashboard ends up cheerfully
 * showing "running" next to a dead server. Two independent observations answer
 * the question instead:
 *
 *   1. PROCESS LIVENESS — does ptyd hold a pty for the app's pane? This is the
 *      same narrow, unambiguous signal serve-supervisor.ts respawns on, and it
 *      keeps the same nuance: a throw means PTYD IS UNREACHABLE (liveness
 *      unknown), not "the app is dead". Unknown surfaces as `pty: null` and is
 *      never allowed to manufacture a failure state.
 *
 *   2. REACHABILITY — does the URL actually answer? Through url-health.ts, the
 *      server-side probe, because it is the only probe that can tell "proxy up,
 *      backend dead" (502/503/504 → reason 'gateway') from healthy. The browser
 *      provably cannot: its no-cors probe sees an opaque response with status 0,
 *      so a `tailscale serve` 502 and a 200 are identical to it. Both of the
 *      real apps here sit behind exactly such a proxy.
 *
 * A STARTUP GRACE separates "not up YET" from "not up". Every server has a few
 * seconds between its pty existing and its port listening; calling that
 * `unreachable` would make the Hosted view flash a failure on every legitimate
 * start, and users quickly learn to ignore a light that lies.
 */

/** How long after its pane was created an app may fail the URL probe and still
 *  be called `starting` rather than `unreachable`. */
export const APP_STARTUP_GRACE_MS = 20_000;

/** Probe results are shared for this long. Several devices polling the Hosted
 *  view must not multiply into N probes per second against the app. */
export const APP_STATUS_TTL_MS = 3_000;

export interface AppStatusPtyd {
  hasPane(id: string): Promise<boolean>;
}

export interface AppStatusDeps {
  db: Database.Database;
  ptyd: AppStatusPtyd;
  /** Has the serve supervisor written this pane off? Optional — without it no
   *  app can ever report `gave_up`, which is honest for a test harness that
   *  has no supervisor. */
  gaveUp?: (paneId: string) => boolean;
  now?: () => number;
  /** Injectable for tests; defaults to the real server-side probe. */
  probe?: (url: string) => Promise<UrlHealth>;
  ttlMs?: number;
}

interface Cached {
  at: number;
  pty: boolean | null;
  health: UrlHealth | null;
}

/**
 * Fold the two observations plus the row into ONE state.
 *
 * Order matters and is stated once, here, so no surface re-derives it:
 *   stopped     the user's decision outranks every observation. A stopped app
 *               is not "unreachable" — nothing is supposed to answer.
 *   gave_up     the supervisor has stopped trying. Outranks liveness because
 *               "no pty" is the very condition it gave up on; reporting that as
 *               `starting` would promise a restart that is not coming.
 *   starting    no pty (the supervisor is on it), or not probed yet, or inside
 *               the startup grace.
 *   running     something answered.
 *   unreachable everything else — with `health.reason` carrying which flavour.
 */
export function deriveAppState(input: {
  enabled: boolean;
  gaveUp: boolean;
  /** null = ptyd unreachable, so liveness is UNKNOWN — never treated as dead. */
  pty: boolean | null;
  health: UrlHealth | null;
  withinStartupGrace: boolean;
}): AppState {
  if (!input.enabled) return 'stopped';
  if (input.gaveUp) return 'gave_up';
  if (input.pty === false) return 'starting';
  if (input.health?.alive) return 'running';
  if (!input.health) return 'starting';
  if (input.withinStartupGrace) return 'starting';
  return 'unreachable';
}

export interface AppStatusProbe {
  /** Status for one app. */
  status(app: App): Promise<AppWithStatus>;
  /** Status for many, probed in parallel. */
  statusMany(apps: App[]): Promise<AppWithStatus[]>;
  /** Drop a cached entry (after a start/stop, where a stale answer is worse
   *  than a slow one). */
  invalidate(appId: string): void;
}

export function createAppStatusProbe(deps: AppStatusDeps): AppStatusProbe {
  const panes = new PaneStore(deps.db);
  const now = deps.now ?? (() => Date.now());
  const probe = deps.probe ?? ((url: string) => probeUrlHealth(url));
  const ttl = deps.ttlMs ?? APP_STATUS_TTL_MS;
  const cache = new Map<string, Cached>();
  // Collapses concurrent requests for the same app onto ONE probe, so a burst
  // of polls (three devices, one refresh each) is a single round-trip.
  const inFlight = new Map<string, Promise<Cached>>();

  const observe = async (app: App): Promise<Cached> => {
    const hit = cache.get(app.id);
    const t = now();
    if (hit && t - hit.at < ttl) return hit;
    const pending = inFlight.get(app.id);
    if (pending) return pending;

    const run = (async (): Promise<Cached> => {
      let pty: boolean | null = null;
      if (app.pane_id) {
        try {
          pty = await deps.ptyd.hasPane(app.pane_id);
        } catch {
          // ptyd unreachable — UNKNOWN, not dead. Same rule as the supervisor.
          pty = null;
        }
      } else {
        // No pane at all is a definite "no process", not an unknown.
        pty = false;
      }
      // Probe even when there is no pty: a stale server from a previous boot,
      // or something else on that port, is exactly the surprise worth showing.
      const health = await probe(app.url).catch(() => null);
      const fresh: Cached = { at: now(), pty, health };
      cache.set(app.id, fresh);
      return fresh;
    })();
    inFlight.set(app.id, run);
    try {
      return await run;
    } finally {
      inFlight.delete(app.id);
    }
  };

  const status = async (app: App): Promise<AppWithStatus> => {
    const seen = await observe(app);
    const pane = app.pane_id ? panes.getById(app.pane_id) : null;
    const withinStartupGrace = pane ? now() - pane.created_at < APP_STARTUP_GRACE_MS : false;
    const gaveUp = app.pane_id ? (deps.gaveUp?.(app.pane_id) ?? false) : false;
    return {
      ...app,
      state: deriveAppState({
        enabled: app.enabled,
        gaveUp,
        pty: seen.pty,
        health: seen.health,
        withinStartupGrace,
      }),
      pty: seen.pty,
      health: seen.health,
    };
  };

  return {
    status,
    statusMany: (list) => Promise.all(list.map(status)),
    invalidate: (appId) => {
      cache.delete(appId);
    },
  };
}
