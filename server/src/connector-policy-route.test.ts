import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPaneKeys, initPaneKeys, paneKeyFor } from './pane-key.js';
import { connectorRoutes } from './routes/slack.js';
import { NodeStore } from './store/NodeStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/**
 * THE POLICY THE OWNER ASKED FOR, END TO END.
 *
 *   "Slack ONLY from the Trayo VM. msgvault ONLY on the mac mini."
 *   {"enforce": true, "allow": {"slack": ["trayo"], "msgvault": ["local"]}}
 *
 * The point of asserting it HERE rather than only in scope.test.ts is that
 * the gate lives in one funnel shared by both connectors, and the connector
 * it checks is derived from the action's prefix. A second hardcoded 'slack'
 * in that funnel would pass every scope test and silently check Slack's
 * policy for an archive read.
 *
 * `origin` matters as much as the verdict: the broker binds a timed grant to
 * it, and muxpad spent its whole life sending none — so every request arrived
 * as `unknown`, matched no grant, and no timed approval could ever be spent.
 */
const TRAYO_ONLY = {
  enforce: true,
  allow: { slack: ['trayo'], msgvault: ['local'] },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'policy-route-'));
  initPaneKeys(dir);
  vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
});
afterEach(() => {
  __resetPaneKeys();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function harness(policy: unknown = TRAYO_ONLY) {
  const db = openDb(':memory:');
  new NodeStore(db).add({ id: 'trayo', name: 'Trayo dev VM', endpoint: 'http://vm:9999' });
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const panes = new PaneStore(db);
  const tabs = new TabStore(db);
  const make = (node: string | null, face: 'chat' | 'terminal' | 'web' = 'chat') => {
    const tab = tabs.create({ name: 'T', workspace_id: ws.id, layout: '' });
    const pane = panes.create({
      tab_id: tab.id,
      startup_cmd: '',
      face,
      ...(node ? { node_id: node } : {}),
    });
    return { id: pane.id, key: paneKeyFor(pane.id) as string };
  };
  const { slack, archive } = connectorRoutes({
    db,
    dataDir: dir,
    policy: () => policy as never,
  });
  return {
    slack,
    archive,
    db,
    mini: make(null),
    vm: make('trayo'),
    miniTerminal: make(null, 'terminal'),
    vmTerminal: make('trayo', 'terminal'),
  };
}

/** The last body posted to the broker, or null when nothing was. */
function brokerCalls() {
  const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
    Response.json({ id: 'r1', state: 'pending', action: 'x', fingerprint: 'f' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    body: () => (fetchMock.mock.calls.length ? JSON.parse(fetchMock.mock.calls[0]![1].body) : null),
    count: () => fetchMock.mock.calls.length,
  };
}

describe('slack is the VM’s, the archive is the mini’s', () => {
  it('lets a Trayo chat use Slack, and tells the broker it is trayo', async () => {
    const h = harness();
    const broker = brokerCalls();
    const r = await h.slack.request(`/channels?pane=${h.vm.id}&key=${h.vm.key}`);
    expect(r.status).toBe(202);
    expect(broker.body()).toMatchObject({ action: 'slack.channels', origin: 'trayo' });
  });

  it('refuses Slack from the mini, and the refusal NAMES the policy', async () => {
    const h = harness();
    const broker = brokerCalls();
    const r = await h.slack.request(`/channels?pane=${h.mini.id}&key=${h.mini.key}`);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { message: string } };
    // Not "Slack request failed". It says which machine may, which this is,
    // and where the rule lives.
    expect(body.error.message).toMatch(/slack is scoped to trayo/);
    expect(body.error.message).toMatch(/this chat runs on local/);
    expect(body.error.message).toMatch(/connectors\.json/);
    // …and nothing reached the broker at all.
    expect(broker.count()).toBe(0);
  });

  it('lets the mini read the archive, as origin local', async () => {
    const h = harness();
    const broker = brokerCalls();
    const r = await h.archive.request(`/stats?pane=${h.mini.id}&key=${h.mini.key}`);
    expect(r.status).toBe(202);
    expect(broker.body()).toMatchObject({ action: 'msgvault.stats', origin: 'local' });
  });

  it('refuses the archive from Trayo — work chats do not read personal mail', async () => {
    const h = harness();
    const broker = brokerCalls();
    const r = await h.archive.request(`/search?q=anything&pane=${h.vm.id}&key=${h.vm.key}`);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/msgvault is scoped to local/);
    expect(broker.count()).toBe(0);
  });

  it('checks each connector against ITS OWN entry, not Slack’s', async () => {
    // The funnel derives the connector from the action's prefix. A hardcoded
    // 'slack' there passes every scope test and checks the wrong rule here.
    const h = harness({ enforce: true, allow: { slack: ['local'], msgvault: ['trayo'] } });
    const broker = brokerCalls();
    expect((await h.slack.request(`/channels?pane=${h.mini.id}&key=${h.mini.key}`)).status).toBe(
      202,
    );
    expect((await h.archive.request(`/stats?pane=${h.mini.id}&key=${h.mini.key}`)).status).toBe(
      403,
    );
    expect(broker.count()).toBe(1);
  });

  it('refuses everything when the policy cannot be trusted', async () => {
    const h = harness({ enforce: true, allow: {}, problem: 'policy is group-writable' });
    const broker = brokerCalls();
    for (const [app, path] of [
      [h.slack, '/channels'],
      [h.archive, '/stats'],
    ] as const) {
      const r = await app.request(`${path}?pane=${h.mini.id}&key=${h.mini.key}`);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
        /group-writable/,
      );
    }
    expect(broker.count()).toBe(0);
  });
});

