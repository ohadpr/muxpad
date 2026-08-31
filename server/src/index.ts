import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createAgentBridge } from './agent-bridge.js';
import { seedAgentInstructions } from './agent-instructions.js';
import { seedDoMode } from './agent-modes.js';
import { createAppRegistry, startAppReconciler } from './apps/AppRegistry.js';
import { createAppStatusProbe } from './apps/AppStatus.js';
import { adoptServePanes } from './apps/adopt-serve-panes.js';
import { ArchiveDb } from './archive/ArchiveDb.js';
import { Archiver } from './archive/Archiver.js';
import { HeadlineWriter } from './chat/HeadlineWriter.js';
import { projectsDir } from './chat/TranscriptReader.js';
import { paneCarryover } from './chat/summarize.js';
import { loadConfig } from './config.js';
import { CronScheduler } from './cron/CronScheduler.js';
import { EventBus } from './events.js';
import { createTailscaleFunnel, localFunnel } from './funnel.js';
import { startPaneReaper } from './pane-reaper.js';
import { PtydCache, decoratePane, decorateTab } from './ptyd-cache.js';
import { PtydClient } from './ptyd-client/PtydClient.js';
import { createPublicApp } from './public-server.js';
import { Presence, PushService, attachAttentionPush, createPaneNotifier } from './push.js';
import { releaseResidentPane } from './resident-release.js';
import { seedNotice } from './seed-file.js';
import { startServeSupervisor } from './serve-supervisor.js';
import { createApp } from './server.js';
import { mountStaticWeb } from './static-assets.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { openDb } from './store/db.js';
import { TabActivity } from './tab-activity.js';
import { attachWsServer } from './ws.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
// Reconcile the two seeded, USER-OWNED prompt files against the defaults this
// build ships: <dataDir>/agent-instructions.md (injected into every agent
// session, whatever the backend) and <dataDir>/do-mode.md (injected only into
// panes in ⚡ Do mode). Pristine files are refreshed, edited ones are never
// touched — and when muxpad declines to touch one it SAYS so, exactly once per
// change of the shipped default. See seed-file.ts for the whole policy.
for (const outcome of [seedAgentInstructions(config.dataDir), seedDoMode(config.dataDir)]) {
  const notice = seedNotice(outcome);
  if (notice) console.log(notice);
}
const db = openDb(join(config.dataDir, 'db.sqlite'));
const paneStore = new PaneStore(db);
const tabStore = new TabStore(db);
// EventBus is shared by the route layer (HTTP-driven mutations) and the
// /ws/events upgrade arm (server/src/ws.ts) which fans events out to
// subscribed browsers.
const events = new EventBus();

// Connect to the (separately-managed) ptyd daemon. The main server no
// longer owns PTYs — it issues control RPCs and bridges WSes through
// proxyAttach. ptyd lifecycle (start/restart/launchd) is independent.
const ptyd = new PtydClient({ socketPath: config.ptydSocketPath });
const cache = new PtydCache();
cache.attach(ptyd);
// Prime the cache with last-known cwds from SQLite so handlers that read
// cache.getCwd() during the window between HTTP-start and ptyd's first
// `connected → flushCwds()` reply don't see null. A real event from ptyd
// supersedes the seed (seedCwds skips already-present ids).
cache.seedCwds(paneStore.listCwds());

// Persist cwds as ptyd reports them, so respawning a pane after a daemon
// restart lands in the shell's actual cwd instead of the spawn cwd.
ptyd.on('paneCwd', (e: { id: string; cwd: string }) => {
  paneStore.updateCwd(e.id, e.cwd);
});

// Living sidebar: `tabs.last_activity_at`. One recorder shared with the ws
// layer so the 60s throttle is per TAB, not per signal source. Raw pty output
// ticks land here (ptyd throttles them already, but a busy pane still emits
// several per second — hence the throttle); ws.ts adds the forced bumps for
// turn-done / user sends and the throttled one for keystrokes.
const tabActivity = new TabActivity(db, {
  // Recency changed → tell every open client now, instead of leaving the
  // reorder to their next 5s poll (which is stopped entirely for a collapsed
  // workspace or a hidden document). Already rate-limited by the recorder's
  // own throttle, so this is at most one event per tab per minute plus the
  // discrete forced bumps.
  onWrite: (tabId) => {
    const t = tabStore.getById(tabId);
    if (t) events.emit({ type: 'tab.updated', tab: decorateTab(cache, db, t) });
  },
});
ptyd.on('paneActivity', (e: { id: string }) => {
  tabActivity.touchPane(e.id);
});

