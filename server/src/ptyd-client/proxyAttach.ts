import WebSocket from 'ws';

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
  const { socketPath, paneId, browser, replay = true } = opts;
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
