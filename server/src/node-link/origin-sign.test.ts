import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { LinkServer } from '../node-agent/link-server.js';
import { sign } from '../node-agent/origin-proof.js';
import { HostLink } from './HostLink.js';

/**
 * A HOST PROVES ITSELF, END TO END, OVER A REAL SOCKET.
 *
 * The two halves are written in different places on purpose — the server asks,
 * the host answers, and the key only ever exists on the host — so the thing
 * worth testing is the pair, through the link, with the real LinkServer on one
 * end and the real HostLink on the other.
 *
 * Everything that can go wrong here degrades to "no proof", and no proof means
 * the human approves the request once. There is no failure mode in this file
 * that should stop a connector working; there are several that should stop it
 * being TRUSTED.
 */
const KEY = 'origin-key-'.padEnd(48, 'x');
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A real host agent behind a real socket, with a key and one in-flight call. */
async function host(opts: { key?: string | null; declaredAction?: string } = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/link' });
  const agent = new LinkServer({
    connectPtyd: () => ({ readyState: 3, on() {}, close() {}, send() {} }) as never,
    makeTail: (() => ({ stop() {} })) as never,
    originKey: () => (opts.key === null ? null : { origin: 'trayo', key: opts.key ?? KEY }),
    log: () => {},
  });
  wss.on('connection', (ws) => agent.attachLink(ws as unknown as WebSocket));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  stops.push(() => {
    wss.close();
    http.close();
  });
  return { agent, endpoint: `ws://127.0.0.1:${port}` };
}

async function linked(endpoint: string) {
  const link = new HostLink({
    nodeId: 'trayo',
    endpoint,
    token: 't'.repeat(64),
    selfUrl: 'http://127.0.0.1:1',
    apiKey: () => null,
    // Never answers, so the host's call stays in flight for the whole test.
    // Without this the server replies 404 at once, the host settles the call
    // and forgets it, and whether a proof comes back is a race — which is how
    // a passing assertion here could have meant nothing.
    onApiRequest: () => new Promise(() => {}),
    onTranscript: () => {},
    log: () => {},
  });
  stops.push(() => link.close());
  for (let i = 0; i < 200 && !link.up; i++) await new Promise((r) => setTimeout(r, 10));
  expect(link.up, 'link never came up').toBe(true);
  return link;
}

/** Start a call on the host the way the in-pane CLI does, and leave it open. */
function inFlight(agent: LinkServer, action?: string) {
  // The server answers nothing, so the call stays in flight for the test.
  void agent.callApi('GET', '/api/slack/channels', undefined, action, 5_000);
}

describe('a host proves the call it is relaying', () => {
  it('signs the action its own caller asked for, with bytes the broker will accept', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    inFlight(h.agent, 'slack.channels');
    const calls = [...(h.agent as unknown as { apiCalls: Map<string, unknown> }).apiCalls.keys()];
    const proof = (await link.signOrigin(calls[0] as string, 'slack.channels', {})) as {
      ts: number;
      nonce: string;
      sig: string;
    } | null;
    expect(proof, 'no proof came back').toBeTruthy();
    // The signature is over exactly what the broker will verify.
    expect(proof?.sig).toBe(
      sign(KEY, {
        origin: 'trayo',
        action: 'slack.channels',
        payload: {},
        ts: proof!.ts,
        nonce: proof!.nonce,
      }),
    );
  });

  it('REFUSES to sign an action its caller did not ask for', async () => {
    // The whole reason the CLI declares an action: a control plane that has
    // been taken over must not be able to turn a read it is relaying into a
    // write.
    const h = await host();
    const link = await linked(h.endpoint);
    inFlight(h.agent, 'slack.channels');
    const calls = [...(h.agent as unknown as { apiCalls: Map<string, unknown> }).apiCalls.keys()];
    expect(await link.signOrigin(calls[0] as string, 'slack.post', { text: 'hi' })).toBeNull();
  });

  it('refuses a call that is not in flight, so signatures cannot be collected', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    expect(await link.signOrigin('a-call-nobody-made', 'slack.channels', {})).toBeNull();
  });

  it('answers "no" rather than hanging when the host has no key', async () => {
    const h = await host({ key: null });
    const link = await linked(h.endpoint);
    inFlight(h.agent, 'slack.channels');
    const calls = [...(h.agent as unknown as { apiCalls: Map<string, unknown> }).apiCalls.keys()];
    expect(await link.signOrigin(calls[0] as string, 'slack.channels', {})).toBeNull();
  });

  it('gives each proof a fresh nonce, so one cannot be replayed as another', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    inFlight(h.agent, 'slack.channels');
    inFlight(h.agent, 'slack.channels');
    const calls = [...(h.agent as unknown as { apiCalls: Map<string, unknown> }).apiCalls.keys()];
    const a = (await link.signOrigin(calls[0] as string, 'slack.channels', {})) as {
      nonce: string;
    };
    const b = (await link.signOrigin(calls[1] as string, 'slack.channels', {})) as {
      nonce: string;
    };
    expect(a.nonce).not.toBe(b.nonce);
  });
});
