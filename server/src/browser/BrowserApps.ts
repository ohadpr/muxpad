import type Database from 'better-sqlite3';
import { AppStore } from '../store/AppStore.js';
import {
  BROWSER_VIEWER_PORT_OFFSET,
  browserAppName,
  browserAppSlug,
  browserAppUrl,
  browserJarPath,
  browserViewerPort,
  isBrowserAppSlug,
  normalizeProfileName,
  parseBrowserPort,
  pickBrowserPort,
  profileFromAppSlug,
} from './BrowserProfile.js';

/**
 * Registering a browser owner as a muxpad APP.
 *
 * WHY AN APP AND NOT A SUPERVISOR
 * -------------------------------
 * The same reason the tunnel is one, and it is the decisive constraint rather
 * than a stylistic preference: a process supervised by the main server DIES ON
 * EVERY DEPLOY. A browser that restarts on every deploy loses its page, its
 * scroll position, and whatever half-finished flow an agent was in — and, worse,
 * would do it silently in the middle of a handoff somebody is waiting on.
 *
 * An app is a `muxpad serve` pane in a hidden workspace, which means ptyd owns
 * the process and it outlives the main server. It also means the browser gets,
 * for free and already debugged: crash-loop backoff, rebuild-after-ptyd-restart,
 * measured status, `muxpad app logs browser-<profile>` for Chrome's own stderr,
 * and `muxpad app stop browser-<profile>` as the way to close it.
 *
 * THE INVARIANT, INHERITED FROM BrowserProfile: one profile, one slug, one row,
 * one owner. `ensureBrowserApp` is idempotent on the slug, so asking twice for
 * the same profile can never produce two processes fighting over one directory —
 * which is the entire bug this whole subsystem exists to undo.
 */

export interface EnsureBrowserAppDeps {
  db: Database.Database;
  /** Where profile directories live. */
  dataDir: string;
  /** Absolute path to the Chrome binary. */
  chromePath: string;
  /** Absolute path to the built host entry point. */
  hostEntry: string;
  registry: { start(appId: string): Promise<unknown>; stop(appId: string): Promise<unknown> };
  /** cwd for the app pane. */
  cwd: string;
  /** Start it now. False registers the row without opening a browser. */
  start?: boolean;
  log?: (line: string) => void;
}

export interface BrowserAppState {
  slug: string;
  profile: string;
  /** Where a person goes to watch and drive. */
  viewerUrl: string;
  /** Where the agent's Playwright MCP dials in with --cdp-endpoint. */
  cdpUrl: string;
  state: 'registered' | 'started' | 'running';
}

/** The command an app pane runs to own one profile. */
export function browserHostCommand(opts: {
  hostEntry: string;
  profile: string;
  port: number;
  dataDir: string;
  chromePath: string;
}): string {
  // Quoted because a data dir or a Chrome path can contain spaces. The profile
  // is already known to be a bare slug (normalizeProfileName), so it needs no
  // quoting and could not carry a shell metacharacter if it tried.
  return [
    'node',
    JSON.stringify(opts.hostEntry),
    `--profile=${normalizeProfileName(opts.profile)}`,
    `--port=${opts.port}`,
    `--data-dir=${JSON.stringify(opts.dataDir)}`,
    `--chrome=${JSON.stringify(opts.chromePath)}`,
    `--jar=${JSON.stringify(browserJarPath(opts.dataDir))}`,
  ].join(' ');
}

/** CDP ports already claimed by a registered browser app. */
export function takenBrowserPorts(db: Database.Database): Set<number> {
  const taken = new Set<number>();
  for (const app of new AppStore(db).list()) {
    if (!isBrowserAppSlug(app.slug)) continue;
    const cdp = cdpPortFromViewerUrl(app.url);
    if (cdp !== null) taken.add(cdp);
  }
  return taken;
}

/**
 * The CDP port behind an app row's viewer URL.
 *
 * The row stores the VIEWER url, because that is the one a person opens and the
 * one the status probe should be measuring. The CDP port is derived back off it
 * rather than stored separately, so the two can never disagree.
 */
