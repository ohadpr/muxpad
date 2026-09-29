import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppRegistry } from '../apps/AppRegistry.js';
import { normalizeBaseUrl } from '../public-base.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { findCloudflared } from './cloudflared.js';

/**
 * muxpad OWNING the Cloudflare tunnel — the server-side half.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `public_base_url_pinned` held a `trycloudflare.com` hostname that somebody
 * started by hand months ago. The process was long gone. Every artifact
 * published since answered connection-refused, and nothing noticed: no owner,
 * no restart, no alarm. public-base.ts's probe demoted the dead name correctly
 * and then fell through to the Tailscale funnel on :8443 — the thing that was
 * already known not to work on most networks. A correct fallback to a broken
 * option is still a broken link.
 *
 * So the tunnel needs an owner, and the owner needs to re-pin: A QUICK TUNNEL
 * MINTS A NEW RANDOM HOSTNAME ON EVERY START. Supervision alone would simply
 * keep a dead name alive with great reliability.
 *
 * HOW IT IS MODELLED, AND WHY
 * ---------------------------
 * The tunnel is AN APP — a row in `apps`, slug `tunnel`, running
 * `muxpad tunnel --port <public port>` inside a hidden-workspace
 * `muxpad serve` pane. Not a sibling supervisor, not a child of the main
 * server. Every property the tunnel needs, the apps primitive already has and
 * has already debugged:
 *
 *   · ptyd owns the process, so the tunnel SURVIVES A MAIN-SERVER RESTART.
 *     This is the decisive one. A tunnel supervised by the main server would
 *     die on every deploy, mint a new hostname on the way back up, and hand
 *     every link published in the previous minute a dead name — reintroducing
 *     the exact bug, just faster.
 *   · serve-supervisor.ts rebuilds the pty after a ptyd restart, with cooldown,
 *     attempt cap, probation, and a PUSH NOTIFICATION when it gives up.
 *   · `muxpad app logs tunnel` already renders the pane's scrollback, so
 *     cloudflared's own diagnostics are readable without a new surface.
 *   · `muxpad app stop tunnel` is how you close the door, with no new verb.
 *   · AppStatus measures it, and because the row's `url` is rewritten to the
 *     live hostname on every announce, that measurement is an end-to-end probe
 *     THROUGH Cloudflare's edge rather than a loopback check.
 *
 * What an app cannot do is write a URL back, and that is the whole of what is
 * new here: {@link noteTunnelUp} / {@link noteTunnelDown}, called by the
 * in-pane process (tunnel/run.ts) over the ordinary API.
 *
 * WHERE IT SITS IN THE PRECEDENCE CHAIN — below `pinned`, above `hint`:
 *
 *     env > pinned > TUNNEL > hint > funnel > persisted > local
 *
 * Below `pinned` because a human who typed `--set-base https://mine.example`
 * outranks a name muxpad minted for itself. Above `hint` because `hint` IS the
 * :8443 funnel url the CLI discovers on every publish, and letting it outrank a
 * live tunnel is precisely the clobber public-base.ts was written to stop.
 *
 * AND `env` STILL WINS — by not running at all. MUXPAD_PUBLIC_BASE_URL is
 * documented as permanent configuration, so when it is set {@link ensureTunnelApp}
 * refuses to register or start the tunnel and stops one that is already up.
 * Merely out-ranking it would leave a pointless quick tunnel dialling
 * Cloudflare forever, holding a public door open next to a real domain that
 * already works.
 *
 * THE APP MODEL WAS NOT ENOUGH — THE SECOND OWNER
 * ----------------------------------------------
 * Everything above is still true and still the default. What it did not survive
 * is A PTYD RESTART. ptyd owns the pane, so `muxpad restart --all` and every
 * deliberate ptyd bounce kill cloudflared, and Cloudflare mints a new four-word
 * name on the way back up. Measured on this machine: three rotations in 26
 * hours during a week of active development, each one killing every link
 * published since the last.
 *
 * So the tunnel may instead be supervised by launchd, as a third job that
 * neither `muxpad restart` nor `muxpad restart --all` can touch
 * (docs/launchd.md §3). The RUNNER is byte-identical — the same
 * `muxpad tunnel --port <n>`, the same parse/announce/retract/heartbeat — and
 * the only thing that changes is WHO IS HOLDING IT, which is the ownership
 * token in {@link TunnelRecord}:
 *
 *   · `pane_id`  — muxpad's own app. Invalidated by the pane going away.
 *   · `pid`      — a process nobody here supervises. Invalidated by the pid
 *                  dying, or by the LEASE expiring ({@link TUNNEL_LEASE_MS}).
 *
 * Neither needs any cleanup path to run, which is the property that made the
 * pane rule survive a crash and is the property the pid rule has to match. And
 * an external owner OUTRANKS the app: {@link ensureTunnelApp} stands down in
 * front of a live one rather than starting a second cloudflared next to it.
 *
 * THE TRADE, STATED PLAINLY: a tunnel that survives a muxpad restart is a
 * tunnel muxpad no longer supervises. `muxpad app logs/stop tunnel` do not
 * reach it (its log is the launchd job's, its stop is `launchctl bootout`), and
 * while muxpad is down the tunnel stays up in front of a port nothing is
 * serving — which is the POINT (the hostname comes back with muxpad instead of
 * rotating), but it also means the fingerprint check that keeps the main
 * unauthenticated server off the internet has to be RE-RUN, not just run once.
 * tunnel/run.ts re-checks it on every heartbeat and closes the door if anything
 * other than muxpad's public server answers on the port.
 */

