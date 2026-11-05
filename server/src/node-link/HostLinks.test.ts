import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { NodeStore } from '../store/NodeStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { HostLinks } from './HostLinks.js';

/**
 * THE FAN-OUT, AND WHO IS ALLOWED TO SPEAK INTO IT.
 *
 * Two findings from review, both here:
 *
 *   · A transcript frame was dispatched on the peer-supplied `paneId` alone.
 *     The runner channel checks ownership and the API channel checks
 *     ownership; this one did not — so host A could send `transcript/events`
 *     for a pane on host B and its content would render as that conversation,
 *     and a `transcript/title` would be WRITTEN.
 *
 *   · A watcher arriving second got no history, and a link that dropped never
 *     re-subscribed — so a remote chat came back looking recovered (the runner
 *     re-registers, the status returns) and never rendered another message.
 */

let dir: string;
let db: Database.Database;
const TOKEN = 'a'.repeat(64);
const stops: Array<() => void> = [];

/** A fake host: accepts `/link`, records what the server asked for, and lets
 *  the test push frames up. */
async function fakeHost() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/link' });
  const asked: unknown[] = [];
  let sock: WebSocket | null = null;
  const connections: number[] = [];
  wss.on('connection', (ws) => {
    sock = ws;
    connections.push(Date.now());
    ws.on('message', (d) => asked.push(JSON.parse(d.toString())));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  stops.push(() => {
    wss.close();
    http.close();
  });
  return {
    endpoint: `ws://127.0.0.1:${port}`,
    asked,
    connections,
    send: (m: unknown) => sock?.send(JSON.stringify(m)),
    drop: () => sock?.close(),
    waitForConnection: async () => {
      for (let i = 0; i < 200 && !sock; i++) await new Promise((r) => setTimeout(r, 10));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

function paneOn(nodeId: string): string {
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  const pane = new PaneStore(db).create({ tab_id: tab, shell: '/bin/bash' }).id;
  db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run(nodeId, pane);
  return pane;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-hostlinks-'));
  db = openDb(join(dir, 'db.sqlite'));
  mkdirSync(join(dir, 'node-tokens'), { recursive: true });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Boot HostLinks against one fake host per id.
 *
 * TWO HOSTS IS THE INTERESTING CASE and the reason this takes a list: the
 * ownership check can only be tested when a sink is actually REGISTERED for
 * the pane under attack, and `watch` declines a pane whose host has no link.
 * A one-host harness therefore passes whether the check exists or not —
 * confirmed by sabotage, which is how this was caught.
 */
async function boot(ids: string[] = ['trayo']) {
  const hosts: Record<string, Awaited<ReturnType<typeof fakeHost>>> = {};
  for (const id of ids) {
    const h = await fakeHost();
    hosts[id] = h;
    new NodeStore(db).add({ id, name: id, endpoint: h.endpoint });
    writeFileSync(join(dir, 'node-tokens', id), `${TOKEN}\n`);
  }
  const links = new HostLinks({
    nodes: new NodeStore(db),
    selfUrl: 'http://127.0.0.1:1',
    apiKey: () => null,
    dataDir: dir,
    log: () => {},
  });
  links.start();
  stops.push(() => links.stop());
  for (const id of ids) await hosts[id]?.waitForConnection();
  await settle();
  return { hosts, host: hosts[ids[0] as string] as Awaited<ReturnType<typeof fakeHost>>, links };
}

describe('a host may only speak for its own panes', () => {
  it('delivers a transcript frame for a pane it owns', async () => {
    const { host, links } = await boot();
    const mine = paneOn('trayo');
    const got: unknown[] = [];
    links.watch(mine, (m) => got.push(m));
    await settle();
    host.send({ ch: 'transcript', op: 'events', paneId: mine, phase: 'live', events: [{ a: 1 }] });
    await settle();
    expect(got).toHaveLength(1);
  });

  it('REFUSES one host’s frame for ANOTHER host’s pane', async () => {
    // The attack, with the browser really watching: a sink IS registered for
    // B's pane (through B's link), and A names it. Without the check A's
    // content renders as that conversation, and a `title` is WRITTEN.
    const { hosts, links } = await boot(['hostA', 'hostB']);
    const bPane = paneOn('hostB');
    const got: unknown[] = [];
    expect(links.watch(bPane, (m) => got.push(m))).toBe(true);
    await settle();

    hosts.hostA?.send({
      ch: 'transcript',
      op: 'events',
      paneId: bPane,
      phase: 'live',
      events: [{ forged: true }],
    });
    hosts.hostA?.send({ ch: 'transcript', op: 'title', paneId: bPane, title: 'forged' });
    await settle();
    expect(got).toEqual([]);

    // …and B's own frame for the same pane still arrives, so the check is
    // refusing the sender rather than the pane.
    hosts.hostB?.send({
      ch: 'transcript',
      op: 'events',
      paneId: bPane,
      phase: 'live',
      events: [{ real: true }],
    });
    await settle();
    expect(got).toHaveLength(1);
  });

  it('declines to watch a LOCAL pane at all, which is the first of two guards', async () => {
    // Two guards in series, and only this one is observable from here: no
    // sink can be registered for a local pane, so the fan-out's own check
    // cannot be reached to be tested. Said out loud rather than asserted with
    // a test that would pass whether the check existed or not — which is
    // exactly the mistake the sibling test above made until sabotage caught
    // it.
    const { links } = await boot(['hostA']);
    expect(links.watch(paneOn('local'), () => {})).toBe(false);
  });
});

describe('watching a remote chat', () => {
  it('asks the host again for a SECOND watcher, so it gets history too', async () => {
    // It subscribed for the first watcher only, to avoid re-sending history to
    // a reader who had it. The cost was worse than the saving: a second
    // browser joined a live tail and showed an empty conversation.
    const { host, links } = await boot();
    const mine = paneOn('trayo');
    links.watch(mine, () => {});
    links.watch(mine, () => {});
    await settle();
    const subs = host.asked.filter(
      (m) =>
        (m as { ch?: string; op?: string }).ch === 'transcript' &&
        (m as { op?: string }).op === 'subscribe',
    );
    expect(subs).toHaveLength(2);
  });

  it('unsubscribes only when the LAST watcher goes', async () => {
    const { host, links } = await boot();
    const mine = paneOn('trayo');
    const a = () => {};
    const b = () => {};
    links.watch(mine, a);
    links.watch(mine, b);
    await settle();
    links.unwatch(mine, a);
    await settle();
    const unsub = () =>
      host.asked.filter((m) => (m as { op?: string }).op === 'unsubscribe').length;
    expect(unsub()).toBe(0);
    links.unwatch(mine, b);
    await settle();
    expect(unsub()).toBe(1);
  });
});

describe('a link that drops and comes back', () => {
  it('RE-SUBSCRIBES whatever is still being watched', async () => {
    // The finding: the host closes all of its tails when the link drops —
    // correctly, their pushes would go nowhere — and the comment there says
    // the server "re-subscribes for whatever is still being viewed". Nothing
    // did. So a remote chat survived a blip looking recovered (the runner
    // re-registers, the status comes back) and never rendered another message,
    // because the only thing that would have re-subscribed was the FIRST
    // watcher arriving and the watcher had never left.
    const { host, links } = await boot();
    const mine = paneOn('trayo');
    const got: unknown[] = [];
    links.watch(mine, (m) => got.push(m));
    await settle();
    expect(host.asked.filter((m) => (m as { op?: string }).op === 'subscribe')).toHaveLength(1);

    host.drop();
    // The reconnect backoff starts at 500ms.
    for (let i = 0; i < 100 && host.connections.length < 2; i++)
      await new Promise((r) => setTimeout(r, 50));
    await settle();

    expect(host.connections.length).toBeGreaterThan(1);
    expect(
      host.asked.filter((m) => (m as { op?: string }).op === 'subscribe').length,
    ).toBeGreaterThan(1);

    // …and the chat renders again, which is the thing the reader noticed.
    host.send({
      ch: 'transcript',
      op: 'events',
      paneId: mine,
      phase: 'history',
      events: [{ a: 1 }],
    });
    await settle();
    expect(got).toHaveLength(1);
  });

  it('does NOT re-subscribe a chat nobody is watching any more', async () => {
    const { host, links } = await boot();
    const mine = paneOn('trayo');
    const sink = () => {};
    links.watch(mine, sink);
    await settle();
    links.unwatch(mine, sink);
    await settle();
    const before = host.asked.filter((m) => (m as { op?: string }).op === 'subscribe').length;

    host.drop();
    for (let i = 0; i < 100 && host.connections.length < 2; i++)
      await new Promise((r) => setTimeout(r, 50));
    await settle();

    expect(host.asked.filter((m) => (m as { op?: string }).op === 'subscribe').length).toBe(before);
  });
});
