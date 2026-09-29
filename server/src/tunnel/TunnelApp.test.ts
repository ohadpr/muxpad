import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppRegistry, createAppRegistry } from '../apps/AppRegistry.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { openDb } from '../store/db.js';
import {
  TUNNEL_APP_SLUG,
  TUNNEL_BASE_KEY,
  TUNNEL_LEASE_MS,
  TUNNEL_STATUS_KEY,
  clearOrphanedTunnelBase,
  ensureTunnelApp,
  externalTunnelOwner,
  noteTunnelClaim,
  noteTunnelDown,
  noteTunnelUp,
  readTunnelRecord,
  tunnelBaseUrl,
  tunnelCommand,
  tunnelOwnerKind,
  tunnelWarning,
  waitForTunnelUrl,
} from './TunnelApp.js';

/** Two quick-tunnel names. The whole point is that they differ per start. */
const FIRST = 'https://franklin-discuss-powers-usgs.trycloudflare.com';
const SECOND = 'https://quiet-mango-parallel-tide.trycloudflare.com';

let db: Database.Database;
let apps: AppStore;
let panes: PaneStore;
let registry: AppRegistry;
let ensured: string[];
/** Drivable clock: the registry's materialise cooldown is 10s of real time. */
let clock: number;

beforeEach(() => {
  db = openDb(':memory:');
  apps = new AppStore(db);
  panes = new PaneStore(db);
  ensured = [];
  clock = 1_000_000;
  registry = createAppRegistry({
    db,
    ptyd: {
      ensurePane: async (spec) => {
        ensured.push(spec.id);
      },
      killPane: async () => {},
    },
    now: () => clock,
    log: () => {},
  });
});

/** Register + start the tunnel app the way a publish would, and announce a url. */
async function bringUp(url = FIRST): Promise<{ appId: string; paneId: string }> {
  const res = await ensureTunnelApp({
    db,
    registry,
    publicPort: 7778,
    findBin: () => '/opt/homebrew/bin/cloudflared',
    cwd: '/tmp',
    log: () => {},
  });
  expect(res.state).not.toBe('disabled');
  const app = apps.getBySlug(TUNNEL_APP_SLUG);
  if (!app?.pane_id) throw new Error('tunnel app did not materialise');
  noteTunnelUp(db, { url, paneId: app.pane_id });
  return { appId: app.id, paneId: app.pane_id };
}

describe('ensureTunnelApp — decision 1: env wins, by cancelling the tunnel', () => {
  it('refuses to register a tunnel when MUXPAD_PUBLIC_BASE_URL is set', async () => {
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      configuredBaseUrl: 'https://links.example.com',
      findBin: () => '/opt/homebrew/bin/cloudflared',
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(res.reason).toContain('MUXPAD_PUBLIC_BASE_URL');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)).toBeNull();
  });

  it('STOPS a running tunnel when a real domain appears, and forgets its url', async () => {
    // The upgrade path: a user who has been living on quick tunnels sets a
    // permanent domain. Outranking the tunnel would leave it dialling
    // Cloudflare forever, holding a second public door open for nothing.
    const { paneId } = await bringUp();
    expect(tunnelBaseUrl(db)).toBe(FIRST);

    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      configuredBaseUrl: 'https://links.example.com',
      findBin: () => '/opt/homebrew/bin/cloudflared',
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(false);
    expect(panes.getById(paneId)).toBeFalsy();
    expect(tunnelBaseUrl(db)).toBeNull();
    expect(readTunnelRecord(db)).toBeNull();
  });
});

describe('ensureTunnelApp — cloudflared missing degrades cleanly', () => {
  it('registers nothing and explains, rather than crash-looping in a hidden pane', async () => {
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => null,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(res.reason).toContain('cloudflared is not installed');
    expect(res.reason).toContain('brew install cloudflared');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)).toBeNull();
    // And nothing threw: a machine without cloudflared publishes fine, it just
    // has no public tunnel.
  });

  it('stops an existing tunnel if cloudflared disappears', async () => {
    await bringUp();
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => null,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(false);
    expect(tunnelBaseUrl(db)).toBeNull();
  });
});

