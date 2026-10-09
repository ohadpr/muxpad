import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtydClient } from './ptyd-client/PtydClient.js';
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
 * Here the only identity input is a PID, and the server decides what it means
 * by walking the process ancestry. The test below that matters most is the one
 * where a caller hands over a pid that is not under the pane it wants.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slackroute-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts: { slack: boolean; panePid?: number }) {
  const db = openDb(':memory:');
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  if (opts.slack) new WorkspaceStore(db).setSlack(ws.id, true);
  const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '' });
  const panePids = vi.fn(async () => [{ id: pane.id, pid: opts.panePid ?? process.ppid }]);
  const app = slackRoutes({
    db,
    dataDir: dir,
    ptyd: { panePids } as unknown as PtydClient,
  });
  return { app, ws, pane, panePids, db };
}

const post = (app: ReturnType<typeof harness>['app'], body: unknown, origin?: string) =>
  app.request('/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

describe('authorizing a Slack call', () => {
  it('refuses when the workspace does not have the capability', async () => {
    const { app } = harness({ slack: false });
    setSlackToken(dir, 'xoxp-x');
    const r = await post(app, { pid: process.pid, ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('does not have Slack enabled');
  });

  it('refuses a pid that is not running under any pane', async () => {
    // THE SPOOF. The caller names a real pid — its own — but it is not a
    // descendant of the pane whose capability it wants. Under the old guard
    // this was simply a string in an env var and always succeeded.
    const { app } = harness({ slack: true, panePid: 999_999 });
    setSlackToken(dir, 'xoxp-x');
    const r = await post(app, { pid: process.pid, ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('cannot tell which pane');
  });

  it('refuses when there is no pid at all', async () => {
    const { app } = harness({ slack: true });
    const r = await post(app, { pid: 1, ref: '#x', text: 'hi' });
    expect(r.status).toBe(400);
  });

  it('refuses an enabled workspace with no credential — and says so plainly', async () => {
    const { app } = harness({ slack: true });
    const r = await post(app, { pid: process.pid, ref: '#x', text: 'hi' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('no Slack token');
  });

  it('gates read, search and channels exactly like post', async () => {
    // The first cut gated only sending, on the reasoning that the risk is data
    // going OUT. A personal chat could then run `slack channels` and list
    // every private channel in the company.
    const { app } = harness({ slack: false });
    for (const path of ['/read?pid=', '/search?pid=', '/channels?pid=']) {
      const r = await app.request(`${path}${process.pid}&ref=%23x&q=x`);
      expect(r.status, path).toBe(403);
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
