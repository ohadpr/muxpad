import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPaneKeys, initPaneKeys, paneKeyFor } from './pane-key.js';
import { slackRoutes } from './routes/slack.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/**
 * THE GUARD, NOW THAT IT CANNOT BE TOLD WHO IS CALLING.
 *
 * The version this replaces resolved pane → tab → workspace on the server and
 * was pleased with itself for not trusting `$MUXPAD_WORKSPACE_ID`. It took the
 * pane id from `$MUXPAD_PANE_ID`, which is equally settable, so
 * `MUXPAD_PANE_ID=<a work pane> muxpad slack post …` from a personal chat went
 * straight through — and the test suite asserted the spoof that no longer
 * mattered.
 *
 * Then the ancestry walk that replaced it needed pane pids, which only ptyd
 * knows — a new ptyd RPC, and a ptyd protocol change restarts the daemon that
 * owns every terminal on the machine. Too expensive for the threat.
 *
 * So the caller proves which pane it is with a key the server minted for that
 * pane and handed over in its spawn environment, through `spec.env`, which was
 * already in the protocol. The test that matters most is the one where a
 * caller names somebody else's pane.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slackroute-'));
  initPaneKeys(dir);
});
afterEach(() => {
  __resetPaneKeys();
  rmSync(dir, { recursive: true, force: true });
});

function harness(opts: { slack: boolean }) {
  const db = openDb(':memory:');
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  db.prepare('UPDATE workspaces SET slack = ?, instructions = ? WHERE id = ?').run(
    opts.slack ? 1 : 0,
    'OLD WORKSPACE PROMPT',
    ws.id,
  );
  const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '' });
  const app = slackRoutes({ db, dataDir: dir });
  return { app, ws, pane, db, key: paneKeyFor(pane.id) as string };
}

