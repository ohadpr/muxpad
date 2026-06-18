import { OP_INPUT, OP_RESIZE } from '@muxpad/shared';
import WebSocket from 'ws';

// Mirror of the web client's resize-send floor (MIN_COLS/MIN_ROWS in
// XtermPane). A well-behaved client never sends dims below this — its own
// fit paths refuse to. Frames below the floor can only come from a buggy
// or stale client measuring a degenerate viewport (observed in the wild: a
// backgrounded iOS Safari running an old bundle SIGWINCH-stormed every
// pane to 8x4, blanking the terminals on every other device). ptyd itself
// can't cheaply gain this guard — restarting it kills every live PTY — so
// the long-lived-session-safe place to drop these frames is this proxy.
// Must stay below any legitimate device size: a large-font phone fits
// ~36-39 cols, so 40 here would eat real mobile resizes.
const MIN_COLS = 20;
const MIN_ROWS = 5;

/** True for a client resize frame whose dims are below the sanity floor. */
function isSubFloorResize(data: WebSocket.RawData): boolean {
  // Runs on every browser→ptyd frame (keystrokes included) — only coerce
  // to a Buffer for the rare non-Buffer shapes; never copy the hot path.
  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  if (buf.length < 5 || buf[0] !== OP_RESIZE) return false;
  const cols = buf.readUInt16BE(1);
  const rows = buf.readUInt16BE(3);
  return cols < MIN_COLS || rows < MIN_ROWS;
}

/** True for a client keystroke (OP_INPUT) frame — i.e. the user typing, as
 *  opposed to a resize (OP_RESIZE) or heartbeat (OP_PING). */
function isInputFrame(data: WebSocket.RawData): boolean {
  // For a real Buffer (the hot path) this is just an index read, no copy.
  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return buf.length >= 1 && buf[0] === OP_INPUT;
}

export interface ProxyAttachOptions {
  /** Absolute path to the ptyd unix socket. */
  socketPath: string;
  /** Pane id; becomes the `/pty/<id>` path on ptyd. */
  paneId: string;
  /**
   * Forward ring-buffer replay on attach. False when the browser client
   * reconnects with an intact xterm (see `?replay=0` on /ws/pane/:id).
   */
  replay?: boolean | undefined;
  /**
   * The browser-facing WS. Already OPEN (the caller is the upgrade handler
   * that just `handleUpgrade`'d the inbound request). proxyAttach does NOT
   * close this on construction failure — failures emerge via the 'close'
   * event with the appropriate code.
   */
  browser: WebSocket;
  /**
   * Called once per user keystroke (OP_INPUT) frame forwarded to ptyd. Lets the
   * main server mark "the user is interacting with this pane" so the busy
   * indicator can ignore the echo their typing produces (which is otherwise
   * indistinguishable from the app doing work). Resize/ping frames don't fire it.
   */
  onInput?: (() => void) | undefined;
}

export interface ProxyAttachHandle {
  /**
   * Force-close both sides of the bridge. Idempotent — a second call
   * is a no-op. Useful for cooperative shutdown paths (e.g. WsServer.close
   * tearing down every attached pane socket on process exit).
   */
  close(): void;
}

/**
 * Byte-level bridge between a browser-facing WS and a fresh ptyd `/pty/:id`
 * attach. Forwards every `'message'` event in both directions without
 * decoding the binary frame protocol — proxyAttach is deliberately ignorant
 * of `encodeOutput` / `decodeClientMessage` etc., so adding new frame kinds
 * is transparent here.
 *
 * Close-code propagation: when the ptyd side closes (PTY exit → 1000;
 * closePtyClients RPC → 4001; pane-not-found → 4404), we mirror the code
 * and reason onto the browser WS so the existing client-side semantics
 * (auto-reconnect vs explicit detach) keep working unchanged.
 *
 * Browser→ptyd messages that arrive before the ptyd WS reaches OPEN are
 * dropped. Today this is unobservable in practice because the existing
 * client protocol resends `resize` on (re)open and input frames are
 * user-driven (no input until cursor / focus, which is well after the
 * upstream handshake). If we ever need ordered delivery from frame zero,
 * swap the gate for a queue+flush in this function — no other code needs
 * to change.
 */
export function proxyAttach(opts: ProxyAttachOptions): ProxyAttachHandle {
  const { socketPath, paneId, browser, replay = true, onInput } = opts;
  const replayQ = replay ? '' : '?replay=0';
  const ptyd = new WebSocket(`ws+unix://${socketPath}:/pty/${paneId}${replayQ}`);
  // ptyd sends binary frames; match the default behavior of the existing
  // /ws/pane/:id endpoint so .send forwards Buffers verbatim without any
  // text conversion on either side.
  ptyd.binaryType = 'nodebuffer';

  let closed = false;

  const safeSend = (target: WebSocket, data: WebSocket.RawData): void => {
    if (target.readyState !== WebSocket.OPEN) return;
    try {
      target.send(data);
    } catch {
      // Either side may transition to CLOSING between the readyState check
      // and send; ignore — 'close' will drive cleanup.
    }
  };

  ptyd.on('message', (data: WebSocket.RawData) => {
    safeSend(browser, data);
  });

  browser.on('message', (data: WebSocket.RawData) => {
    // Backstop: never forward a degenerate resize to the PTY (see
    // isSubFloorResize above). Logged so a misbehaving client is
    // diagnosable from server.log instead of silently shrinking panes.
    if (isSubFloorResize(data)) {
      console.warn(`[resize-floor] pane=${paneId} dropped sub-floor resize frame`);
      return;
    }
    // Note user keystrokes so the busy indicator can discount the echo they
    // produce (see PtydCache.noteInput). Resize/ping frames don't count.
    if (onInput && isInputFrame(data)) onInput();
    // Drop instead of queue if ptyd isn't open yet — the existing protocol
    // is resilient to this (clients resend resize on open) and the
    // alternative (queue + flush) is unnecessary complexity. See header.
    safeSend(ptyd, data);
  });

  // Lifecycle:
  //  - ptyd close → mirror onto browser so 1000/4001/4404 semantics propagate
  //  - browser close → close ptyd with a clean 1000 so attachPty's cleanup
  //    (runtime listener removal, paneSockets bucket eviction) runs
  // Either direction's 'close' marks `closed = true`, making the call to
  // the other side a no-op if it was triggered from this path.
  ptyd.on('close', (code: number, reason: Buffer) => {
    if (closed) return;
    closed = true;
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
      try {
        browser.close(code, reason.toString('utf8'));
      } catch {
        // already closing; ignore
      }
    }
  });

  browser.on('close', () => {
    if (closed) return;
    closed = true;
    if (ptyd.readyState === WebSocket.OPEN || ptyd.readyState === WebSocket.CONNECTING) {
      try {
        ptyd.close(1000);
      } catch {
        // already closing; ignore
      }
    }
  });

  // Swallow errors on both sides — 'close' is guaranteed to follow and
  // drives cleanup. Without these listeners ws would crash the process on
  // a single transient socket failure (e.g. ptyd crashes mid-attach).
  ptyd.on('error', () => {
    // intentionally empty
  });
  browser.on('error', () => {
    // intentionally empty
  });

  return {
    close(): void {
      if (closed) return;
      closed = true;
      try {
        ptyd.close(1000);
      } catch {
        // ignore
      }
      try {
        browser.close(1000);
      } catch {
        // ignore
      }
    },
  };
}