describe('ensureTunnelApp — decision 5: it points at the public port', () => {
  it('builds the command from the PUBLIC port', async () => {
    await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      cwd: '/tmp',
      log: () => {},
    });
    const app = apps.getBySlug(TUNNEL_APP_SLUG);
    expect(app?.command).toBe('muxpad tunnel --port 7778');
    expect(app?.command).not.toContain('7777');
  });

  it('repairs and restarts a tunnel whose port has drifted', async () => {
    const { paneId } = await bringUp();
    // An isolated instance, or a MUXPAD_PUBLIC_PORT change: the old command
    // points at a port this server no longer listens on — a public door onto
    // nothing, or onto whatever took the port.
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 9999,
      findBin: () => '/x/cloudflared',
      cwd: '/tmp',
      log: () => {},
    });
    expect(res.state).toBe('started');
    const app = apps.getBySlug(TUNNEL_APP_SLUG);
    expect(app?.command).toBe(tunnelCommand(9999));
    expect(app?.pane_id).not.toBe(paneId); // a fresh pane, with the fixed command
    // …and the url the OLD pane announced is gone with it.
    expect(tunnelBaseUrl(db)).toBeNull();
  });
});

describe('ensureTunnelApp — a user stop survives a restart', () => {
  it('boot (start: false) does not restart a tunnel the user stopped', async () => {
    const { appId } = await bringUp();
    await registry.stop(appId);
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(false);

    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      cwd: '/tmp',
      start: false,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(false);
  });

  it('but a publish reopens it — publishing IS the decision to be public', async () => {
    const { appId } = await bringUp();
    await registry.stop(appId);
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      cwd: '/tmp',
      log: () => {},
    });
    expect(res.state).toBe('started');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(true);
  });

  it('is idempotent on an already-running tunnel', async () => {
    const { paneId } = await bringUp();
    const before = ensured.length;
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      cwd: '/tmp',
      log: () => {},
    });
    expect(res.state).toBe('running');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.pane_id).toBe(paneId);
    expect(ensured.length).toBe(before); // no second pty for the same tunnel
  });
});

describe('the pin follows the tunnel', () => {
  it('replaces the hostname on a restart instead of preserving the dead one', async () => {
    // THE load-bearing behaviour: a quick tunnel mints a NEW name every start,
    // so supervision that did not re-pin would keep a dead name alive with
    // perfect reliability.
    const { paneId } = await bringUp(FIRST);
    expect(tunnelBaseUrl(db)).toBe(FIRST);

    // cloudflared dies: the url is retracted IMMEDIATELY, before any backoff.
    noteTunnelDown(db, { error: 'cloudflared exited (code 1) after 2s', attempts: 1 });
    expect(tunnelBaseUrl(db)).toBeNull();
    expect(readTunnelRecord(db)).toBeNull();

    // …and comes back under a different name, in the same pane.
    noteTunnelUp(db, { url: SECOND, paneId });
    expect(tunnelBaseUrl(db)).toBe(SECOND);
    expect(tunnelBaseUrl(db)).not.toBe(FIRST);
  });

  it('rewrites the app row url, so the status light probes the real hostname', async () => {
    await bringUp(FIRST);
    // Before the announce the row points at loopback, which is up whether or
    // not the tunnel is — a status light that cannot fail is not a status
    // light. After it, the probe goes out through Cloudflare's edge.
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.url).toBe(FIRST);
  });

  it('refuses a url that is not an https origin', () => {
    expect(noteTunnelUp(db, { url: 'http://127.0.0.1:7778' })).toBeNull();
    expect(noteTunnelUp(db, { url: 'https://x.trycloudflare.com/path' })).toBeNull();
    expect(noteTunnelUp(db, { url: 'not a url' })).toBeNull();
    expect(readTunnelRecord(db)).toBeNull();
  });
});

