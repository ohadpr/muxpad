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

const dir = mkdtempSync(join(tmpdir(), 'muxpad-draft-'));
// Pane keys are HMACs of an install secret; without one `paneKeyFor` answers
// null and every request here is a 400 about a missing key.
initPaneKeys(dir);
afterEach(() => vi.restoreAllMocks());
afterAll(() => __resetPaneKeys());

/**
 * DRAFTING, THROUGH THE REAL ROUTE.
 *
 * The broker decides what may run; these assertions are about the WIRING —
 * that the write verbs reach the one funnel every connector call goes
 * through, with the payload the person will be shown, and that a malformed
 * draft is a 400 here rather than an approval dialog for a request that will
 * fail after somebody approves it.
 */
function harness(policy?: { enforce: boolean; allow: Record<string, string[]> }) {
  const db = openDb(':memory:');
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '', face: 'chat' });
  vi.spyOn(scope, 'loadPolicy').mockReturnValue(
    policy ? scope.readPolicy(JSON.stringify(policy)) : scope.UNSCOPED,
  );
  const { archive } = connectorRoutes({ db, dataDir: dir });
  return { archive, db, pane, key: paneKeyFor(pane.id) as string };
}

const post = (app: ReturnType<typeof harness>['archive'], path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sentTo = async () => {
  const broker = await import('../slack-broker.js');
  return vi.mocked(broker.slackBrokerRequest).mock.calls.at(-1)?.[1] as {
    action: string;
    payload: Record<string, unknown>;
  };
};

describe('a draft reaches the approval funnel with what you will be shown', () => {
  it('composes one, carrying every recipient field', async () => {
    const h = harness();
    const res = await post(h.archive, '/draft', {
      pane: h.pane.id,
      key: h.key,
      to: ['a@b.com', 'c@d.com'],
      cc: ['e@f.com'],
      subject: 'Dinner',
      body: 'Thursday?',
    });
    expect(res.status).toBe(202);
    expect(await sentTo()).toMatchObject({
      action: 'msgvault.draft',
      payload: {
        to: ['a@b.com', 'c@d.com'],
        cc: ['e@f.com'],
        bcc: [],
        subject: 'Dinner',
        body: 'Thursday?',
      },
    });
  });

  it('replies to a thread, and reply-all is opt in', async () => {
    const h = harness();
    await post(h.archive, '/draft-reply', {
      pane: h.pane.id,
      key: h.key,
      id: '150889',
      body: 'Yes',
    });
    expect(await sentTo()).toMatchObject({
      action: 'msgvault.draft-reply',
      payload: { id: '150889', body: 'Yes', all: false },
    });
    await post(h.archive, '/draft-reply', {
      pane: h.pane.id,
      key: h.key,
      id: '150889',
      body: 'Yes',
      all: true,
    });
    expect((await sentTo()).payload.all).toBe(true);
  });

  it('leaves a card naming who it is to, not just that a draft happened', async () => {
    const h = harness();
    await post(h.archive, '/draft', {
      pane: h.pane.id,
      key: h.key,
      to: ['a@b.com', 'c@d.com'],
      subject: 's',
      body: 'b',
    });
    const card = h.db.prepare('SELECT kind, title FROM chat_actions').get() as {
      kind: string;
      title: string;
    };
    expect(card.kind).toBe('msgvault.draft');
    expect(card.title).toBe('Drafted an email to a@b.com +1');
  });

  it('refuses a malformed draft here, rather than at the dialog', async () => {
    const h = harness();
    const bad = [
      { to: [], subject: 's', body: 'b' },
      { to: ['not-an-address'], subject: 's', body: 'b' },
      { to: ['a@b.com'], subject: '', body: 'b' },
      { to: ['a@b.com'], subject: 's', body: '' },
    ];
    for (const b of bad) {
      const res = await post(h.archive, '/draft', { pane: h.pane.id, key: h.key, ...b });
      expect(res.status, JSON.stringify(b)).toBeGreaterThanOrEqual(400);
    }
  });

  it('is refused from a machine the archive is not scoped to', async () => {
    // Same gate as every read: the write path must not have its own door.
    const h = harness({ enforce: true, allow: { msgvault: ['other'] } });
    const res = await post(h.archive, '/draft', {
      pane: h.pane.id,
      key: h.key,
      to: ['a@b.com'],
      subject: 's',
      body: 'b',
    });
    expect(res.status).toBe(403);
  });
});
