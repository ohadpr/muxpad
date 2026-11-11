import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as scope from '../connectors/scope.js';
import { __resetPaneKeys, initPaneKeys, paneKeyFor } from '../pane-key.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { connectorRoutes } from './slack.js';

vi.mock('../slack-broker.js', () => ({
  slackBrokerURL: () => 'https://broker.test',
  slackBrokerRequest: vi.fn(async (_p: string, body?: unknown) => ({
    id: '11111111-2222-3333-4444-555555555555',
    state: 'pending',
    sent: body,
  })),
}));

const dir = mkdtempSync(join(tmpdir(), 'muxpad-hostcall-'));
initPaneKeys(dir);
afterEach(() => vi.restoreAllMocks());
afterAll(() => __resetPaneKeys());

/**
 * `x-muxpad-host-call` IS A ROUTING HINT, NOT A CLAIM OF IDENTITY.
 *
 * The server sets it when it relays a call for a remote host, and it decides
 * exactly one thing: WHICH host to ask for a proof. Nothing stops a local
 * process from sending the header itself — the endpoint has no caller
 * authentication, which is the premise the whole broker design starts from —
 * so what matters is that sending it buys nothing.
 *
 * Two properties, and the second is the load-bearing one:
 *
 *   · the ORIGIN comes from the pane's own row, so a header cannot relabel a
 *     local chat as the VM and walk through a policy that scopes Slack to it;
 *   · asking the named host to sign is all the header can do, and the host
 *     refuses unless the call is genuinely in flight there AND the payload
 *     matches what it relayed (see node-link/origin-sign.test.ts).
 */
function harness(policy: { enforce: boolean; allow: Record<string, string[]> }) {
  const db = openDb(':memory:');
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '', face: 'chat' });
  vi.spyOn(scope, 'loadPolicy').mockReturnValue(scope.readPolicy(JSON.stringify(policy)));
  const signOrigin = vi.fn(async () => null);
  const { archive } = connectorRoutes({ db, dataDir: dir, signOrigin });
  return { archive, db, pane, key: paneKeyFor(pane.id) as string, signOrigin };
}

const sentTo = async () => {
  const broker = await import('../slack-broker.js');
  return vi.mocked(broker.slackBrokerRequest).mock.calls.at(-1)?.[1] as
    | { origin?: string }
    | undefined;
};

describe('a forged host-call header cannot relabel which machine is asking', () => {
  it('does not let a local chat borrow a remote machine’s policy', async () => {
    // msgvault is scoped to `local` here and Slack to `trayo` — the real
    // arrangement on this machine.
    const h = harness({ enforce: true, allow: { msgvault: ['local'], slack: ['trayo'] } });
    const res = await h.archive.request(`/stats?pane=${h.pane.id}&key=${h.key}`, {
      headers: { 'x-muxpad-host-call': 'trayo some-call-id' },
    });
    // The read still runs, because the pane really is local and msgvault is
    // scoped to local. The header changed nothing about who is asking.
    expect(res.status).toBe(202);
    expect((await sentTo())?.origin).toBe('local');
  });

  it('cannot turn a local chat into trayo to reach a connector scoped away from it', async () => {
    const h = harness({ enforce: true, allow: { msgvault: ['trayo'] } });
    const res = await h.archive.request(`/stats?pane=${h.pane.id}&key=${h.key}`, {
      headers: { 'x-muxpad-host-call': 'trayo some-call-id' },
    });
    // Refused on the pane's real machine, not on the one the header names.
    expect(res.status).toBe(403);
  });

  it('the most a header buys is a request for a proof, which the host answers', async () => {
    const h = harness({ enforce: true, allow: { msgvault: ['local'] } });
    await h.archive.request(`/stats?pane=${h.pane.id}&key=${h.key}`, {
      headers: { 'x-muxpad-host-call': 'trayo forged-call-id' },
    });
    // It asked the named host — and that host is where the refusal lives.
    expect(h.signOrigin).toHaveBeenCalledWith('trayo', 'forged-call-id', 'msgvault.stats', {});
    // A null answer is ordinary and the request goes on unproven, so the
    // human approves it once. No proof reached the broker.
    expect(await sentTo()).not.toHaveProperty('proof');
  });
});
