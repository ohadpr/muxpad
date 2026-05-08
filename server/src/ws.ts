import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import {
  decodeClientMessage,
  encodeOutput,
  encodeExit,
  encodeError,
} from '@muxpad/shared';
import type { PaneManager } from './runtime/PaneManager.js';
import { PaneStore } from './store/PaneStore.js';

export interface WsServerHandle {
  close(): Promise<void>;
}

export function attachWsServer(deps: {
  http: Server;
  db: Database.Database;
  paneManager: PaneManager;
}): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const panes = new PaneStore(deps.db);

  deps.http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      const runtime = deps.paneManager.getOrCreate({
        id: pane.id,
        shell: pane.shell,
        startup_cmd: pane.startup_cmd,
        cwd: pane.cwd,
        env: pane.env,
      });
      const clientId = ulid();

      const send = (frame: Uint8Array) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      };

      // Replay ring buffer.
      const snapshot = runtime.snapshot();
      if (snapshot.length) send(encodeOutput(snapshot));

      const onOutput = (data: string) => send(encodeOutput(data));
      const onExit = (code: number) => {
        send(encodeExit(code, runtime.getExitCause()));
        // Closing the WS lets the client decide: explicit exit (kill via UI,
        // shell exit) → don't reconnect; transient close → reconnect.
        try {
          ws.close(1000, 'pty exited');
        } catch {
          // Already closing; ignore.
        }
      };
      runtime.on('output', onOutput);
      runtime.on('exit', onExit);

      ws.on('message', (data: Buffer) => {
        try {
          const msg = decodeClientMessage(new Uint8Array(data));
          if (msg.kind === 'input') runtime.write(msg.data);
          else if (msg.kind === 'resize') runtime.setClientSize(clientId, msg.cols, msg.rows);
        } catch (err) {
          send(encodeError(String(err)));
        }
      });

      ws.on('close', () => {
        runtime.off('output', onOutput);
        runtime.off('exit', onExit);
        runtime.removeClient(clientId);
      });
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
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