// An EXPLICIT app-url declaration (`muxpad app-url` / `muxpad serve` — the
// OSC marker, not the output-scan heuristic) is the "this pane is a web app"
// signal: flip the pane's face to the web view, same pattern as an agent
// runner's first hello flipping to chat. Only on a NEW url — a redeclare
// (the serve wrapper announces on every restart of its loop) must not
// override a user who deliberately switched to the terminal face since.
ptyd.on(
  'paneUrlsSeen',
  (e: { id: string; urls: string[]; markers?: Array<{ url: string; label?: string }> }) => {
    const marker = e.markers?.[e.markers.length - 1];
    if (!marker) return;
    const pane = paneStore.getById(e.id);
    if (!pane || pane.kind !== 'shell') return;
    if (pane.face_url === marker.url) return; // redeclare — face choice stands
    paneStore.setFace(e.id, 'web', marker.url);
    const fresh = paneStore.getById(e.id);
    if (fresh) {
      events.emit({ type: 'pane.updated', tab_id: fresh.tab_id, pane: decoratePane(cache, fresh) });
    }
  },
);

// Whenever any of (title, fg, attention, busy) changes for a pane, push a
// decorated `pane.updated` event on the EventBus so /ws/events
// subscribers see the diff. The cache emits a single 'paneChange' per
// field-mutation; we rebuild the full decorated row from the cache + db.
cache.on('paneChange', (paneId: string) => {
  const pane = paneStore.getById(paneId);
  if (!pane) return;
  events.emit({
    type: 'pane.updated',
    tab_id: pane.tab_id,
    pane: decoratePane(cache, pane),
  });
});

// Dropping a pane's whole cache entry (pty exit) is ALSO a status change, and
// it had no subscriber at all. A pane that exited while its BEL was ringing
// went from `blocked` to `idle` in the cache with nothing telling anyone, so
// the tabbed strip kept its attention mark until the user navigated or a poll
// happened along. When the row is gone too (a real delete) getById returns
// null and the route layer's own `pane.removed` is the right event — say
// nothing here.
cache.on('paneRemoved', (paneId: string) => {
  const pane = paneStore.getById(paneId);
  if (!pane) return;
  events.emit({
    type: 'pane.updated',
    tab_id: pane.tab_id,
    pane: decoratePane(cache, pane),
  });
});

// Shared between the route layer (built now) and the ws layer (attached after
// the HTTP server exists) — ws.ts binds the real runner relay onto it.
const agentBridge = createAgentBridge();

// Web Push: notify subscribed devices (the installed PWA) when a pane's
// attention flag rises. Requires the app to be reached over https (e.g.
// `tailscale serve`) — over plain http the client never subscribes and
// this sits dormant.
const push = new PushService(db, config.dataDir);
// Active-device presence: /api/presence heartbeats mark it; notifiers hold
// pushes while any device is active (see Presence / createPaneNotifier).
const presence = new Presence();
attachAttentionPush({
  events,
  db,
  push,
  presence,
  liveLabel: (id) => ({ title: cache.getTitle(id), fg: cache.getFg(id) }),
});

// Session archive: raw transcript mirrors + FTS5 index in a SEPARATE
// archive.sqlite (the index dwarfs the operational DB and FTS churn must not
// share the WAL the UI reads). All paths derive from config.dataDir so an
// isolated instance stays sandboxed; the Claude projects dir respects
// CLAUDE_CONFIG_DIR the same way TranscriptReader does.
// A corrupt/unopenable archive.sqlite must degrade to "archiving disabled",
// never kill the whole server at boot — the archive is an accessory to the
// cockpit, not a dependency of it.
let archiveDb: ArchiveDb | undefined;
try {
  archiveDb = new ArchiveDb(join(config.dataDir, 'archive.sqlite'));
} catch (err) {
  console.error('[archive] failed to open archive.sqlite — archiving disabled', err);
}
const archiver = archiveDb
  ? new Archiver({
      archive: archiveDb,
      archiveDir: join(config.dataDir, 'archive'),
      claudeProjectsDir: projectsDir(),
      muxpadTranscriptsDir: join(config.dataDir, 'agent-transcripts'),
      db,
      events,
    })
  : undefined;

// The nav rail's second line. Subscribes to turn-end on the same bus the
// archiver uses and hands each finished turn to a rate-limited haiku one-shot
// (chat/headline.ts owns every decision about whether to spend a call).
// Unconditional, unlike the archiver: it has no store of its own to fail to
// open, and it degrades to "no second line" on every error by contract.
const headlines = new HeadlineWriter({ db, events, cache });

// Funnel manager for `POST /api/publish` — ensures the PUBLIC port (never
// the main UI port, which is unauthenticated) is funneled to the internet.
// MUXPAD_NO_FUNNEL=1 (isolated/test instances) swaps in an exec-free stub.
const funnel = config.funnelEnabled
  ? createTailscaleFunnel({ publicPort: config.publicPort })
  : localFunnel(config.publicPort, 'funnel disabled (MUXPAD_NO_FUNNEL=1)');

