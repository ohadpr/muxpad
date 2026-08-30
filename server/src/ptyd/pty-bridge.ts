import {
  decodeClientMessage,
  encodeError,
  encodeExit,
  encodeOutput,
  encodePong,
  inkReplayPayload,
} from '@muxpad/shared';
import { ulid } from 'ulid';
import type { WebSocket } from 'ws';
import { WebSocket as WS } from 'ws';
import type { PaneRuntime } from '../runtime/PaneRuntime.js';

/**
 * Attach a per-pane WebSocket to a live PaneRuntime. Speaks the same binary
 * frame protocol as the main server's old `/ws/pane/:id` endpoint (see
 * `shared/ws-protocol.ts`):
 *
 *   - server→client: encodeOutput, encodeExit, encodeError, encodePong
 *   - client→server: input, resize, ping
 *
 * The caller (ptyd's upgrade handler) is responsible for:
 *   - validating the pane id and ensuring the runtime exists (this fn
 *     assumes `runtime` is non-null and started)
 *   - tracking the socket in `paneSockets` so a future `closePtyClients`
 *     RPC (Task 2.5) can force-close all attachments for a pane id
 *   - liveness heartbeats (the wss-wide ping sweep in `startPtyd`)
 *
 * This file deliberately doesn't touch the DB or PaneStore — ptyd has no
 * SQL access. The full PaneRuntimeSpec was already supplied via the
 * `ensurePane` control RPC before this attach was opened.
 */
export function attachPty(opts: {
  ws: WebSocket;
  runtime: PaneRuntime;
  paneId: string;
  paneSockets: Map<string, Set<WebSocket>>;
  /**
   * When false, skip the ring-buffer snapshot on attach. Used when the
   * browser reconnects to an xterm that already has the session painted —
   * replaying would duplicate output and jerk Ink TUIs to the bottom.
   * Fresh mounts (new tab / page reload) must leave this true (default).
   */
  replay?: boolean | undefined;
}): void {
  const { ws, runtime, paneId, paneSockets, replay = true } = opts;

  // Bucket the socket by paneId so a future closePtyClients RPC (Task 2.5)
  // can iterate every attachment for a given pane and force-close them.
  // The 'close' handler below removes us from the bucket.
  let bucket = paneSockets.get(paneId);
  if (!bucket) {
    bucket = new Set();
    paneSockets.set(paneId, bucket);
  }
  bucket.add(ws);

  const clientId = ulid();

  // Liveness: mark alive on attach + on every pong. The wss-wide heartbeat
  // in startPtyd flips this to false before each ping; a client that
  // doesn't pong before the next sweep is terminated as a ghost.
  const live = ws as WebSocket & { isAlive?: boolean };
  live.isAlive = true;
  ws.on('pong', () => {
    live.isAlive = true;
  });

  const send = (frame: Uint8Array) => {
    if (ws.readyState === WS.OPEN) ws.send(frame);
  };

  // Replay ring buffer so fresh clients see their backlog before any new
  // output streams in. Reconnecting clients that kept their xterm instance
  // pass replay=false (?replay=0) to avoid duplicating output.
  if (replay) {
    const snapshot = runtime.snapshot();
    const payload = inkReplayPayload(snapshot);
    if (payload.length) send(encodeOutput(payload));
  }

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
      else if (msg.kind === 'ping') send(encodePong());
    } catch (err) {
      send(encodeError(String(err)));
    }
  });

  ws.on('error', () => {
    // 'close' fires alongside; cleanup happens there. Swallow here so an
    // error on a single attach doesn't crash the daemon.
  });

  ws.on('close', () => {
    runtime.off('output', onOutput);
    runtime.off('exit', onExit);
    runtime.removeClient(clientId);
    const b = paneSockets.get(paneId);
    if (b) {
      b.delete(ws);
      if (b.size === 0) paneSockets.delete(paneId);
    }
  });
}