/** Slug of the app row muxpad manages the tunnel through. */
export const TUNNEL_APP_SLUG = 'tunnel';

/** Display name of that row. */
export const TUNNEL_APP_NAME = 'cloudflare tunnel';

/**
 * globals-KV key holding the CURRENT tunnel hostname plus the pane that owns
 * it, as JSON. The pane id is not decoration — see {@link tunnelBaseUrl}.
 */
export const TUNNEL_BASE_KEY = 'public_base_url_tunnel';

/** globals-KV key holding the last tunnel failure, for the human-facing warning. */
export const TUNNEL_STATUS_KEY = 'public_base_tunnel_status';

/** Consecutive failures before the tunnel's trouble is worth saying out loud. */
export const TUNNEL_WARN_AFTER_ATTEMPTS = 3;

/**
 * How long a PROCESS-owned announce stays valid without a refresh — three
 * heartbeats' worth (tunnel/run.ts re-states its url every 30s).
 *
 * The pid check alone would not do. Pids are recycled, and a runner that is
 * alive but wedged looks exactly like a healthy one from the outside. The lease
 * bounds both, at the cost of up to 90s in which a hostname nothing is serving
 * is still being handed out — which is why it is the BACKSTOP and not the
 * mechanism: the runner retracts the instant cloudflared exits, and the pid
 * check catches a runner that was killed outright. The lease only ever fires for
 * the case neither of those can see.
 *
 * A pane-owned record has no lease. Its token is a row in `panes`, which does
 * not go stale on a clock.
 */
export const TUNNEL_LEASE_MS = 90_000;

export interface TunnelRecord {
  /**
   * The live base origin, e.g. `https://franklin-discuss-powers-usgs.trycloudflare.com`
   * — or null for a CLAIM: a runner that owns the tunnel and has not been handed
   * a hostname yet. Ownership starts before the name exists, so that a publish
   * in cloudflared's four-second cold start cannot start a rival tunnel.
   */
  url: string | null;
  /** The app pane that announced it. Ownership, not metadata. */
  pane_id: string | null;
  /**
   * The announcing PROCESS. Ownership too — the only kind available to a runner
   * with no pane (a launchd job). Also recorded for a pane-owned tunnel, where
   * it strictly strengthens the pane rule: see {@link tunnelBaseUrl}.
   */
  pid?: number | null;
  /** When it was announced. Renewed by the heartbeat; see {@link TUNNEL_LEASE_MS}. */
  at: number;
}

/**
 * The liveness questions {@link tunnelBaseUrl} has to ask about a process it
 * does not supervise. Injectable because a test cannot conjure a pid that dies
 * on cue, and a clock-driven lease needs a drivable clock.
 */
export interface TunnelLiveness {
  alive?: (pid: number) => boolean;
  now?: () => number;
}

/**
 * Is that pid still there?
 *
 * Signal 0 is the standard existence probe. EPERM means the pid EXISTS but
 * belongs to another user, and is treated as alive: guessing "gone" would drop a
 * url that may well be live, and the lease bounds the mistake either way.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Who is holding the tunnel — for diagnostics, and for the stand-down rule. */
