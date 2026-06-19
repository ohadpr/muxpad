import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { WebSocket, WebSocketServer } from 'ws';
import type { EventBus } from './events.js';
import type { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { proxyAttach } from './ptyd-client/proxyAttach.js';
import { safeCwd } from './safe-cwd.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

export interface WsServerHandle {
  close(): Promise<void>;
}

export function attachWsServer(deps: {
  http: Server;
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  /** Liveness ping interval in ms. Defaults to 15s; tests pass a small value. */
  heartbeatMs?: number;
}): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);

  // Server-side liveness detection. A WebSocket severed abruptly (browser
  // hard-reload, crashed tab, network blip) does NOT fire 'close' until the
  // OS TCP timeout — minutes later. Until then the dead client stays on
  // ptyd's side, and a pane.kind flip can't clean up its bucket until the
  // 'close' eventually fires.
  //
  // Standard ws fix: ping every client on an interval; browsers answer
  // protocol-level pings with a pong automatically (the page never sees it).
  // Any client that missed the previous round gets terminated, which fires
  // 'close' → proxyAttach teardown.
  //
  // Note: ptyd runs its OWN heartbeat against its `/control` and `/pty/:id`
  // sockets. This heartbeat is independent — it's the main server detecting
  // browser-side ghosts on the WSes IT terminates.
  const HEARTBEAT_MS = deps.heartbeatMs ?? 15_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const live = client as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        live.terminate();
        continue;
      }
      live.isAlive = false;
      try {
        live.ping();
      } catch {
        // socket already closing; the next sweep (or 'close') cleans up.
      }
    }
  }, HEARTBEAT_MS);

  deps.http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // App-level event stream. One socket per browser; receives JSON-encoded
    // MuxpadEvent frames for structural state changes (panes/tabs/workspaces).
    // PTY I/O still goes through /ws/pane/:id below.
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Heartbeat participation: the sweep above pings every wss client.
        // Mark this socket alive on attach + pong so it doesn't get
        // terminated as a ghost on the next round.
        const live = ws as WebSocket & { isAlive?: boolean };
        live.isAlive = true;
        ws.on('pong', () => {
          live.isAlive = true;
        });
        const unsub = deps.events.subscribe((e) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
        });
        ws.on('close', unsub);
        ws.on('error', unsub);
      });
      return;
    }
    const match = url.pathname.match(/^\/ws\/pane\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const paneId = match[1] as string;
    const pane = panes.getById(paneId);
    if (!pane) {
      socket.destroy();
      return;
    }
    // URL panes have no PTY; reject upgrade before reaching ptyd
    // (ensurePane on a null shell would crash node-pty inside ptyd).
    if (pane.kind === 'url') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Liveness: mark alive on connect and on every pong. The heartbeat
      // sweep above flips this to false before each ping; a client that
      // doesn't pong before the next sweep is terminated as a ghost.
      const live = ws as WebSocket & { isAlive?: boolean };
      live.isAlive = true;
      ws.on('pong', () => {
        live.isAlive = true;
      });

      // pane.shell / pane.cwd are nullable on PaneSpec (URL panes), but
      // we've already rejected kind === 'url' upgrades above; fall back
      // defensively if a row is malformed.
      // Look up the tab's workspace_id so the spawned shell gets the
      // full identity env (MUXPAD_WORKSPACE_ID).
      const workspaceId = tabs.getWorkspaceId(pane.tab_id);

      // Issue ensurePane against ptyd before bridging. If ptyd is
      // disconnected, ensurePane rejects and we close the browser WS so
      // the client knows to retry. ensurePane is idempotent on ptyd's
      // side — repeated calls for the same id are no-ops.
      deps.ptyd
        .ensurePane({
          id: pane.id,
          shell: pane.shell ?? process.env.SHELL ?? '/bin/zsh',
          startup_cmd: pane.startup_cmd,
          cwd: safeCwd(pane.cwd),
          env: pane.env,
          tab_id: pane.tab_id,
          ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
        })
        .then(() => {
          // Race: the client may have already closed (e.g. tab nav)
          // while ensurePane was inflight. Skip the bridge in that case.
          if (ws.readyState !== WebSocket.OPEN) return;
          const replay = url.searchParams.get('replay') !== '0';
          proxyAttach({
            socketPath: deps.ptyd.socketPath,
            paneId: pane.id,
            browser: ws,
            replay,
            // Discount the echo the user's own typing produces from busy
            // detection (see PtydCache.noteInput / markBusy).
            onInput: () => deps.cache.noteInput(pane.id),
          });
        })
        .catch(() => {
          try {
            ws.close(1011, 'ptyd unavailable');
          } catch {
            // already closing
          }
        });
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => resolve());
      }),
  };
}
