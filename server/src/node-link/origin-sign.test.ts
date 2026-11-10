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
function inFlight(agent: LinkServer, action?: string, path = '/api/slack/channels', body?: string) {
  // The server answers nothing, so the call stays in flight for the test.
  void agent.callApi(body ? 'POST' : 'GET', path, body, action, 5_000);
}

/** The correlation id of the call just started. */
const lastCall = (agent: LinkServer): string =>
  [...(agent as unknown as { apiCalls: Map<string, unknown> }).apiCalls.keys()].at(-1) as string;

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

/**
 * THE PROOF IS ABOUT THE REQUEST, NOT JUST ABOUT THE VERB.
 *
 * The host used to sign ANY payload while a call for that action was in
 * flight. Its own comment claimed it "signs what its own caller asked for",
 * which was true of the action and false of the request: a search this
 * machine ran for one thing minted a proof good for a search of anything, and
 * a post to one channel minted a proof for a post to another.
 *
 * That is not academic. A proof is what lets a TIMED GRANT be spent without a
 * dialog, so whoever can drive this link could ride a grant the owner
 * approved, with a request this machine never made.
 *
 * Binding is by VALUE because the server renames and adds legitimately —
 * `?q=` becomes `{query}`, `?limit=25` becomes a number, an absent option
 * arrives as `all: false`. These tests are both directions of that: the
 * honest relaying still gets its proof, and the substitution does not.
 */
describe('a proof covers the values the host actually relayed', () => {
  it('signs a renamed, retyped payload — the server is allowed to do that', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    // What the in-pane CLI sends…
    inFlight(h.agent, 'msgvault.search', '/api/msgvault/search?pane=p1&key=k1&q=dinner&limit=25');
    // …and what the server turns it into: `q` renamed, `limit` a number.
    const proof = await link.signOrigin(lastCall(h.agent), 'msgvault.search', {
      query: 'dinner',
      limit: 25,
    });
    expect(proof, 'an honest relay must still be provable').toBeTruthy();
  });

  it('refuses to sign a different query than the one it relayed', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    inFlight(h.agent, 'msgvault.search', '/api/msgvault/search?pane=p1&key=k1&q=dinner');
    // The whole attack in one line: same action, same in-flight call, a
    // search of something else entirely.
    expect(
      await link.signOrigin(lastCall(h.agent), 'msgvault.search', { query: 'from:board' }),
    ).toBeNull();
  });

  it('refuses to redirect a post to another channel, or to change its text', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    const body = JSON.stringify({ pane: 'p1', key: 'k1', ref: 'C-team', text: 'ship it' });
    inFlight(h.agent, 'slack.post', '/api/slack/post', body);
    const call = lastCall(h.agent);
    // Honest first, so a null below cannot be "this never worked".
    expect(
      await link.signOrigin(call, 'slack.post', { ref: 'C-team', text: 'ship it' }),
    ).toBeTruthy();
    inFlight(h.agent, 'slack.post', '/api/slack/post', body);
    expect(
      await link.signOrigin(lastCall(h.agent), 'slack.post', { ref: 'C-exec', text: 'ship it' }),
    ).toBeNull();
    inFlight(h.agent, 'slack.post', '/api/slack/post', body);
    expect(
      await link.signOrigin(lastCall(h.agent), 'slack.post', { ref: 'C-team', text: 'fire him' }),
    ).toBeNull();
  });

  it('does not let an added field smuggle past a dropped one', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    const body = JSON.stringify({ pane: 'p1', key: 'k1', id: '150889', body: 'Yes' });
    inFlight(h.agent, 'msgvault.draft-reply', '/api/msgvault/draft-reply', body);
    // A server-added default is fine — `all` was never in the call.
    expect(
      await link.signOrigin(lastCall(h.agent), 'msgvault.draft-reply', {
        id: '150889',
        body: 'Yes',
        all: false,
      }),
    ).toBeTruthy();
    // Dropping a relayed value is not, however many are added beside it.
    inFlight(h.agent, 'msgvault.draft-reply', '/api/msgvault/draft-reply', body);
    expect(
      await link.signOrigin(lastCall(h.agent), 'msgvault.draft-reply', {
        id: '150889',
        body: 'No, and here is why',
        all: true,
      }),
    ).toBeNull();
  });

  it('is not fooled by key order inside a relayed value', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    const body = JSON.stringify({ pane: 'p1', key: 'k1', opts: { b: 2, a: 1 } });
    inFlight(h.agent, 'slack.post', '/api/slack/post', body);
    // Same object, written the other way round. A proof must not depend on
    // the order a JSON serialiser happened to use.
    expect(
      await link.signOrigin(lastCall(h.agent), 'slack.post', { opts: { a: 1, b: 2 } }),
    ).toBeTruthy();
  });

  it('still binds a value too long to keep — an upload is not a free pass', async () => {
    const h = await host();
    const link = await linked(h.endpoint);
    const content = 'A'.repeat(300_000);
    const body = JSON.stringify({ pane: 'p1', key: 'k1', ref: 'C1', content });
    inFlight(h.agent, 'slack.upload', '/api/slack/upload', body);
    expect(
      await link.signOrigin(lastCall(h.agent), 'slack.upload', { ref: 'C1', content }),
    ).toBeTruthy();
    inFlight(h.agent, 'slack.upload', '/api/slack/upload', body);
    expect(
      await link.signOrigin(lastCall(h.agent), 'slack.upload', {
        ref: 'C1',
        content: `${content}X`,
      }),
    ).toBeNull();
  });
});
