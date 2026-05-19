import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeServerMessage, encodeInput, encodePing } from '@muxpad/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { type PtydHandle, startPtyd } from '../ptyd/index.js';
import { PtydClient } from './PtydClient.js';
import { type ProxyAttachHandle, proxyAttach } from './proxyAttach.js';

// Per-test bookkeeping. proxyAttach tests need three independent pieces of
// state to tear down cleanly: ptyd handles, PtydClient instances, a local
// HTTP/WS server that stands in for the browser, and tmpdirs.
let handles: PtydHandle[] = [];
let clients: PtydClient[] = [];
let dirs: string[] = [];
let proxies: ProxyAttachHandle[] = [];
let pairs: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const p of proxies) {
    try {
      p.close();
    } catch {
      // best-effort
    }
  }
  proxies = [];
  for (const c of clients) {
    try {
      await c.close();
    } catch {
      // best-effort
    }
  }
  clients = [];
  for (const cleanup of pairs) {
    try {
      await cleanup();
    } catch {
      // best-effort
    }
  }
  pairs = [];
  for (const h of handles) {
    try {
      await h.stop();
    } catch {
      // best-effort
    }
  }
  handles = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function spawnPtyd(): Promise<{ dir: string; socketPath: string; handle: PtydHandle }> {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-attach-'));
  dirs.push(dir);
  const socketPath = join(dir, 'ptyd.sock');
  const handle = await startPtyd({ socketPath });
  handles.push(handle);
  return { dir, socketPath, handle };
}

function newClient(socketPath: string): PtydClient {
  const c = new PtydClient({ socketPath });
  clients.push(c);
  return c;
}

function waitForEvent(c: PtydClient, name: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.off(name, onEvent);
      reject(new Error(`timed out waiting for '${name}' after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    };
    c.once(name, onEvent);
  });
}

// makeBrowserPair stands up a local TCP WS server, accepts one client
// connection, and returns:
//   - browser: the client-side WS the test drives (sends input, listens for
//     output) — playing the role of a real browser
//   - proxyInput: the server-side WS the proxyAttach helper treats as "the
//     browser" — it reads input from / writes output to this
//   - cleanup: tears down the local server
async function makeBrowserPair(): Promise<{
  browser: WebSocket;
  proxyInput: WebSocket;
  cleanup: () => Promise<void>;
  http: Server;
}> {
  const http = createServer();
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('expected AF_INET listen');
  const port = addr.port;
  const wss = new WebSocketServer({ server: http });

  const proxyInputPromise = new Promise<WebSocket>((resolve) => {
    wss.once('connection', (ws) => resolve(ws));
  });
  const browser = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r, j) => {
    browser.once('open', () => r());
    browser.once('error', j);
  });
  const proxyInput = await proxyInputPromise;

  const cleanup = async () => {
    try {
      browser.close();
    } catch {
      // ignore
    }
    await new Promise<void>((r) => {
      wss.close(() => r());
    });
    await new Promise<void>((r) => {
      http.close(() => r());
    });
  };
  pairs.push(cleanup);
  return { browser, proxyInput, cleanup, http };
}

// Round-trip a ping through the bridge to confirm proxy↔ptyd is open. The
// ptyd /pty/:id endpoint responds to a `ping` frame with `pong` synchronously
// inside its 'message' handler, so a successful pong proves the entire byte
// path is live in both directions. Without this gate, tests race against the
// async ptyd-side connect: closePtyClients can run before the proxy is in
// ptyd's per-pane bucket (finding zero sockets to close), and input frames
// can be dropped at the proxy-side `readyState !== OPEN` gate.
async function waitForBridge(browser: WebSocket, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Send pings on a short interval — the first one may be dropped if ptyd
  // isn't open yet, but the gate flips quickly.
  let timer: NodeJS.Timeout | null = null;
  return new Promise<void>((resolve, reject) => {
    const onMsg = (data: Buffer) => {
      try {
        const msg = decodeServerMessage(new Uint8Array(data));
        if (msg.kind === 'pong') {
          if (timer) clearInterval(timer);
          browser.off('message', onMsg);
          resolve();
        }
      } catch {
        // ignore non-protocol frames
      }
    };
    browser.on('message', onMsg);
    const tick = () => {
      if (Date.now() > deadline) {
        if (timer) clearInterval(timer);
        browser.off('message', onMsg);
        reject(new Error('timed out waiting for bridge ping/pong'));
        return;
      }
      try {
        browser.send(encodePing());
      } catch {
        // ignore; we'll retry on the next tick
      }
    };
    tick();
    timer = setInterval(tick, 50);
  });
}

function waitForBrowserMessage(ws: WebSocket, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timed out waiting for browser ws message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMsg = (data: Buffer) => {
      clearTimeout(timer);
      resolve(data);
    };
    ws.once('message', onMsg);
  });
}

function waitForBrowserClose(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1006, reason: '' });
      return;
    }
    const timer = setTimeout(() => {
      ws.off('close', onClose);
      reject(new Error(`timed out waiting for browser ws close after ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    };
    ws.once('close', onClose);
  });
}