export function cdpPortFromViewerUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const viewerPort = Number(parsed.port);
  if (!Number.isInteger(viewerPort)) return null;
  return parseBrowserPort(browserAppUrl(viewerPort - BROWSER_VIEWER_PORT_OFFSET));
}

/** Every browser profile muxpad currently owns a row for. */
export function listBrowserApps(db: Database.Database): BrowserAppState[] {
  const out: BrowserAppState[] = [];
  for (const app of new AppStore(db).list()) {
    const profile = profileFromAppSlug(app.slug);
    if (!profile) continue;
    const cdp = cdpPortFromViewerUrl(app.url);
    out.push({
      slug: app.slug,
      profile,
      viewerUrl: app.url,
      cdpUrl: cdp === null ? '' : browserAppUrl(cdp),
      state: app.enabled ? 'running' : 'registered',
    });
  }
  return out;
}

/**
 * Makes sure exactly one owner exists for this profile, and optionally starts it.
 *
 * Idempotent on the slug. Calling it twice for one profile returns the same row
 * and never produces a second process.
 */
export async function ensureBrowserApp(
  profileName: string,
  deps: EnsureBrowserAppDeps,
): Promise<BrowserAppState> {
  const profile = normalizeProfileName(profileName);
  const slug = browserAppSlug(profile);
  const apps = new AppStore(deps.db);
  const log = deps.log ?? ((line: string) => console.log(line));
  const existing = apps.getBySlug(slug);

  if (existing) {
    const cdp = cdpPortFromViewerUrl(existing.url);
    const state: BrowserAppState = {
      slug,
      profile,
      viewerUrl: existing.url,
      cdpUrl: cdp === null ? '' : browserAppUrl(cdp),
      state: existing.enabled ? 'running' : 'registered',
    };

    // COMMAND DRIFT. The command is baked into the row at creation and into the
    // pane at materialise time, so a browser registered before a flag existed
    // keeps running the old line forever and the feature silently never
    // arrives. That is not hypothetical — the cookie jar flag landed, and no jar
    // was written for the already-registered profile until this existed.
    // Same repair the tunnel does, for the same reason.
    const wanted =
      cdp === null
        ? existing.command
        : browserHostCommand({
            hostEntry: deps.hostEntry,
            profile,
            port: cdp,
            dataDir: deps.dataDir,
            chromePath: deps.chromePath,
          });
    if (wanted !== existing.command) {
      new AppStore(deps.db).update(existing.id, { command: wanted });
      log(`[browser] command drifted for '${slug}' — repaired`);
      if (existing.enabled) {
        // The pane holds the OLD line until it is rebuilt, so a repair that
        // does not restart is a repair that has not happened.
        await deps.registry.stop(existing.id);
        await deps.registry.start(existing.id);
        return { ...state, state: 'started' };
      }
    }

    if (deps.start !== false && !existing.enabled) {
      await deps.registry.start(existing.id);
      return { ...state, state: 'started' };
    }
    return state;
  }

  // A port already in use by another profile is stepped over, not shared: two
  // owners on one debugging port is the same collision as two owners on one
  // profile directory, just later and harder to see.
  const cdpPort = pickBrowserPort(profile, takenBrowserPorts(deps.db));
  const viewerPort = browserViewerPort(cdpPort);

  const created = apps.create({
    slug,
    name: browserAppName(profile),
    cwd: deps.cwd,
    command: browserHostCommand({
      hostEntry: deps.hostEntry,
      profile,
      port: cdpPort,
      dataDir: deps.dataDir,
      chromePath: deps.chromePath,
    }),
    // The VIEWER url: it is what a person opens, and what the app status probe
    // should be measuring. "Is the browser reachable" means "can somebody take
    // the wheel", not "is a debugging port listening".
    url: browserAppUrl(viewerPort),
    autostart: true,
    enabled: false,
  });
  log(`[browser] registered '${slug}' → viewer :${viewerPort}, cdp :${cdpPort}`);

  const state: BrowserAppState = {
    slug,
    profile,
    viewerUrl: browserAppUrl(viewerPort),
    cdpUrl: browserAppUrl(cdpPort),
    state: 'registered',
  };
  if (deps.start === false) return state;
  await deps.registry.start(created.id);
  return { ...state, state: 'started' };
}