export type TunnelOwnerKind = 'pane' | 'process';

export interface TunnelStatus {
  /** Last error text from the in-pane supervisor. */
  error: string;
  /** How many consecutive starts have failed. */
  attempts: number;
  at: number;
}

function del(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM globals WHERE key = ?').run(key);
}

function readJson<T>(db: Database.Database, key: string): T | null {
  const raw = new GlobalsStore(db).get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A hand-edited or half-written value is treated as absent rather than
    // thrown: this is read on the publish path, and a malformed KV row must
    // not be able to take publishing down.
    return null;
  }
}

/**
 * The tunnel's url, or null — with the two liveness rules that keep a DEAD
 * NAME FROM OUTLIVING THE PROCESS THAT MINTED IT.
 *
 * Rule 1: THE APP MUST BE ENABLED. `muxpad app stop tunnel` is a decision, and
 * the url it was serving stops being an answer at the same instant — not at
 * the next probe, not never.
 *
 * Rule 2: THE ANNOUNCING PANE MUST STILL BE THE APP'S PANE, AND MUST STILL
 * EXIST. Stop/start mints a new pane, so a url announced by the old one is
 * orphaned by construction and can never be served again. This is the rule
 * that survives a crash: nothing has to run for the old value to become
 * invalid, so no cleanup path can be missed.
 *
 * Both are pure SQLite — no ptyd round-trip — because this is read on a polled
 * path (the Hosted view refreshes every few seconds).
 *
 * Rule 3, WHEN THERE IS NO PANE (a launchd-supervised runner): the announcing
 * PROCESS must still be alive, and the announce must be within
 * {@link TUNNEL_LEASE_MS}. Same shape as rules 1 and 2 — nothing has to run for
 * the value to go invalid — and the same guarantee: a dead name cannot outlive
 * the process that minted it.
 *
 * A record with NEITHER token is never served. Nothing could invalidate it.
 *
 * THE HONEST LIMIT, NARROWED. This used to read: after a PTYD restart the pane
 * row still exists while the pty does not, so for the ~20s until
 * serve-supervisor.ts rebuilds it the last url is still returned. That window is
 * now closed whenever the record carries a pid — the pid check applies to BOTH
 * owner kinds, so a pane whose process is gone is caught at once rather than at
 * the next reconcile. public-base.ts's reachability probe remains underneath
 * either way; belt and braces, not one or the other.
 */
export function tunnelBaseUrl(db: Database.Database, live?: TunnelLiveness): string | null {
  const rec = readJson<TunnelRecord>(db, TUNNEL_BASE_KEY);
  if (!rec?.url) return null;
  if (!tunnelOwnerOf(db, rec, live)) return null;
  return normalizeBaseUrl(rec.url);
}

/** The owner of a record, or null when nothing valid is holding it. */
function tunnelOwnerOf(
  db: Database.Database,
  rec: TunnelRecord,
  live?: TunnelLiveness,
): TunnelOwnerKind | null {
  // The process check applies to both owner kinds: an announcing process that
  // is gone can never be serving the name it announced, whatever else is true.
  if (rec.pid != null && !(live?.alive ?? pidAlive)(rec.pid)) return null;
  if (rec.pane_id) {
    const app = new AppStore(db).getBySlug(TUNNEL_APP_SLUG);
    if (!app || !app.enabled) return null;
    if (!app.pane_id || app.pane_id !== rec.pane_id) return null;
    if (!new PaneStore(db).getById(app.pane_id)) return null;
    return 'pane';
  }
  if (rec.pid == null) return null;
  const now = (live?.now ?? Date.now)();
  if (now - rec.at > TUNNEL_LEASE_MS) return null;
  return 'process';
}

/** Who is holding the tunnel right now, or null. For `GET /api/publish/tunnel`. */
export function tunnelOwnerKind(
  db: Database.Database,
  live?: TunnelLiveness,
): TunnelOwnerKind | null {
  const rec = readJson<TunnelRecord>(db, TUNNEL_BASE_KEY);
  if (!rec) return null;
  return tunnelOwnerOf(db, rec, live);
}

