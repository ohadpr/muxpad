import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AgentCdpGate } from './AgentCdp.js';

describe('agent CDP handover barrier', () => {
  it('blocks commands on an already connected agent while a human holds the wheel', async () => {
    let human = false;
    const gate = new AgentCdpGate(async () => !human);
    const sent: string[] = [];
    await gate.run(async () => {
      sent.push('before');
    });
    human = true;
    await expect(
      gate.run(async () => {
        sent.push('during');
      }),
    ).rejects.toThrow(/human/);
    expect(sent).toEqual(['before']);
    human = false;
    await gate.run(async () => {
      sent.push('after');
    });
    expect(sent).toEqual(['before', 'after']);
  });

  it('invalidates a permission check that began before takeover', async () => {
    let allow!: (allowed: boolean) => void;
    const gate = new AgentCdpGate(
      () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    );
    let sent = false;
    const command = gate.run(async () => {
      sent = true;
    });
    const rejected = expect(command).rejects.toThrow(/human/);
    await Promise.resolve();
    await gate.quiesce();
    allow(true);
    await rejected;
    expect(sent).toBe(false);
  });

  it('does not acknowledge takeover until forwarded commands finish', async () => {
    const gate = new AgentCdpGate(async () => true);
    let finish!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const command = gate.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    await running;
    let acknowledged = false;
    const barrier = gate.quiesce().then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await command;
    await barrier;
    expect(acknowledged).toBe(true);
  });
});

it('relays real CDP sockets, preserves flat sessions, and refuses later input after takeover', async () => {
  const { WebSocket, WebSocketServer } = await import('ws');
  const { bridgeAgentCdp } = await import('./AgentCdp.js');
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let client: InstanceType<typeof WebSocket> | undefined;
  try {
    await Promise.all([once(upstream, 'listening'), once(relay, 'listening')]);
    const address = upstream.address() as { port: number };
    const relayAddress = relay.address() as { port: number };
    const seen: unknown[] = [];
    const selected: Array<string | undefined> = [];
    let human = false;
    const gate = new AgentCdpGate(async () => !human);
    upstream.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        seen.push(message);
        socket.send(
          JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            result: message.method === 'Target.attachToTarget' ? { sessionId: 'page-session' } : {},
          }),
        );
      }),
    );
    relay.on('connection', (socket) =>
      bridgeAgentCdp(socket, `ws://127.0.0.1:${address.port}`, gate, (id) => selected.push(id)),
    );
    client = new WebSocket(`ws://127.0.0.1:${relayAddress.port}`);
    await once(client, 'open');
    const request = async (message: unknown) => {
      const reply = once(client!, 'message');
      client!.send(JSON.stringify(message));
      return JSON.parse(String((await reply)[0]));
    };
    expect(
      await request({
        id: 1,
        method: 'Target.attachToTarget',
        params: { targetId: 'page-B', flatten: true },
      }),
    ).toMatchObject({ id: 1, result: { sessionId: 'page-session' } });
    await request({ id: 2, method: 'Page.bringToFront', sessionId: 'page-session' });
    expect(selected).toEqual(['page-B']);
    const popup = once(client, 'message');
    for (const socket of upstream.clients)
      socket.send(
        JSON.stringify({
          method: 'Target.targetCreated',
          params: { targetInfo: { type: 'page', targetId: 'popup' } },
        }),
      );
    await popup;
    expect(selected.at(-1)).toBeUndefined();

    human = true;
    await gate.quiesce();
    expect(
      await request({
        id: 3,
        method: 'Input.insertText',
        sessionId: 'page-session',
        params: { text: 'unsafe' },
      }),
    ).toMatchObject({
      id: 3,
      sessionId: 'page-session',
      error: { message: expect.stringContaining('human') },
    });
    expect(seen).toHaveLength(2);
    human = false;
    expect(
      await request({
        id: 4,
        method: 'Input.insertText',
        sessionId: 'page-session',
        params: { text: 'safe' },
      }),
    ).toMatchObject({ id: 4, result: {} });
    expect(seen).toHaveLength(3);
  } finally {
    client?.terminate();
    for (const server of [relay, upstream]) for (const socket of server.clients) socket.terminate();
    await Promise.all(
      [relay, upstream].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
});