describe('decision 4: a stale name can never outlive its process', () => {
  it('drops a url whose announcing pane is no longer the app pane', async () => {
    const { appId, paneId } = await bringUp(FIRST);
    expect(tunnelBaseUrl(db)).toBe(FIRST);

    // Stop and start mints a NEW pane. The old pane's url is orphaned by
    // construction — nothing had to run for it to become invalid, which is
    // what makes this survive a crash.
    await registry.stop(appId);
    await registry.start(appId);
    const fresh = apps.getBySlug(TUNNEL_APP_SLUG);
    expect(fresh?.pane_id).not.toBe(paneId);
    // The record is still in the KV (the stop raced nothing), and is ignored.
    new GlobalsStore(db).set(
      TUNNEL_BASE_KEY,
      JSON.stringify({ url: FIRST, pane_id: paneId, at: Date.now() }),
    );
    expect(tunnelBaseUrl(db)).toBeNull();
  });

  it('drops a url when the app is stopped — a stop is immediate, not eventual', async () => {
    const { appId } = await bringUp(FIRST);
    await registry.stop(appId);
    expect(tunnelBaseUrl(db)).toBeNull();
  });

  it('drops a url whose pane row was deleted out from under it', async () => {
    const { paneId } = await bringUp(FIRST);
    panes.delete(paneId);
    expect(tunnelBaseUrl(db)).toBeNull();
  });

  it('ignores a malformed KV value rather than failing the publish path', () => {
    new GlobalsStore(db).set(TUNNEL_BASE_KEY, '{not json');
    expect(() => tunnelBaseUrl(db)).not.toThrow();
    expect(tunnelBaseUrl(db)).toBeNull();
  });

  it('clearOrphanedTunnelBase deletes the row a boot inherits', async () => {
    const { paneId } = await bringUp(FIRST);
    // Simulate the boot after a machine restart that lost the pane.
    panes.delete(paneId);
    expect(clearOrphanedTunnelBase(db)).toBe(true);
    expect(readTunnelRecord(db)).toBeNull();
    // Idempotent…
    expect(clearOrphanedTunnelBase(db)).toBe(false);
    // …and it never deletes a LIVE record. The reconciler rebuilds the pane,
    // the new tunnel process announces its new name, and that one stays.
    clock += 60_000; // past the registry's materialise cooldown
    await registry.reconcile();
    const rebuilt = apps.getBySlug(TUNNEL_APP_SLUG);
    expect(rebuilt?.pane_id).toBeTruthy();
    noteTunnelUp(db, { url: SECOND, paneId: rebuilt?.pane_id ?? null });
    expect(clearOrphanedTunnelBase(db)).toBe(false);
    expect(tunnelBaseUrl(db)).toBe(SECOND);
  });
});

describe('decision 3: a restart storm has a surface', () => {
  it('says nothing about one unlucky restart', () => {
    noteTunnelDown(db, { error: 'boom', attempts: 1 });
    expect(tunnelWarning(db)).toBeNull();
    noteTunnelDown(db, { error: 'boom', attempts: 2 });
    expect(tunnelWarning(db)).toBeNull();
  });

  it('names the problem and the log command once it is a run of them', () => {
    noteTunnelDown(db, { error: 'cloudflared exited (code 1) after 0s', attempts: 5 });
    const w = tunnelWarning(db);
    expect(w).toContain('failed to start 5 times');
    expect(w).toContain('cloudflared exited (code 1)');
    expect(w).toContain('muxpad app logs tunnel');
  });

  it('a successful start clears the failure story', async () => {
    noteTunnelDown(db, { error: 'boom', attempts: 9 });
    expect(tunnelWarning(db)).not.toBeNull();
    await bringUp(FIRST);
    expect(tunnelWarning(db)).toBeNull();
    expect(new GlobalsStore(db).get(TUNNEL_STATUS_KEY)).toBeNull();
  });
});