/**
 * The tunnel is held by a process muxpad does not supervise, or null.
 *
 * This is the stand-down signal. It is true of a CLAIM as well as of a live
 * url, deliberately: the runner owns the tunnel through cloudflared's cold start
 * and through every backoff window, and a publish landing in one of those must
 * not start a second cloudflared in a pane.
 */
export function externalTunnelOwner(
  db: Database.Database,
  live?: TunnelLiveness,
): { pid: number; url: string | null; at: number } | null {
  const rec = readJson<TunnelRecord>(db, TUNNEL_BASE_KEY);
  if (!rec || rec.pid == null || rec.pane_id) return null;
  if (tunnelOwnerOf(db, rec, live) !== 'process') return null;
  return { pid: rec.pid, url: rec.url, at: rec.at };
}

/** The raw record, for diagnostics and tests. No liveness rules applied. */
export function readTunnelRecord(db: Database.Database): TunnelRecord | null {
  return readJson<TunnelRecord>(db, TUNNEL_BASE_KEY);
}

export function readTunnelStatus(db: Database.Database): TunnelStatus | null {
  return readJson<TunnelStatus>(db, TUNNEL_STATUS_KEY);
}

/**
 * A tunnel came up at `url`, announced by `paneId`.
 *
 * Also rewrites the app row's `url`, so the Hosted view's status light probes
 * the live hostname THROUGH Cloudflare instead of a loopback port that is up
 * whether or not the tunnel is.
 */
export function noteTunnelUp(
  db: Database.Database,
  input: { url: string; paneId?: string | null; pid?: number | null; now?: number },
): string | null {
  const url = normalizeBaseUrl(input.url);
  // https-only, origin-only. A quick tunnel is always https, so anything else
  // reaching here is a parse gone wrong — and a bad value would be pinned as
  // the base every published link is built from.
  if (!url || !url.startsWith('https://')) return null;
  const rec: TunnelRecord = {
    url,
    pane_id: input.paneId ?? null,
    ...(input.pid != null ? { pid: input.pid } : {}),
    at: input.now ?? Date.now(),
  };
  new GlobalsStore(db).set(TUNNEL_BASE_KEY, JSON.stringify(rec));
  // A start that worked clears the failure story; leaving it would keep
  // warning about trouble that is over.
  del(db, TUNNEL_STATUS_KEY);
  const apps = new AppStore(db);
  const app = apps.getBySlug(TUNNEL_APP_SLUG);
  if (app && app.url !== url) apps.update(app.id, { url });
  return url;
}

/**
 * A runner with no pane CLAIMS the tunnel, before it has a hostname to report.
 *
 * Ownership has to start earlier than the url does. cloudflared takes about four
 * seconds to be handed a name, and it is re-spawned after every failure with a
 * backoff of up to a minute — so a rule that read ownership off the url would
 * leave the tunnel unowned for exactly the windows in which a publish is most
 * likely to try to start one of its own.
 *
 * Also used by the heartbeat to renew the lease while there is no url, so a long
 * backoff cannot outlive the claim that suppresses the rival.
 */
export function noteTunnelClaim(
  db: Database.Database,
  input: { pid: number; now?: number },
): boolean {
  if (!Number.isInteger(input.pid) || input.pid <= 0) return false;
  const existing = readJson<TunnelRecord>(db, TUNNEL_BASE_KEY);
  // A claim from the SAME runner keeps whatever url it already announced — the
  // heartbeat must renew a lease, never blank a live hostname.
  const url = existing?.pid === input.pid ? (existing?.url ?? null) : null;
  const rec: TunnelRecord = { url, pane_id: null, pid: input.pid, at: input.now ?? Date.now() };
  new GlobalsStore(db).set(TUNNEL_BASE_KEY, JSON.stringify(rec));
  return true;
}

/**
 * The tunnel went down. Called the INSTANT cloudflared exits — before any
 * backoff — so the window in which the database advertises a hostname that
 * nothing is serving is a round-trip, not a retry cycle.
 *
 * `pid` is the difference between "cloudflared died" and "the tunnel is over".
 * A retraction from a runner that still owns the tunnel drops the URL and KEEPS
 * the claim (renewing its lease, because a backoff can be a minute long and the
 * heartbeat is silent while there is no url). Without a pid — a pane runner, or a
 * final stop — the record goes entirely, as it always did.
 */