const post = (app: ReturnType<typeof harness>['app'], body: unknown, origin?: string) =>
  app.request('/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

describe('authorizing a Slack call', () => {
  it('requires a configured broker even when the old workspace switch is off', async () => {
    const { app, pane, key } = harness({ slack: false });
    const r = await post(app, { pane: pane.id, key, ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('broker is not configured');
  });

  it('refuses a pane named WITHOUT its key', async () => {
    // THE SPOOF, and the whole reason any of this exists. A personal chat
    // naming a work pane's id used to walk straight through, because the id
    // was the only input and the caller sets it.
    const { app, pane } = harness({ slack: true });
    for (const key of ['', 'not-the-key', paneKeyFor('some-other-pane') as string]) {
      const r = await post(app, { pane: pane.id, key, ref: '#x', text: 'hi' });
      expect(r.status, JSON.stringify(key)).toBe(403);
      expect((await r.json()).error.message).toContain('cannot prove which workspace');
    }
  });

  it('refuses a pane that does not exist, even with a well-formed key', async () => {
    // A key proves "I am this pane"; it does not conjure the pane's row.
    const { app } = harness({ slack: true });
    const ghost = 'pane-that-was-deleted';
    const r = await post(app, { pane: ghost, key: paneKeyFor(ghost), ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
  });

  it('tells a keyless pane what to do about it', async () => {
    // Panes spawned before the server issued keys have none, and nothing can
    // put one into a running process. The message has to say "restart this
    // pane", not "you are not allowed".
    const { app, pane } = harness({ slack: true });
    const r = await post(app, { pane: pane.id, key: '', ref: '#x', text: 'hi' });
    expect((await r.json()).error.detail).toMatch(/Restart this pane/);
  });

  it('refuses when there is no pane at all', async () => {
    const { app } = harness({ slack: true });
    const r = await post(app, { pane: '', key: '', ref: '#x', text: 'hi' });
    expect(r.status).toBe(400);
  });

  it('refuses an enabled workspace with no credential — and says so plainly', async () => {
    const { app, pane, key } = harness({ slack: true });
    const r = await post(app, { pane: pane.id, key, ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('broker is not configured');
  });

  it('gates read, search and channels exactly like post', async () => {
    // The first cut gated only sending, on the reasoning that the risk is data
    // going OUT. A personal chat could then run `slack channels` and list
    // every private channel in the company.
    const { app, pane, key } = harness({ slack: false });
    for (const verb of ['read', 'search', 'channels']) {
      const r = await app.request(`/${verb}?pane=${pane.id}&key=${key}&ref=%23x&q=x`);
      expect(r.status, verb).toBe(403);
    }
  });
});

describe('local credential management is disabled', () => {
  it('rejects credential writes with or without a forged browser Origin', async () => {
    const { app } = harness({ slack: true });
    for (const method of ['PUT', 'DELETE'])
      for (const origin of ['', 'https://muxpad.test']) {
        const r = await app.request('/token', { method, headers: { Origin: origin }, body: '{}' });
        expect(r.status).toBe(403);
      }
    expect(await (await app.request('/token')).json()).toMatchObject({
      set: false,
      hint: null,
      broker: true,
    });
  });
});

describe('protected broker mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('queues the exact action without needing a local Slack token', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'request',
          state: 'pending',
          approval_url: 'https://broker.test/approve/request',
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { app, pane, key, db } = harness({ slack: true });
    const r = await post(app, { pane: pane.id, key, ref: 'C123', text: 'exact text' });
    expect(r.status).toBe(202);
    expect((await r.json()).state).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://broker.test/requests');
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({
      action: 'slack.post',
      payload: { ref: 'C123', text: 'exact text' },
    });
    expect(options.headers).not.toHaveProperty('authorization');
    db.close();
  });

  it('never falls back to a local credential when the broker fails', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const fetchMock = vi.fn().mockRejectedValue(new Error('unreachable'));
    vi.stubGlobal('fetch', fetchMock);
    const { app, pane, key, db } = harness({ slack: true });
    const r = await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
    expect(r.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://broker.test/requests');
    const replacement = await app.request('/token', {
      method: 'PUT',
      headers: { Origin: 'https://muxpad.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'xoxp-other' }),
    });
    expect(replacement.status).toBe(403);
    db.close();
  });

  it.each([false, true])(
    'queues through the broker regardless of legacy workspace Slack=%s',
    async (slack) => {
      vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: 'request', state: 'pending' }), { status: 202 }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const { app, pane, key, db } = harness({ slack });
      const r = await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      expect(r.status).toBe(202);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://broker.test/requests');
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({ action: 'slack.post' });
      db.close();
    },
  );
  it('automatically advertises pending requests without payloads and clears them after a decision', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const id = '11111111-1111-4111-8111-111111111111';
    let state = 'pending';
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        id,
        state,
        expires: Date.now() + 300_000,
        payload: { text: 'private message' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { app, pane, key, db } = harness({ slack: true });
    try {
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(0);
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'private message' });
      const notice = await app.request(`/approvals?pane=${pane.id}`);
      expect(notice.headers.get('cache-control')).toBe('no-store');
      expect(await notice.json()).toEqual({
        pane: pane.id,
        pending: 1,
        incomplete: false,
        stale: false,
        approval_url: 'https://broker.test/review',
      });
      state = 'rejected';
      await app.request(`/requests/${id}?pane=${pane.id}&key=${key}`);
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(0);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/decision'))).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });
  it('does not notify for an already completed request under timed permission', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ id: '11111111-1111-4111-8111-111111111111', state: 'complete' }),
      })),
    );
    const { app, pane, key, db } = harness({ slack: true });
    try {
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(0);
    } finally {
      db.close();
    }
  });
  it('retains pending IDs across muxpad restart and removes definitively unknown broker requests', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const id = '22222222-2222-4222-8222-222222222222';
    let unknown = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: !unknown,
        status: unknown ? 400 : 200,
        json: async () => ({ id, state: 'pending', expires: Date.now() + 300_000 }),
      })),
    );
    const { app, pane, key, db } = harness({ slack: true });
    try {
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      const restarted = slackRoutes({ db, dataDir: dir });
      expect((await (await restarted.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(
        1,
      );
      unknown = true;
      // A second route instance models restart recovery before a CLI polls the ID.
      const recovered = slackRoutes({ db, dataDir: dir });
      await recovered.request(`/approvals?pane=${pane.id}`);
      await vi.waitFor(async () =>
        expect((await (await recovered.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(
          0,
        ),
      );
    } finally {
      db.close();
    }
  });
  it('bounds advisory storage and refresh concurrency without blocking granted actions at capacity', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    let serial = 0;
    let granted = false;
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const lookup = url.includes('/requests/');
        if (lookup) {
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
        }
        const id = lookup
          ? url.split('/').at(-1)
          : `${(++serial).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
        return {
          ok: true,
          json: async () => ({
            id,
            state: !lookup && granted ? 'complete' : 'pending',
            expires: Date.now() + 300_000,
          }),
        };
      }),
    );
    const { app, pane, key, db } = harness({ slack: true });
    try {
      for (let i = 0; i < 65; i++)
        expect((await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' })).status).toBe(
          202,
        );
      const notice = await (await app.request(`/approvals?pane=${pane.id}`)).json();
      expect(notice.pending).toBe(64);
      expect(notice.incomplete).toBe(true);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM slack_approval_notices').get() as { n: number }).n,
      ).toBe(65);
      granted = true;
      expect((await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' })).status).toBe(
        202,
      );
      await vi.waitFor(() => expect(maxActive).toBeGreaterThan(0));
      expect(maxActive).toBeLessThanOrEqual(2);
    } finally {
      db.close();
    }
  });
  it('contains background database cleanup failures and reports stale notification status', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const id = '33333333-3333-4333-8333-333333333333';
    let unknown = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: !unknown,
        status: unknown ? 400 : 200,
        json: async () => ({ id, state: 'pending', expires: Date.now() + 300_000 }),
      })),
    );
    const { app, pane, key, db } = harness({ slack: true });
    try {
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      db.exec(
        "CREATE TRIGGER fail_notice_delete BEFORE DELETE ON slack_approval_notices BEGIN SELECT RAISE(FAIL, 'test disk failure'); END;",
      );
      unknown = true;
      await app.request(`/approvals?pane=${pane.id}`);
      await vi.waitFor(async () =>
        expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).stale).toBe(true),
      );
    } finally {
      db.close();
    }
  });
  it('isolates ownership across panes and restart; status lookups cannot transfer or invent ownership', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const id = '44444444-4444-4444-8444-444444444444';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ id, state: 'pending', expires: Date.now() + 300_000 }),
      })),
    );
    const { app, pane, key, db } = harness({ slack: true });
    const other = new PaneStore(db).create({ tab_id: pane.tab_id, startup_cmd: '' });
    const otherKey = paneKeyFor(other.id)!;
    try {
      // Looking up a pending broker UUID is not evidence of who created it.
      await app.request(`/requests/${id}?pane=${other.id}&key=${otherKey}`);
      expect((await (await app.request(`/approvals?pane=${other.id}`)).json()).pending).toBe(0);
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'owned' });
      await app.request(`/requests/${id}?pane=${other.id}&key=${otherKey}`);
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(1);
      expect((await (await app.request(`/approvals?pane=${other.id}`)).json()).pending).toBe(0);
      const restarted = slackRoutes({ db, dataDir: dir });
      expect((await (await restarted.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(
        1,
      );
      expect((await (await restarted.request(`/approvals?pane=${other.id}`)).json()).pending).toBe(
        0,
      );
      expect((await restarted.request('/approvals')).status).toBe(400);
      expect((await restarted.request('/approvals?pane=unknown')).status).toBe(404);
      expect(db.prepare('SELECT pane_id FROM slack_approval_notices WHERE id = ?').get(id)).toEqual(
        { pane_id: pane.id },
      );
    } finally {
      db.close();
    }
  });

  it('retires legacy unowned notices and overflow without broadcasting on migration', async () => {
    const { pane, db } = harness({ slack: true });
    try {
      db.exec(
        'DROP TABLE slack_approval_notices; CREATE TABLE slack_approval_notices (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
      );
      const insert = db.prepare('INSERT INTO slack_approval_notices VALUES (?, ?)');
      insert.run('55555555-5555-4555-8555-555555555555', Date.now() + 300_000);
      insert.run('overflow', Date.now() + 300_000);
      const app = slackRoutes({ db, dataDir: dir });
      const status = await (await app.request(`/approvals?pane=${pane.id}`)).json();
      expect(status.pending).toBe(0);
      expect(status.incomplete).toBe(false);
      expect(db.prepare('SELECT * FROM slack_approval_notices').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('cleans terminal requests polled by CLI and never creates notices for invalid pane credentials', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const id = '66666666-6666-4666-8666-666666666666';
    let gone = false;
    const fetchMock = vi.fn(async () => ({
      ok: !gone,
      status: gone ? 404 : 200,
      json: async () => ({ id, state: 'pending', expires: Date.now() + 300_000 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { app, pane, key, db } = harness({ slack: true });
    try {
      expect(
        (await post(app, { pane: pane.id, key: 'wrong', ref: 'C123', text: 'hello' })).status,
      ).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      gone = true;
      await app.request(`/requests/${id}?pane=${pane.id}&key=${key}`);
      expect(db.prepare('SELECT * FROM slack_approval_notices').all()).toEqual([]);
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).pending).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps overflow and outage advisory status scoped to the owning pane', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    let serial = 0;
    let offline = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (offline) throw Error('offline');
        const id = url.includes('/requests/')
          ? url.split('/').at(-1)
          : `${(++serial).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
        return {
          ok: true,
          json: async () => ({ id, state: 'pending', expires: Date.now() + 300_000 }),
        };
      }),
    );
    const { app, pane, key, db } = harness({ slack: true });
    const other = new PaneStore(db).create({ tab_id: pane.tab_id, startup_cmd: '' });
    try {
      for (let i = 0; i < 65; i++)
        await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      offline = true;
      await app.request(`/approvals?pane=${pane.id}`);
      await vi.waitFor(async () =>
        expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).stale).toBe(true),
      );
      const otherStatus = await (await app.request(`/approvals?pane=${other.id}`)).json();
      expect(otherStatus).toMatchObject({ pending: 0, incomplete: false, stale: false });
      const restarted = slackRoutes({ db, dataDir: dir });
      expect(
        (await (await restarted.request(`/approvals?pane=${pane.id}`)).json()).incomplete,
      ).toBe(true);
      expect(
        (await (await restarted.request(`/approvals?pane=${other.id}`)).json()).incomplete,
      ).toBe(false);
    } finally {
      db.close();
    }
  });
  it('does not spread one pane refresh failure into another pane freshness', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    const firstId = '77777777-7777-4777-8777-777777777777';
    const secondId = '88888888-8888-4888-8888-888888888888';
    let created = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith(firstId)) throw Error('first request temporarily unavailable');
        const id = url.includes('/requests/') ? secondId : ++created === 1 ? firstId : secondId;
        return {
          ok: true,
          json: async () => ({ id, state: 'pending', expires: Date.now() + 300_000 }),
        };
      }),
    );
    const { app, pane, key, db } = harness({ slack: true });
    const other = new PaneStore(db).create({ tab_id: pane.tab_id, startup_cmd: '' });
    try {
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'hello' });
      await post(app, { pane: other.id, key: paneKeyFor(other.id), ref: 'C123', text: 'hello' });
      await app.request(`/approvals?pane=${pane.id}`);
      await vi.waitFor(async () =>
        expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).stale).toBe(true),
      );
      expect((await (await app.request(`/approvals?pane=${other.id}`)).json()).stale).toBe(false);
    } finally {
      db.close();
    }
  });

  it('retains the longest pane uncertainty deadline when multiple notice writes fail', async () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let serial = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: `${(++serial).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
          state: 'pending',
          expires: now + (serial === 1 ? 10_000 : 1000),
        }),
      })),
    );
    const { app, pane, key, db } = harness({ slack: true });
    try {
      db.exec(
        "CREATE TRIGGER fail_notice_insert BEFORE INSERT ON slack_approval_notices BEGIN SELECT RAISE(FAIL, 'disk failure'); END;",
      );
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'long' });
      await post(app, { pane: pane.id, key, ref: 'C123', text: 'short' });
      now += 2000;
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).stale).toBe(true);
      now += 9000;
      expect((await (await app.request(`/approvals?pane=${pane.id}`)).json()).stale).toBe(false);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });
});

describe('expanded Slack endpoints retain caller authentication and exact payloads', () => {
  it.each([
    ['/users?name=alona', 'slack.users', { name: 'alona' }],
    ['/thread?ref=C123&ts=1.2&limit=10', 'slack.thread', { ref: 'C123', ts: '1.2', limit: '10' }],
  ])(
    '%s uses the protected broker regardless of the retired workspace toggle',
    async (path, action, payload) => {
      vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
      const fetchMock = vi.fn(
        async (_url: unknown, _options: RequestInit) =>
          new Response(JSON.stringify({ state: 'pending' }), { status: 202 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      for (const enabled of [false, true]) {
        const { app, pane, key, db } = harness({ slack: enabled });
        const response = await app.request(`${path}&pane=${pane.id}&key=${key}`);
        expect(response.status).toBe(202);
        expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
          action,
          payload,
        });
        db.close();
      }
    },
  );
  it.each([
    ['/dm', 'slack.dm', { user: 'U123' }],
    ['/react', 'slack.react', { ref: 'C123', ts: '1.2', name: 'eyes', operation: 'remove' }],
    ['/edit', 'slack.edit', { ref: 'C123', ts: '1.2', text: 'literal $()' }],
    [
      '/upload',
      'slack.upload',
      { ref: 'C123', filename: 'a.txt', content: 'YQ==', text: 'caption', thread_ts: '1.2' },
    ],
    ['/post', 'slack.post', { ref: 'C123', text: 'reply', thread_ts: '1.2' }],
  ])(
    '%s retains exact action payload and refuses wrong-pane proof',
    async (path, action, payload) => {
      vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://broker.test');
      const fetchMock = vi.fn(
        async (_url: unknown, _options: RequestInit) =>
          new Response(JSON.stringify({ state: 'pending' }), { status: 202 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { app, pane, key, db } = harness({ slack: true });
      const send = (proof: string) =>
        app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pane: pane.id, key: proof, ...payload }),
        });
      expect((await send('wrong')).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await send(key)).status).toBe(202);
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ action, payload });
      db.close();
    },
  );
});
