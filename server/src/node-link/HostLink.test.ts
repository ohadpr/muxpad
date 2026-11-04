import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { HostLink } from './HostLink.js';

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * A runner sends `hello` the instant it connects, and the loopback relay that
 * stands it up as a local connection takes a moment to open — so the hello is
 * always the frame that races. Dropping it and QUEUEING it forever look
 * identical from the chat view: a runner attached and answering, over a
 * "Starting…" spinner that never clears, because the server never recorded the
 * session id. Both bugs shipped, in that order.
 */

const servers: Array<() => void> = [];
afterEach(() => {
  for (const stop of servers.splice(0)) stop();
});

/** A fake host: accepts `/link`, and lets the test push frames up it. */
async function fakeHost(): Promise<{
  endpoint: string;
  linked: Promise<WebSocket>;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/link' });
  let resolve!: (ws: WebSocket) => void;
  const linked = new Promise<WebSocket>((r) => {
    resolve = r;
  });
  wss.on('connection', (ws) => resolve(ws));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  servers.push(() => {
    wss.close();
    http.close();
  });
  return { endpoint: `ws://127.0.0.1:${port}`, linked };
}

/** A fake "this server": accepts the loopback runner upgrade and records it. */
async function fakeSelf(): Promise<{
  selfUrl: string;
  frames: Promise<{ path: string; nodeId: string | undefined; frames: unknown[] }>;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let resolve!: (v: { path: string; nodeId: string | undefined; frames: unknown[] }) => void;
  const frames = new Promise<{ path: string; nodeId: string | undefined; frames: unknown[] }>(
    (r) => {
      resolve = r;
    },
  );
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d) =>
        resolve({
          path: req.url ?? '',
          nodeId: req.headers['x-muxpad-node-id'] as string | undefined,
          frames: [JSON.parse(d.toString())],
        }),
      );
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  servers.push(() => {
    wss.close();
    http.close();
  });
  return { selfUrl: `http://127.0.0.1:${port}`, frames };
}

describe('a relayed runner', () => {
  it('delivers a hello that arrived before the loopback opened', async () => {
    const host = await fakeHost();
    const self = await fakeSelf();
    const link = new HostLink({
      nodeId: 'trayo',
      endpoint: host.endpoint,
      token: 't'.repeat(64),
      selfUrl: self.selfUrl,
      apiKey: () => null,
      onTranscript: () => {},
      log: () => {},
    });
    servers.push(() => link.close());

    // Exactly the host's own ordering: `attached`, then the hello immediately
    // behind it — far too soon for the loopback to have finished connecting.
    const up = await host.linked;
    up.send(JSON.stringify({ ch: 'runner', op: 'attached', paneId: 'P1' }));
    up.send(
      JSON.stringify({
        ch: 'runner',
        op: 'frame',
        paneId: 'P1',
        frame: { t: 'hello', sid: 'sid-1', cwd: '/home/ohad/work' },
      }),
    );

    const got = await self.frames;
    expect(got.path).toBe('/ws/agent-runner/P1');
    // The identity the ownership check rests on: stamped by this server, on a
    // socket it opened, never by the host.
    expect(got.nodeId).toBe('trayo');
    expect(got.frames[0]).toMatchObject({ t: 'hello', sid: 'sid-1' });
  });
});