// The cron scheduler. Built BEFORE createApp (the routes need its store) but
// after the agentBridge, whose late-bound accessors it reads — every injection
// still goes through the ws layer's single `submitSend`, exactly like an HTTP
// send. Its tick doesn't start until `start()` below, after the ws layer is
// attached, so a fire can never race the registry into existence.
const cronScheduler = new CronScheduler({
  db,
  ptyd,
  cache,
  events,
  tabActivity,
  submitSend: (paneId, text) => agentBridge.submitSend(paneId, text),
  turnActive: (paneId) => agentBridge.turnActive(paneId),
  contextPct: (paneId) => agentBridge.contextPct(paneId),
  lastHumanSendAt: (paneId) => agentBridge.lastSendAt(paneId),
  slash: (paneId, cmd) => agentBridge.slash(paneId, cmd),
  blocked: (paneId) => agentBridge.blocked(paneId),
  notify: (title, body) => {
    void push.send({ title, body, url: '/', tag: 'cron' });
  },
  // Rotation handoff: summarize the pane whose window filled up, so the fresh
  // tab starts briefed instead of amnesiac. Swappable by design — a future
  // per-chat dossier replaces this one line.
  carryover: (paneId) => paneCarryover(db, paneId),
});

// Hosted APPS (`muxpad app`): supervised `muxpad serve` panes in a hidden
// workspace, so a long-running local web server stops costing a permanent tab.
// The registry only creates/destroys the pane; keeping it ALIVE is the serve
// supervisor's job below, which is why there is no second process supervisor
// here — one dying with the main server would take every app down on deploy.
const appRegistry = createAppRegistry({ db, ptyd, events });
// Late-bound so the status probe can read the supervisor's give-up ledger:
// the supervisor is constructed after the ws layer, and the probe is needed
// before it, by createApp.
let serveSupervisorRef: { gaveUp(paneId: string): boolean } | null = null;
const appStatus = createAppStatusProbe({
  db,
  ptyd,
  gaveUp: (paneId) => serveSupervisorRef?.gaveUp(paneId) ?? false,
});

const app = createApp({
  db,
  ptyd,
  cache,
  dataDir: config.dataDir,
  events,
  agentBridge,
  tabActivity,
  push,
  presence,
  cronScheduler,
  ...(archiveDb ? { archive: archiveDb } : {}),
  publish: {
    funnel,
    publicPort: config.publicPort,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
  },
  apps: { registry: appRegistry, status: appStatus },
});

// Static asset serving (CSS, JS, fonts, images) from the built web bundle,
// plus the SPA fallback. Caching/compression policy lives in static-assets.ts.
const here = dirname(fileURLToPath(import.meta.url));
mountStaticWeb(app, join(here, '..', '..', 'web', 'dist'));

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`muxpad listening on http://${info.address}:${info.port}`);
});

// The public artifact server: a SECOND listener that serves nothing but
// static files from <dataDir>/public (see public-server.ts). This — and only
// this — port is what Tailscale Funnel exposes to the internet. Loopback by
// default: the funnel proxies to 127.0.0.1, nothing else needs it.
const publicDir = join(config.dataDir, 'public');
mkdirSync(publicDir, { recursive: true });
const publicApp = createPublicApp(publicDir);
const publicServer = serve(
  { fetch: publicApp.fetch, port: config.publicPort, hostname: config.publicHost },
  (info) => {
    console.log(`muxpad public artifacts on http://${info.address}:${info.port}`);
  },
) as unknown as Server;
// The public listener is an accessory (like archiving): an isolated instance
// that overrode the main port but not MUXPAD_PUBLIC_PORT would otherwise
// crash on EADDRINUSE against a live daemon. Log and carry on — publish
// still works, the artifacts are just unservable from this instance.
publicServer.on('error', (err) => {
  console.error(`[public] listener failed (${String(err)}) — public serving disabled`);
});

const httpServer = server as unknown as Server;
// Chat-runner turn-done / question frames don't ring BEL — push them here.
// Shared with the serve supervisor, which uses it to announce an app server
// it has given up restarting.
// The live-label resolver lets the notification TITLE name the pane that rang
// ("claude · muxpad"), not just its tab — the pty title/foreground command are
// runtime-only, so they have to come from the cache.
const notifyPane = createPaneNotifier(db, push, presence, (id) => ({
  title: cache.getTitle(id),
  fg: cache.getFg(id),
}));
const wsServer = attachWsServer({
  http: httpServer,
  db,
  ptyd,
  cache,
  events,
  agentBridge,
  tabActivity,
  notifyPane,
});

// Straggler prevention: retry pane kills that failed in transit, and (once
// ptyd supports listPanes) kill any live pty whose DB row is gone.
startPaneReaper({ db, ptyd, paneExists: (id) => paneStore.getById(id) !== null });