/**
 * A REQUEST NOBODY CAN BE SHOWN IS NOT MADE.
 *
 * The approval dialog is mounted by ChatPane and the pending list is scoped to
 * the pane that asked, so a connector call from a terminal pane created a
 * broker request nobody ever saw. It expired after five minutes and the caller
 * saw a hang with no explanation. The broker has no cancel endpoint, so the
 * only honest moment to stop it is before the request exists.
 */
describe('a pane that cannot be asked is told so', () => {
  it('refuses a terminal pane, naming the reason and the fix', async () => {
    const h = harness();
    const broker = brokerCalls();
    const r = await h.archive.request(`/stats?pane=${h.miniTerminal.id}&key=${h.miniTerminal.key}`);
    expect(r.status).toBe(403);
    const why = ((await r.json()) as { error: { message: string } }).error.message;
    expect(why).toMatch(/approvals appear in a chat/);
    expect(why).toMatch(/showing its terminal view, not a chat/);
    expect(why).toMatch(/Run it from a chat,/);
    // …and nothing was created that could expire unseen.
    expect(broker.count()).toBe(0);
  });

  it('lets the same call through from a chat pane', async () => {
    const h = harness();
    const broker = brokerCalls();
    expect((await h.archive.request(`/stats?pane=${h.mini.id}&key=${h.mini.key}`)).status).toBe(
      202,
    );
    expect(broker.count()).toBe(1);
  });

  it('still answers a POLICY refusal from a terminal, which needs no dialog', async () => {
    // The order matters and is the point: scoping is checked first, so
    // "slack is scoped to trayo" reaches you wherever you run it. Only the
    // calls that WOULD have needed a human are stopped for want of one.
    const h = harness();
    const broker = brokerCalls();
    const r = await h.slack.request(
      `/channels?pane=${h.miniTerminal.id}&key=${h.miniTerminal.key}`,
    );
    expect(r.status).toBe(403);
    const why = ((await r.json()) as { error: { message: string } }).error.message;
    expect(why).toMatch(/slack is scoped to trayo/);
    expect(why).not.toMatch(/approvals appear in a chat/);
    expect(broker.count()).toBe(0);
  });

  it('refuses a terminal on the machine that IS allowed', async () => {
    // Allowed by policy, still unaskable. Both gates are real.
    const h = harness();
    const broker = brokerCalls();
    const r = await h.slack.request(`/channels?pane=${h.vmTerminal.id}&key=${h.vmTerminal.key}`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
      /approvals appear in a chat/,
    );
    expect(broker.count()).toBe(0);
  });
});