export function noteTunnelDown(
  db: Database.Database,
  input?: {
    error?: string | undefined;
    attempts?: number | undefined;
    pid?: number | null;
    now?: number;
  },
): void {
  const existing = readJson<TunnelRecord>(db, TUNNEL_BASE_KEY);
  if (input?.pid != null && existing && existing.pid === input.pid && !existing.pane_id) {
    const kept: TunnelRecord = {
      url: null,
      pane_id: null,
      pid: input.pid,
      at: input.now ?? Date.now(),
    };
    new GlobalsStore(db).set(TUNNEL_BASE_KEY, JSON.stringify(kept));
  } else {
    del(db, TUNNEL_BASE_KEY);
  }
  if (!input?.error) return;
  const status: TunnelStatus = {
    error: String(input.error).slice(0, 500),
    attempts: Number.isFinite(input.attempts) ? Number(input.attempts) : 1,
    at: input.now ?? Date.now(),
  };
  new GlobalsStore(db).set(TUNNEL_STATUS_KEY, JSON.stringify(status));
}

/**
 * The one-line explanation of a tunnel that is failing, or null.
 *
 * RESTART STORMS NEED A SURFACE, not just a ceiling. The in-pane supervisor
 * backs off to a minute and keeps trying, which is correct and also completely
 * silent — the failure mode this whole feature exists to kill. So the failure
 * is surfaced where the consequence is: on the base url every published link is
 * built from, which means `muxpad publish --base`, the publish response, and
 * the Hosted view's base line all say it without any of them knowing about
 * tunnels. One flaky restart says nothing; a run of them says it plainly.
 */
export function tunnelWarning(db: Database.Database, live?: TunnelLiveness): string | null {
  const st = readTunnelStatus(db);
  if (!st || st.attempts < TUNNEL_WARN_AFTER_ATTEMPTS) return null;
  // Name the log the reader can actually open. `muxpad app logs tunnel` reads a
  // PANE's scrollback, and a launchd-supervised tunnel has no pane — pointing
  // someone at it would be a dead end at the one moment they need the output.
  const where =
    externalTunnelOwner(db, live) !== null
      ? "see the launchd job's log (`muxpad publish --tunnel` names it)"
      : 'run `muxpad app logs tunnel`';
  return `the cloudflare tunnel has failed to start ${st.attempts} times in a row (${st.error}) — ${where}`;
}

export type TunnelEnsureState = 'started' | 'running' | 'disabled';

export interface TunnelEnsureResult {
  state: TunnelEnsureState;
  /** Why, when `disabled`. Always safe to show a human. */
  reason?: string;
}

export interface EnsureTunnelDeps {
  db: Database.Database;
  registry: AppRegistry;
  /** The PUBLIC static port — never the main port. See {@link tunnelCommand}. */
  publicPort: number;
  /** MUXPAD_PUBLIC_BASE_URL, if set. Its presence DISABLES the tunnel. */
  configuredBaseUrl?: string | undefined;
  /** Injectable for tests; defaults to the real PATH search. */
  findBin?: () => string | null;
  cwd?: string;
  log?: (msg: string) => void;
  /** Injectable pid/clock for the external-owner check. Tests only. */
  liveness?: TunnelLiveness;
  /**
   * Bring it UP, not merely make it correct. Default true — publishing is an
   * explicit "make this public", so it reopens a door the user closed.
   *
   * BOOT PASSES FALSE, and the distinction matters: `muxpad app stop tunnel`
   * is a decision, and a server restart that silently undid it would make the
   * stop button a lie. At boot this call only enforces policy (env set, no
   * binary, a drifted port); starting an enabled app is the app reconciler's
   * job, which already honours `autostart`.
   */
  start?: boolean;
}

/**
 * The pane command. Kept next to the policy that builds it because the port
 * argument is the security-critical value in this feature: the tunnel must
 * point at the hardened static listener (public-server.ts, :7778 — no API, no
 * WS, no listings, sandboxed CSP on every response) and NEVER at the main app,
 * which has no authentication at all and whose own source says reachability IS
 * authorization. Putting :7777 on the open internet would hand the world a
 * terminal.
 *
 * Passing the port is not the guarantee, only the intent — tunnel/run.ts
 * refuses to tunnel anything that does not positively identify itself as the
 * public server. Two independent checks, because one typo here is
 * catastrophic and unrecoverable.
 */
export function tunnelCommand(publicPort: number): string {
  return `muxpad tunnel --port ${publicPort}`;
}

