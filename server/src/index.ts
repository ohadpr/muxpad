import { mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { createAgentBridge } from './agent-bridge.js';
import { seedAgentInstructions } from './agent-instructions.js';
import { ArchiveDb } from './archive/ArchiveDb.js';
import { Archiver } from './archive/Archiver.js';
import { ensureCeoPane, ensureCeoRuntime } from './ceo.js';
import { projectsDir } from './chat/TranscriptReader.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { createTailscaleFunnel, localFunnel } from './funnel.js';
import { startPaneReaper } from './pane-reaper.js';
import { PtydCache, decoratePane } from './ptyd-cache.js';
import { PtydClient } from './ptyd-client/PtydClient.js';
import { createPublicApp } from './public-server.js';
import { Presence, PushService, attachAttentionPush, createPaneNotifier } from './push.js';
import { createApp } from './server.js';
import { PaneStore } from './store/PaneStore.js';
import { openDb } from './store/db.js';
import { attachWsServer } from './ws.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
// Seed the universal agent instructions file (<dataDir>/agent-instructions.md)
// — write-once, user-owned afterwards; every agent backend injects it into new
// sessions (see agent-instructions.ts for the per-backend mechanisms).
seedAgentInstructions(config.dataDir);
const db = openDb(join(config.dataDir, 'db.sqlite'));
const paneStore = new PaneStore(db);
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
attachAttentionPush({ events, db, push, presence });

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

// Funnel manager for `POST /api/publish` — ensures the PUBLIC port (never
// the main UI port, which is unauthenticated) is funneled to the internet.
// MUXPAD_NO_FUNNEL=1 (isolated/test instances) swaps in an exec-free stub.
const funnel = config.funnelEnabled
  ? createTailscaleFunnel({ publicPort: config.publicPort })
  : localFunnel(config.publicPort, 'funnel disabled (MUXPAD_NO_FUNNEL=1)');

const app = createApp({
  db,
  ptyd,
  cache,
  dataDir: config.dataDir,
  events,
  agentBridge,
  push,
  presence,
  ...(archiveDb ? { archive: archiveDb } : {}),
  publish: { funnel },
});

// Static asset serving (CSS, JS, images, etc.) from the built web bundle.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web', 'dist');

// The HTML shell must be served `no-cache` so the browser ALWAYS revalidates it
// and picks up a rebuilt bundle's new hashed asset names. Assets themselves are
// content-hashed (immutable) and keep serveStatic's cacheable headers — only the
// index.html entrypoint is the stale-after-rebuild trap. Without this, a reload
// can keep serving an old index.html that references the pre-rebuild CSS/JS.
const serveIndexHtml = (c: Context) => {
  c.header('Cache-Control', 'no-cache');
  try {
    return c.html(readFileSync(join(webRoot, 'index.html'), 'utf-8'));
  } catch {
    return c.text('not found', 404);
  }
};
app.get('/', serveIndexHtml);
// Direct /index.html requests must not slip through to serveStatic either —
// that would hand the shell back with cacheable headers, the exact trap the
// no-cache route exists to close.
app.get('/index.html', serveIndexHtml);

app.use('/*', serveStatic({ root: webRoot }));

// Anything that fell through both API routes and static files lands here.
// API/WS paths return JSON 404 so the client can parse them; everything else
// is treated as a client-side SPA route and gets index.html.
//
// Read index.html fresh on each fallback request — caching it in memory means
// a rebuild that produces a new hashed bundle name still serves the old HTML,
// which then 404s on its asset references. The file is ~1KB and the SPA
// fallback is rare relative to static-asset hits, so the cost is negligible.
//
// Asset paths (/assets/*) and any path with a file extension must NEVER fall
// back to index.html — serving HTML with a JS or CSS Content-Type triggers
// the browser's MIME-type sniffing and breaks module loading. Those return
// a real 404 instead.
app.notFound((c) => {
  const path = c.req.path;
  if (path.startsWith('/api/') || path.startsWith('/ws/')) {
    return c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);
  }
  if (path.startsWith('/assets/') || /\.[a-zA-Z0-9]+$/.test(path)) {
    return c.text('not found', 404);
  }
  // SPA client route (e.g. /w/:ws/t/:tab) → the no-cache HTML shell.
  return serveIndexHtml(c);
});

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
const wsServer = attachWsServer({
  http: httpServer,
  db,
  ptyd,
  cache,
  events,
  agentBridge,
  // Chat-runner turn-done / question frames don't ring BEL — push them here.
  notifyPane: createPaneNotifier(db, push, presence),
});

// Straggler prevention: retry pane kills that failed in transit, and (once
// ptyd supports listPanes) kill any live pty whose DB row is gone.
startPaneReaper({ db, ptyd, paneExists: (id) => paneStore.getById(id) !== null });

// Session archiver: boot backfill sweep (background, throttled reads) +
// 15-min re-sweep + near-realtime triggers off the event bus (turn-done,
// sid changes). See docs/plans/2026-08-28-session-archive.md.
archiver?.start();

// The singleton CEO pane: hidden system workspace → 'ceo' tab → agent pane,
// created once, resolved via globals pointers, eagerly spawned so it's alive
// with zero browsers open. Idempotent; GET /api/ceo also ensures on demand.
// On a cold boot the server can beat ptyd to its socket and the eager spawn
// fails — re-run it on every ptyd (re)connect so the CEO comes alive within
// seconds instead of waiting on the ~50s dead-runner sweep. Listener is
// registered BEFORE the ensure so a connect landing mid-ensure isn't missed
// (ensureCeoRuntime quietly no-ops until the rows exist).
ptyd.on('connected', () => {
  void ensureCeoRuntime({ db, ptyd });
});
ensureCeoPane({ db, ptyd, events, dataDir: config.dataDir }).catch((err) => {
  console.error('[ceo] ensure failed at boot', err);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down…');
  // Stop queueing archive work; in-flight copies finish or resume next boot
  // (offsets only advance past complete lines, so a cut mid-copy is safe).
  archiver?.stop();
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
