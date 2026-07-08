import { encodeInput } from '@muxpad/shared';

/**
 * Send a short burst of input to a pane's PTY over a transient /ws/pane
 * connection (same binary protocol XtermPane uses). Used to type into a
 * pane from outside the terminal view — e.g. the agent handoff types its
 * instruction into the running Claude TUI.
 *
 * Two hard-won timing rules live here:
 *
 * 1. proxyAttach DROPS browser→ptyd frames that arrive before its ptyd leg
 *    opens (documented there; interactive clients never notice because a
 *    human's first keystroke comes long after). A transient socket that
 *    sends on 'open' races that window and loses often. So we attach WITH
 *    replay (the ring-buffer replay is the "bridge is up" signal) and only
 *    send after the first server frame — with a timer fallback for a pane
 *    whose buffer is empty.
 *
 * 2. `sendPaneMessage` submits text to a TUI as two frames: the text, then
 *    a lone '\r' a beat later — a big single chunk ending in newline can be
 *    treated as a PASTE by TUI input editors (newline inserted, nothing
 *    submitted).
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
      ws = new WebSocket(`${proto}//${location.host}/ws/pane/${paneId}`);
    } catch {
      done();
      return;
    }
    ws.binaryType = 'arraybuffer';
    let sent = false;
    const sendNow = () => {
      if (sent) return;
      sent = true;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(encodeInput(data));
        } catch {
          // ignore — fire and forget
        }
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
    ws.onopen = () => {
      // First frame from the server (ring-buffer replay) proves the
      // server↔ptyd bridge is open; before that, input frames are dropped.
      const fallback = setTimeout(sendNow, 700);
      ws.onmessage = () => {
        clearTimeout(fallback);
        // Next tick: let any replay burst pass before we type.
        setTimeout(sendNow, 50);
      };
    };
    ws.onerror = () => done();
  });
}

/**
 * Type `text` into the pane and submit it with a separate Enter — the safe
 * way to send a MESSAGE to a TUI (see rule 2 above). For raw keystrokes use
 * sendPaneInput directly.
 */
export async function sendPaneMessage(paneId: string, text: string): Promise<void> {
  await sendPaneInput(paneId, text);
  await new Promise((r) => setTimeout(r, 350));
  await sendPaneInput(paneId, '\r');
}
