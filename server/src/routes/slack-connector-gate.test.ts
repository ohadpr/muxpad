import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scope from '../connectors/scope.js';
import { __resetPaneKeys, initPaneKeys, paneKeyFor } from '../pane-key.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { slackRoutes } from './slack.js';

/**
 * THE CONNECTOR GATE, THROUGH THE REAL ROUTE.
 *
 * The rules have their own unit tests. This asserts the WIRING: that the one
 * funnel every Slack verb passes through consults them, that a refusal becomes
 * a 403 carrying the reason rather than a 500 or a silent send, and that it
 * leaves a card in the chat saying so — "I asked and nothing happened" is the
 * state this whole mechanism exists to make visible, and an agent's own
 * account of being refused is not a record.
 *
 * It also pins the shipping default: with host scoping OFF, nothing changes.
 * That is the property that makes it safe to land the gate before the owner's
 * chats have moved to the machines they belong on.
 */
vi.mock('../slack-broker.js', () => ({
  slackBrokerURL: () => 'https://broker.test',
  slackBrokerRequest: vi.fn(async () => ({
    id: '11111111-1111-4111-8111-111111111111',
    state: 'pending',
  })),
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-'));
  initPaneKeys(dir);
});
afterEach(() => {
  __resetPaneKeys();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The real policy file is root-owned, which a test cannot create, so the
 *  loader is stubbed at that one seam rather than the rule being bypassed. */
function harness(policy?: { enforce: boolean; allow: Record<string, string[]> }) {
  const db = openDb(':memory:');
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
  // A CHAT pane: the funnel refuses a connector call from a terminal, because
  // the approval dialog is drawn by ChatPane and a terminal's request would
  // wait for something nobody can see. Agent tabs are created `face: 'chat'`,
  // so this is how a real one arrives rather than a default.
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '', face: 'chat' });
  vi.spyOn(scope, 'loadPolicy').mockReturnValue(
    policy ? scope.readPolicy(JSON.stringify(policy)) : scope.UNSCOPED,
  );
  const app = slackRoutes({ db, dataDir: dir });
  return { app, db, pane, key: paneKeyFor(pane.id) as string };
}

const post = (app: ReturnType<typeof harness>['app'], body: unknown) =>
  app.request('/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the gate on the Slack funnel', () => {
  it('changes nothing while host scoping is off', async () => {
    const h = harness();
    const res = await post(h.app, { pane: h.pane.id, key: h.key, ref: '#x', text: 'hi' });
    expect(res.status).toBe(202);
  });

  it('refuses a chat on the wrong machine, with the reason and a declined card', async () => {
    const h = harness({ enforce: true, allow: { slack: ['trayo'] } });
    const res = await post(h.app, { pane: h.pane.id, key: h.key, ref: '#x', text: 'hi' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/scoped to trayo/);
    const card = h.db.prepare('SELECT kind, state, detail FROM chat_actions').get() as
      | { kind: string; state: string; detail: string }
      | undefined;
    expect(card?.kind).toBe('slack.post');
    expect(card?.state).toBe('declined');
    expect(card?.detail).toMatch(/scoped to trayo/);
  });

  it('never reaches the broker when it refuses', async () => {
    const broker = await import('../slack-broker.js');
    vi.mocked(broker.slackBrokerRequest).mockClear();
    const h = harness({ enforce: true, allow: { slack: ['trayo'] } });
    await post(h.app, { pane: h.pane.id, key: h.key, ref: '#x', text: 'hi' });
    expect(vi.mocked(broker.slackBrokerRequest)).not.toHaveBeenCalled();
  });

  it('allows the machine the connector is scoped to', async () => {
    const h = harness({ enforce: true, allow: { slack: ['local'] } });
    const res = await post(h.app, { pane: h.pane.id, key: h.key, ref: '#x', text: 'hi' });
    expect(res.status).toBe(202);
  });

  it('refuses when the policy itself is sealed', async () => {
    // A tampered or unparseable policy file denies every connector; the route
    // must surface that as the refusal rather than as an allow or a crash.
    vi.spyOn(scope, 'loadPolicy').mockReturnValue({
      enforce: true,
      allow: {},
      problem: '/Library/muxpad/connectors.json is not root-owned',
    });
    const db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'W' });
    const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
    const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '', face: 'chat' });
    const app = slackRoutes({ db, dataDir: dir });
    const res = await post(app, { pane: pane.id, key: paneKeyFor(pane.id), ref: '#x', text: 'hi' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/not root-owned/);
  });

  it('refuses a send the chat was directed to make from another machine', async () => {
    // The laundering shape: this chat may post, but it was told to by a chat
    // on a machine that may not.
    const h = harness({ enforce: true, allow: { slack: ['local'] } });
    const { NodeStore } = await import('../store/NodeStore.js');
    new NodeStore(h.db).add({ id: 'trayo', name: 'VM', endpoint: 'ws://x:1' });
    const ws2 = new WorkspaceStore(h.db).create({ name: 'W2' });
    const other = new TabStore(h.db).create({ name: 'Other', workspace_id: ws2.id, layout: '' });
    new PaneStore(h.db).create({ tab_id: other.id, startup_cmd: '', node_id: 'trayo' } as never);
    const paneRow = h.db.prepare('SELECT tab_id FROM panes WHERE id = ?').get(h.pane.id) as {
      tab_id: string;
    };
    h.db
      .prepare(
        'INSERT INTO inbound_messages (id, tab_id, at, text_key, from_tab_id) VALUES (?,?,?,?,?)',
      )
      .run('i1', paneRow.tab_id, Date.now(), 'k', other.id);
    const res = await post(h.app, { pane: h.pane.id, key: h.key, ref: '#x', text: 'hi' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/directed to by a chat on trayo/);
  });
});

describe('every verb the routes send is one muxpad can classify', () => {
  it('holds for all of them, so a new route cannot outrun the registry', async () => {
    // The gate's verb check is dormant today: every verb these routes send is
    // in the registry, so deleting the check changes nothing observable — a
    // sabotage of it survives, and that is honest rather than a missing test.
    // What it actually guards is the NEXT route, added with a verb nobody
    // classified. So the invariant is asserted at the source: if a route sends
    // a verb the registry does not know, this fails here rather than at 403
    // the first time somebody uses it.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { classify } = await import('../connectors/registry.js');
    const src = readFileSync(join(import.meta.dirname, 'slack.js').replace(/\.js$/, '.ts'), 'utf8');
    const verbs = [...src.matchAll(/brokerAction\(\s*'([^']+)'/g)].map((m) => m[1] as string);
    expect(verbs.length, 'found no brokerAction calls — did the funnel move?').toBeGreaterThan(5);
    for (const v of new Set(verbs)) {
      const c = classify(v);
      expect(c.ok, `${v} is sent by a route but the registry refuses it: ${c.reason}`).toBe(true);
    }
  });
});