/**
 * Make the tunnel's registration match policy, and bring it up.
 *
 * WHEN THE TUNNEL RUNS — the deliberate choice: LAZILY, on the first publish,
 * and then always, until the user stops it.
 *
 * An always-on tunnel is a permanently open door to the public artifact server
 * on an instance that may never publish anything; a purely on-demand one would
 * make every publish pay a ~4s cold start AND would tear the door down under
 * links that are still being read. The split is: nothing dials Cloudflare until
 * there is something to serve, and once there is, the tunnel stays up so the
 * links keep working. `muxpad app stop tunnel` closes the door; publishing
 * again reopens it.
 *
 * Idempotent: safe to call on every publish and at boot.
 */
export async function ensureTunnelApp(deps: EnsureTunnelDeps): Promise<TunnelEnsureResult> {
  const apps = new AppStore(deps.db);
  const log = deps.log ?? ((m: string) => console.log(m));
  const existing = apps.getBySlug(TUNNEL_APP_SLUG);

  const disable = async (
    reason: string,
    opts?: { keepRecord?: boolean },
  ): Promise<TunnelEnsureResult> => {
    if (existing?.enabled) {
      await deps.registry.stop(existing.id);
      log(`[tunnel] stopping: ${reason}`);
    }
    // `keepRecord` is for standing down in front of SOMEBODY ELSE'S live tunnel.
    // Retracting there would blank the base every published link is built from,
    // for a hostname that is up and answering.
    if (!opts?.keepRecord) noteTunnelDown(deps.db);
    return { state: 'disabled', reason };
  };

  // 1. A real domain outranks everything, including the decision to run.
  if (deps.configuredBaseUrl) {
    return disable(
      `MUXPAD_PUBLIC_BASE_URL is set (${deps.configuredBaseUrl}) — that is the public base, so no tunnel is needed`,
    );
  }

  // 1b. A tunnel supervised OUTSIDE muxpad outranks muxpad's own — it is the
  //     same runner with a better owner (it survives `muxpad restart --all`, so
  //     the hostname stops rotating on every deploy). Two cloudflareds would be
  //     two public doors, and the app's would keep minting a new name per
  //     deploy while this one kept a stable one.
  //
  //     Note the ORDER: below `configuredBaseUrl`, so a real domain still
  //     cancels the tunnel outright. muxpad cannot stop a launchd job, so that
  //     cancellation travels back to the runner as `wanted: false` on its next
  //     announce (routes/publish.ts → tunnel/run.ts), which is why the env
  //     branch above must run first and must still clear the record.
  const external = externalTunnelOwner(deps.db, deps.liveness);
  if (external) {
    return disable(
      `an external tunnel runner owns the tunnel (pid ${external.pid}) — it is supervised outside muxpad (launchd job dev.muxpad.tunnel), so muxpad neither starts nor stops it; \`launchctl bootout gui/$UID/dev.muxpad.tunnel\` closes that door`,
      { keepRecord: true },
    );
  }

  // 2. No cloudflared is a configuration fact, not a crash. Refuse to register
  //    an app that could only crash-loop inside a hidden workspace, and say why
  //    in a sentence that names the fix.
  const bin = (deps.findBin ?? (() => findCloudflared()))();
  if (!bin) {
    return disable(
      'cloudflared is not installed (brew install cloudflared, or set MUXPAD_CLOUDFLARED_BIN) — published links have no public tunnel',
    );
  }

  const command = tunnelCommand(deps.publicPort);
  const localUrl = `http://127.0.0.1:${deps.publicPort}`;
  const cwd = deps.cwd ?? homedir();
  const mayStart = deps.start ?? true;

  if (!existing) {
    // Nothing to enforce on an instance that has never published: registering
    // the app IS the act of opening the door, so a policy-only pass declines.
    if (!mayStart) return { state: 'disabled', reason: 'no tunnel registered yet' };
    const created = apps.create({
      slug: TUNNEL_APP_SLUG,
      name: TUNNEL_APP_NAME,
      cwd,
      command,
      // Until the first announce the row points at the local public port. The
      // announce rewrites it to the live hostname, which is what makes the
      // status light mean "reachable from the internet".
      url: localUrl,
      autostart: true,
      enabled: false,
    });
    log(`[tunnel] registered as app '${TUNNEL_APP_SLUG}' → ${command}`);
    await deps.registry.start(created.id);
    return { state: 'started' };
  }

  // The port can change (an isolated instance, a MUXPAD_PUBLIC_PORT override).
  // Repair the command rather than leaving a tunnel pointed at a port this
  // server no longer listens on — a silently public-but-wrong door.
  if (existing.command !== command) {
    apps.update(existing.id, { command });
    log(`[tunnel] command drifted — repaired to ${command}`);
    if (existing.enabled) {
      // The startup command is baked into the pane at materialise time, so the
      // fix only takes effect on a fresh pane. This one restart happens even on
      // a policy-only pass: a tunnel pointed at a port this server no longer
      // listens on is a public door onto nothing (or, worse, onto whatever took
      // the port), and leaving it until the next publish is not an option.
      await deps.registry.stop(existing.id);
      await deps.registry.start(existing.id);
      return { state: 'started' };
    }
  }

  // `pane_id` is a POINTER, and a pane can be deleted by paths that know
  // nothing about the registry. Checking the row exists — rather than trusting
  // the pointer — is the difference between reporting `running` at a tunnel
  // that is gone and rebuilding it.
  if (existing.enabled && existing.pane_id && new PaneStore(deps.db).getById(existing.pane_id))
    return { state: 'running' };
  if (!mayStart) return { state: existing.enabled ? 'started' : 'disabled' };
  await deps.registry.start(existing.id);
  return { state: 'started' };
}