// Supervision for `muxpad serve` panes. ws.ts's sweep only knows about agent
// panes, so before this an app server whose pty vanished (ptyd restart, reboot)
// stayed down forever — its pty is only created lazily on a terminal attach,
// which never happens for a pane the user watches through its web face.
// Same rails as the agent sweep (respawn-policy.ts); see serve-supervisor.ts.
const serveSupervisor = startServeSupervisor({
  db,
  ptyd,
  cache,
  events,
  notifyPane,
  onPtydConnected: (fn) => {
    ptyd.on('connected', fn);
    return () => {
      ptyd.off('connected', fn);
    };
  },
});
serveSupervisorRef = serveSupervisor;

// One-shot: adopt the pre-registry `muxpad serve` panes (Notes, Reader) into
// the app registry and free their tabs. Non-destructive and behind a globals
// marker — see apps/adopt-serve-panes.ts. Best-effort: a failure here must not
// stop the server booting.
try {
  // The registry (built above) owns "which workspace do apps live in", so
  // adoption borrows its resolver instead of re-implementing it.
  const adopted = adoptServePanes({ db, events, cache, containerId: appRegistry.containerId });
  for (const line of adopted.log) console.log(`[apps/adopt] ${line}`);
} catch (err) {
  console.error('[apps/adopt] one-time adoption failed (harmless; retried next boot)', err);
}

// Bring registered apps up: a boot pass (which honours autostart=0 by leaving
// those apps honestly stopped rather than enabled-but-paneless), then a slow
// repair interval plus a pass on every ptyd (re)connect. This only creates and
// destroys PANES — keeping a pty alive is the serve supervisor's job above.
const appReconciler = startAppReconciler({
  db,
  ptyd,
  events,
  registry: appRegistry,
  onPtydConnected: (fn) => {
    ptyd.on('connected', fn);
    return () => {
      ptyd.off('connected', fn);
    };
  },
});

// Durable schedules. The tick starts only now, with the ws layer attached and
// the runner registry live behind the bridge; its own 15s startup grace then
// keeps the first pass from firing before runners have re-registered after a
// restart (which would land as a wave of rejections + fail streaks).
cronScheduler.start();

// Session archiver: boot backfill sweep (background, throttled reads) +
// 15-min re-sweep + near-realtime triggers off the event bus (turn-done,
// sid changes). See docs/plans/2026-08-28-session-archive.md.
archiver?.start();
headlines.start();

// The "resident pane" primitive is retired — muxpad no longer creates or
// guards a singleton agent pane. An always-there chat is now just a chat you
// PIN (see the living sidebar's pinned block). This one-time sweep hands any
// pane stranded in the old hidden system workspace back to a visible one, so
// nothing is orphaned; it never deletes a pane or its history. Best-effort:
// a failure here must not stop the server booting.
try {
  const released = releaseResidentPane({ db, events, cache });
  if (released.released) {
    console.log(
      `[resident] released the retired system workspace (${released.movedTabIds.length} tab(s) moved)`,
    );
  }
} catch (err) {
  console.error('[resident] one-time release failed (harmless; retried next boot)', err);
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down…');
  // Stop queueing archive work; in-flight copies finish or resume next boot
  // (offsets only advance past complete lines, so a cut mid-copy is safe).
  archiver?.stop();
  // Stop the cron tick — anything it started now would be an orphan.
  cronScheduler.stop();
  // Stop respawning app servers — we're on our way out; anything we started
  // here would just be an orphan for the next boot's supervisor to adopt.
  serveSupervisor.stop();
  // Same for the app reconciler: a pass landing now would materialise panes
  // for a server that is going away.
  appReconciler.stop();
  // Close browser-facing WSes first so they don't see ptyd's `close` (which
  // is going to follow as we disconnect the control channel) as a PTY-exit.
  //
  // IMPORTANT: `wsServer.close()` uses `terminate()` (not `ws.close(1000)`)
  // on remaining clients, which surfaces as a 1006 abnormal close on the
  // browser. The client treats 1006 as transient (its reconnect path
  // re-attaches when the server comes back) rather than as a natural shell
  // exit. Do NOT "clean this up" to `close(1000)` — the client would
  // interpret 1000 as the shell having exited and DELETE the pane from the
  // layout. The asymmetry is load-bearing.
  await wsServer.close();
  // Disconnect from ptyd. CRITICALLY we do NOT call killAll — that is
  // precisely the point of the split. ptyd outlives the main server and
  // keeps PTYs warm across main-server restarts.
  await ptyd.close();
  // Force keep-alive HTTP sockets to drop so server.close()'s callback fires.
  publicServer.closeAllConnections();
  publicServer.close();
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
  // Belt-and-suspenders: hard exit if anything still pins the loop after 5s.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