describe('proxyAttach', () => {
  it('forwards bytes bidirectionally between browser and ptyd', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await client.ensurePane({
      id: 'p1',
      shell: '/bin/cat',
      startup_cmd: null,
      cwd: '/tmp',
    });
    const { browser, proxyInput } = await makeBrowserPair();
    const handle = proxyAttach({ socketPath, paneId: 'p1', browser: proxyInput });
    proxies.push(handle);
    await waitForBridge(browser);

    // Drive input from the "real browser" client; cat will echo it back as
    // PTY output, which the proxy bridges back unmodified. Loop until we
    // see our payload — cat can also emit a snapshot frame from spawn-time
    // chatter (typically empty, but be defensive).
    browser.send(encodeInput('hello\n'));
    let combined = '';
    const deadline = Date.now() + 3000;
    while (!combined.includes('hello') && Date.now() < deadline) {
      const raw = await waitForBrowserMessage(browser, deadline - Date.now());
      const msg = decodeServerMessage(new Uint8Array(raw));
      if (msg.kind === 'output') combined += msg.data;
    }
    expect(combined).toContain('hello');

    await client.killPane('p1');
  });

  it('propagates ptyd 1000 close (pty exited) to the browser', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await client.ensurePane({
      id: 'p2',
      shell: '/bin/sh',
      startup_cmd: 'sleep 30',
      cwd: '/tmp',
    });
    const { browser, proxyInput } = await makeBrowserPair();
    const handle = proxyAttach({ socketPath, paneId: 'p2', browser: proxyInput });
    proxies.push(handle);
    await waitForBridge(browser);

    // killPane → ptyd's /pty/:id WS closes 1000 → proxy should mirror.
    const closePromise = waitForBrowserClose(browser);
    await client.killPane('p2');
    const { code } = await closePromise;
    expect(code).toBe(1000);
  });

  it('propagates ptyd 4001 close (closePtyClients) to the browser', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await client.ensurePane({
      id: 'p3',
      shell: '/bin/sh',
      startup_cmd: 'sleep 30',
      cwd: '/tmp',
    });
    const { browser, proxyInput } = await makeBrowserPair();
    const handle = proxyAttach({ socketPath, paneId: 'p3', browser: proxyInput });
    proxies.push(handle);
    await waitForBridge(browser);

    const closePromise = waitForBrowserClose(browser);
    await client.closePtyClients('p3');
    const { code } = await closePromise;
    expect(code).toBe(4001);

    await client.killPane('p3');
  });

  it('close() is idempotent and tears down both sides', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await client.ensurePane({
      id: 'p4',
      shell: '/bin/sh',
      startup_cmd: 'sleep 30',
      cwd: '/tmp',
    });
    const { browser, proxyInput } = await makeBrowserPair();
    const handle = proxyAttach({ socketPath, paneId: 'p4', browser: proxyInput });
    proxies.push(handle);
    await waitForBridge(browser);

    // First close: should fire 'close' on the browser side.
    const closePromise = waitForBrowserClose(browser);
    handle.close();
    handle.close(); // idempotent: second call must not throw
    await closePromise;
    // proxyInput is the server-side socket of the browser pair; proxyAttach
    // closed it, so it should be in CLOSED or CLOSING.
    expect([WebSocket.CLOSED, WebSocket.CLOSING]).toContain(proxyInput.readyState);

    await client.killPane('p4');
  });
});
