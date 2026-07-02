import { encodeInput } from '@muxpad/shared';

/**
 * Send a short burst of input to a pane's PTY over a transient /ws/pane
 * connection (same binary protocol XtermPane uses). Used to type a command
 * into a pane's shell from outside the terminal view — e.g. "Resume in
 * terminal" relaunches `muxpad claude --resume <sid>` so a session driven
 * from chat can be picked back up in the real TUI.
 *
 * This is the WRITE side of the pane (deliberate, single action) — not the
 * fragile terminal-output scraping we avoid. `replay=0` skips the ring-buffer
 * replay we don't need for a fire-and-forget write.
 */
export function sendPaneInput(paneId: string, data: string): Promise<void> {
  return new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws/pane/${paneId}?replay=0`);
    } catch {
      done();
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      try {
        ws.send(encodeInput(data));
      } catch {
        // ignore
      }
      // Give the frame time to flush before closing.
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        done();
      }, 150);
    };
    ws.onerror = () => done();
  });
}
