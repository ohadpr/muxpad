import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPaneKeys, initPaneKeys, paneKeyFor } from './pane-key.js';
import { slackRoutes } from './routes/slack.js';
import { setSlackToken } from './slack-secrets.js';
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
  if (opts.slack) new WorkspaceStore(db).setSlack(ws.id, true);
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
  it('refuses when the workspace does not have the capability', async () => {
    const { app, pane, key } = harness({ slack: false });
    setSlackToken(dir, 'xoxp-x');
    const r = await post(app, { pane: pane.id, key, ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('does not have Slack enabled');
  });

  it('refuses a pane named WITHOUT its key', async () => {
    // THE SPOOF, and the whole reason any of this exists. A personal chat
    // naming a work pane's id used to walk straight through, because the id
    // was the only input and the caller sets it.
    const { app, pane } = harness({ slack: true });
    setSlackToken(dir, 'xoxp-x');
    for (const key of ['', 'not-the-key', paneKeyFor('some-other-pane') as string]) {
      const r = await post(app, { pane: pane.id, key, ref: '#x', text: 'hi' });
      expect(r.status, JSON.stringify(key)).toBe(403);
      expect((await r.json()).error.message).toContain('cannot prove which workspace');
    }
  });

  it('refuses a pane that does not exist, even with a well-formed key', async () => {
    // A key proves "I am this pane"; it does not conjure the pane's row.
    const { app } = harness({ slack: true });
    setSlackToken(dir, 'xoxp-x');
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
    expect((await r.json()).error.message).toContain('no Slack token');
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

describe('the credential endpoint', () => {
  const put = (app: ReturnType<typeof harness>['app'], token: string, origin?: string) =>
    app.request('/token', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ token }),
    });

  it('cannot be set from the CLI', async () => {
    // Same rule as the capability switch. An agent that can install a
    // credential can install one it controls.
    const { app } = harness({ slack: true });
    const r = await put(app, 'xoxp-abc');
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('ui_only');
  });

  it('takes a user token from the UI', async () => {
    const { app } = harness({ slack: true });
    const r = await put(app, 'xoxp-abc1234', 'http://localhost:7777');
    expect(r.status).toBe(200);
    expect((await r.json()).hint).toBe('xoxp-…1234');
  });

  it('names the app-level token for what it is', async () => {
    // It sits next to the right one on Slack's own page, and Slack's error for
    // it names the method rather than the mistake.
    const { app } = harness({ slack: true });
    const r = await put(app, 'xapp-1-A0C-nope', 'http://localhost:7777');
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain('Socket Mode');
  });

  it('refuses a bot token — there is no bot identity to configure', async () => {
    const { app } = harness({ slack: true });
    const r = await put(app, 'xoxb-whatever', 'http://localhost:7777');
    expect(r.status).toBe(400);
  });

  it('never returns the token itself', async () => {
    const { app } = harness({ slack: true });
    setSlackToken(dir, 'xoxp-secret-value-9999');
    const body = await (await app.request('/token', { headers: { Origin: 'http://x' } })).json();
    expect(JSON.stringify(body)).not.toContain('secret-value');
    expect(body.hint).toBe('xoxp-…9999');
  });
});