/**
 * Boot housekeeping: drop a tunnel url whose owning pane is gone.
 *
 * {@link tunnelBaseUrl} already refuses to return such a value, so this changes
 * no behaviour — it keeps the DATABASE honest, so that a human reading
 * `globals` (or a future reader of this key) is never shown a hostname that
 * cannot possibly be live. Cheap, and the alternative is a row that lies
 * forever.
 */
export function clearOrphanedTunnelBase(db: Database.Database, live?: TunnelLiveness): boolean {
  const rec = readTunnelRecord(db);
  if (!rec) return false;
  // A live external CLAIM has no url of its own — the runner is mid-backoff — and
  // deleting it would hand the next publish permission to start a rival tunnel.
  if (externalTunnelOwner(db, live)) return false;
  if (tunnelBaseUrl(db, live)) return false;
  del(db, TUNNEL_BASE_KEY);
  return true;
}

/**
 * Wait (briefly) for a tunnel url to appear.
 *
 * The first publish on a fresh instance is the one moment where waiting beats
 * answering: cloudflared takes about four seconds to be handed a hostname, and
 * a publish that returns a millisecond earlier with a loopback link has
 * answered the wrong question. Every later publish finds the url already there
 * and returns immediately.
 *
 * `ready` is what makes the wait worth having. Cloudflare prints the hostname
 * several seconds before its edge will answer on it ("it may take some time to
 * be reachable", in cloudflared's own words), and returning at the announce
 * would hand the resolver a name its reachability probe then demotes — so the
 * publish would print the OLD dead base while the new tunnel was seconds from
 * working. Waiting for it to ANSWER is the difference between a link and a URL.
 *
 * Bounded, and a timeout is NOT an error — the caller falls back down the
 * normal chain, exactly as if no tunnel had been asked for.
 */
export async function waitForTunnelUrl(
  db: Database.Database,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Extra condition, e.g. "and it answers". Absent = announce is enough. */
    ready?: (url: string) => Promise<boolean>;
  },
): Promise<string | null> {
  const timeout = opts?.timeoutMs ?? TUNNEL_FIRST_URL_WAIT_MS;
  const poll = opts?.pollMs ?? 250;
  const now = opts?.now ?? (() => Date.now());
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeout;
  for (;;) {
    const url = tunnelBaseUrl(db);
    if (url && (!opts?.ready || (await opts.ready(url)))) return url;
    if (now() >= deadline) return null;
    await sleep(poll);
  }
}

/**
 * How long a publish will wait for a cold tunnel. Measured: cloudflared prints
 * its hostname ~3–4s after launch and registers a connection ~1s later. Twelve
 * seconds leaves room for a slow network without making a publish feel hung —
 * and it is paid at most once, on the first publish of an instance's life.
 */
export const TUNNEL_FIRST_URL_WAIT_MS = 12_000;