describe('an EXTERNAL tunnel — one muxpad does not supervise', () => {
  /**
   * The launchd-owned runner (docs/launchd.md §3). It has no pane, because
   * having a pane is exactly what made the hostname rotate: the pane is a ptyd
   * child, so `muxpad restart --all` and every ptyd bounce killed cloudflared
   * and Cloudflare minted a new four-word name.
   *
   * So the ownership token changes with the owner. A pane-owned url is
   * invalidated by its pane disappearing; a process-owned one is invalidated by
   * its PID dying or its LEASE expiring. Neither needs anything to run.
   */
  const RUNNER_PID = 424_242;
  let live: { alive: (pid: number) => boolean; now: () => number };
  let alivePids: Set<number>;
  let clockMs: number;

  beforeEach(() => {
    alivePids = new Set([RUNNER_PID]);
    clockMs = 1_700_000_000_000;
    live = { alive: (pid) => alivePids.has(pid), now: () => clockMs };
  });

  const announceExternal = (url = FIRST) =>
    noteTunnelUp(db, { url, pid: RUNNER_PID, now: clockMs });

  it('serves a url with NO pane and NO app row at all', async () => {
    // The whole point: there is nothing for a muxpad restart to take away.
    announceExternal();
    expect(apps.getBySlug(TUNNEL_APP_SLUG)).toBeNull();
    expect(tunnelBaseUrl(db, live)).toBe(FIRST);
    expect(tunnelOwnerKind(db, live)).toBe('process');
  });

  it('drops it the instant the runner process is gone', () => {
    announceExternal();
    alivePids.delete(RUNNER_PID);
    // No retraction arrived — the runner was SIGKILLed, or the machine lost
    // power. Nothing had to run for the name to stop being an answer.
    expect(tunnelBaseUrl(db, live)).toBeNull();
    expect(externalTunnelOwner(db, live)).toBeNull();
  });

  it('drops it when the lease expires, even though the pid still resolves', () => {
    // The pid check alone is not enough: pids are recycled, and a wedged runner
    // that has stopped heart-beating is indistinguishable from a live one by
    // pid alone. The lease is what bounds both.
    announceExternal();
    clockMs += TUNNEL_LEASE_MS + 1;
    expect(tunnelBaseUrl(db, live)).toBeNull();
  });

  it('a heartbeat renews the lease', () => {
    announceExternal();
    clockMs += TUNNEL_LEASE_MS - 1;
    announceExternal(); // the 30s re-announce
    clockMs += TUNNEL_LEASE_MS - 1;
    expect(tunnelBaseUrl(db, live)).toBe(FIRST);
  });

  it('a retraction keeps the CLAIM, so no rival tunnel starts during backoff', async () => {
    // cloudflared died and the runner is waiting to restart it. The url must go
    // (that is the original bug) but the runner is still alive and still owns
    // the tunnel — if the claim went too, the next publish would start a SECOND
    // cloudflared inside a pane and there would be two public doors.
    announceExternal();
    noteTunnelDown(db, {
      error: 'cloudflared exited (code 1) after 2s',
      attempts: 1,
      pid: RUNNER_PID,
    });
    expect(tunnelBaseUrl(db, live)).toBeNull();
    expect(externalTunnelOwner(db, live)?.pid).toBe(RUNNER_PID);

    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      liveness: live,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)).toBeNull();
  });

  it('stands down and does not wipe the external record', async () => {
    announceExternal();
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      liveness: live,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(res.reason).toContain('dev.muxpad.tunnel');
    // The stand-down must not take the url with it: `disable()` retracts, and
    // retracting somebody else's live tunnel would blank every published link.
    expect(tunnelBaseUrl(db, live)).toBe(FIRST);
  });

  it('STOPS an app-managed tunnel when an external one appears — the install path', async () => {
    // The user has been living on the in-pane tunnel; they install the launchd
    // job. Two cloudflareds would then be dialling Cloudflare, and the app one
    // would keep rotating its name on every deploy.
    const { paneId } = await bringUp(FIRST);
    expect(tunnelBaseUrl(db)).toBe(FIRST);

    announceExternal(SECOND);
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      liveness: live,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(false);
    expect(panes.getById(paneId)).toBeFalsy();
    expect(tunnelBaseUrl(db, live)).toBe(SECOND);
  });

  it('a DEAD external claim does not block the app tunnel', async () => {
    // The launchd job was booted out, or the machine rebooted into a build
    // without it. muxpad must go back to managing its own tunnel rather than
    // standing down forever in deference to a process that no longer exists.
    announceExternal();
    alivePids.delete(RUNNER_PID);
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      cwd: '/tmp',
      liveness: live,
      log: () => {},
    });
    expect(res.state).toBe('started');
    expect(apps.getBySlug(TUNNEL_APP_SLUG)?.enabled).toBe(true);
  });

  it('MUXPAD_PUBLIC_BASE_URL still outranks it', async () => {
    // A future named tunnel on the user's own domain has to drop in without
    // another rewrite, and `env` cancels the tunnel rather than merely
    // out-ranking it. muxpad cannot stop a launchd job, so what it does here is
    // forget the url; the runner is told `wanted: false` on its next announce
    // and shuts itself down (tunnel/run.ts).
    announceExternal();
    const res = await ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      configuredBaseUrl: 'https://artifacts.example.com',
      findBin: () => '/x/cloudflared',
      liveness: live,
      log: () => {},
    });
    expect(res.state).toBe('disabled');
    expect(res.reason).toContain('MUXPAD_PUBLIC_BASE_URL');
    expect(readTunnelRecord(db)).toBeNull();
  });

  it('a url-less claim is not a base', () => {
    // The runner claims the tunnel BEFORE cloudflared has a hostname, so a
    // publish in those four seconds cannot start a rival. A claim is ownership,
    // never an answer.
    expect(noteTunnelClaim(db, { pid: RUNNER_PID, now: clockMs })).toBe(true);
    expect(tunnelBaseUrl(db, live)).toBeNull();
    expect(externalTunnelOwner(db, live)?.pid).toBe(RUNNER_PID);
    expect(tunnelOwnerKind(db, live)).toBe('process');
  });

  it('clearOrphanedTunnelBase preserves a live claim that has no url yet', () => {
    noteTunnelClaim(db, { pid: RUNNER_PID, now: clockMs });
    expect(clearOrphanedTunnelBase(db, live)).toBe(false);
    expect(externalTunnelOwner(db, live)).not.toBeNull();
    // …and still deletes a dead one.
    alivePids.delete(RUNNER_PID);
    expect(clearOrphanedTunnelBase(db, live)).toBe(true);
    expect(readTunnelRecord(db)).toBeNull();
  });

  it('a record with neither a pane nor a pid is refused', () => {
    // Pre-existing behaviour, pinned: an announce with no ownership token at
    // all can never be served, because nothing could ever invalidate it.
    noteTunnelUp(db, { url: FIRST });
    expect(readTunnelRecord(db)?.url).toBe(FIRST);
    expect(tunnelBaseUrl(db, live)).toBeNull();
    expect(tunnelOwnerKind(db, live)).toBeNull();
  });

  it('a PANE-owned url is also dropped when its process is dead', async () => {
    // Strictly stronger than the pane check alone, which has a documented ~20s
    // hole: after a ptyd restart the pane ROW survives while the pty does not,
    // so the pane rule keeps serving the dead name until the supervisor
    // rebuilds it. The pid closes that window.
    const { paneId } = await bringUp(FIRST);
    noteTunnelUp(db, { url: FIRST, paneId, pid: RUNNER_PID, now: clockMs });
    expect(tunnelBaseUrl(db, live)).toBe(FIRST);
    alivePids.delete(RUNNER_PID);
    expect(tunnelBaseUrl(db, live)).toBeNull();
    // A pane owner is a pane owner, lease or no lease: the pane row is the
    // token, and it does not go stale on a clock.
    alivePids.add(RUNNER_PID);
    clockMs += TUNNEL_LEASE_MS * 10;
    expect(tunnelBaseUrl(db, live)).toBe(FIRST);
    expect(tunnelOwnerKind(db, live)).toBe('pane');
  });
});

describe('waitForTunnelUrl', () => {
  it('returns as soon as a url is announced', async () => {
    const { paneId } = await bringUp(FIRST);
    noteTunnelDown(db);
    const waiting = waitForTunnelUrl(db, { timeoutMs: 5_000, pollMs: 1 });
    setTimeout(() => noteTunnelUp(db, { url: SECOND, paneId }), 5);
    expect(await waiting).toBe(SECOND);
  });

  it('waits for the url to ANSWER, not merely to exist', async () => {
    // Cloudflare prints the hostname seconds before its edge will serve it.
    // Returning at the announce hands the resolver a name its probe then
    // demotes, so the publish prints the old dead base instead.
    await bringUp(FIRST);
    let answers = false;
    setTimeout(() => {
      answers = true;
    }, 5);
    const url = await waitForTunnelUrl(db, {
      timeoutMs: 5_000,
      pollMs: 1,
      ready: async () => answers,
    });
    expect(url).toBe(FIRST);
    expect(answers).toBe(true);
  });

  it('a timeout is null, not an error — the caller falls back down the chain', async () => {
    expect(await waitForTunnelUrl(db, { timeoutMs: 5, pollMs: 1 })).toBeNull();
  });
});
