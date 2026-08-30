// GET /api/panes/:id/url-health — the server-side answer to a question the
// browser cannot ask. Behind `tailscale serve` a dead backend still gets a 502
// from a live proxy; the browser's opaque no-cors probe reads that as alive and
// leaves the user staring at a blank iframe. Here the status is readable.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('pane url-health', () => {
  let test: TestApp;
  let tabId: string;
  let tmp: string;
  const stopServers: Array<() => Promise<void>> = [];

  /** A stand-in for the app behind the URL, answering everything with `status`. */
  async function appServer(status: number): Promise<string> {
    const srv = createServer((_req, res) => {
      res.statusCode = status;
      res.end('x');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    stopServers.push(
      () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => r());
        }),
    );
    return `http://127.0.0.1:${port}/`;
  }

  async function makePane(body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-urlhealth-'));
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
      })
    ).json()) as { id: string };
    tabId = t.id;
  });

  afterEach(async () => {
    for (const stop of stopServers.splice(0)) await stop();
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports a healthy app alive, with its real status', async () => {
    const url = await appServer(200);
    const pane = await makePane({ kind: 'url', url });
    const res = await test.app.request(`/api/panes/${pane.id}/url-health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alive: true, status: 200, reason: 'ok' });
  });

  it('reports a live proxy with a dead backend as DEAD — the bug', async () => {
    const url = await appServer(502);
    const pane = await makePane({ kind: 'url', url });
    const res = await test.app.request(
      `/api/panes/${pane.id}/url-health?url=${encodeURIComponent(url)}`,
    );
    expect(await res.json()).toMatchObject({ alive: false, status: 502, reason: 'gateway' });
  });

  it('reports nothing-listening as unreachable', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const url = `http://127.0.0.1:${port}/`;
    const pane = await makePane({ kind: 'url', url });
    const res = await test.app.request(`/api/panes/${pane.id}/url-health`);
    expect(await res.json()).toMatchObject({ alive: false, status: null, reason: 'unreachable' });
  });

  it('tolerates the cosmetic drift between the stored url and the asked-about one', async () => {
    const url = await appServer(200);
    const pane = await makePane({ kind: 'url', url });
    // Same address, no trailing slash. Cosmetic only — nothing about WHICH
    // resource is fetched changes.
    const asked = url.replace(/\/$/, '');
    const res = await test.app.request(
      `/api/panes/${pane.id}/url-health?url=${encodeURIComponent(asked)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alive: true });
  });

  it('refuses a query string the declared url does not have', async () => {
    // A probe is a real GET. If the query were ignored, a declared `…/admin`
    // would authorize `…/admin?delete=true` — a one-request side-effect
    // trigger through an endpoint that is only supposed to read liveness.
    const url = await appServer(200);
    const pane = await makePane({ kind: 'url', url });
    const asked = `${url.replace(/\/$/, '')}?delete=true`;
    const res = await test.app.request(
      `/api/panes/${pane.id}/url-health?url=${encodeURIComponent(asked)}`,
    );
    expect(res.status).toBe(403);
  });

  it('refuses to probe a url the pane never declared', async () => {
    const url = await appServer(200);
    const pane = await makePane({ kind: 'url', url });
    const res = await test.app.request(
      `/api/panes/${pane.id}/url-health?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    );
    expect(res.status).toBe(403);
  });

  it('refuses cloud-metadata / link-local targets even when the pane declares them', async () => {
    // The allowlist is populated by writes any tailnet caller can make, so
    // "declared" cannot be the only gate for an address with no legitimate use.
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const pane = await makePane({ kind: 'url', url });
      const res = await test.app.request(
        `/api/panes/${pane.id}/url-health?url=${encodeURIComponent(url)}`,
      );
      expect(res.status).toBe(403);
    }
  });

  it('refuses a non-http(s) scheme outright', async () => {
    const url = await appServer(200);
    const pane = await makePane({ kind: 'url', url });
    const res = await test.app.request(
      `/api/panes/${pane.id}/url-health?url=${encodeURIComponent('file:///etc/passwd')}`,
    );
    expect(res.status).toBe(403);
  });

  it('probes a DETECTED app url even after the tailnet rewrite', async () => {
    // `toReachableUrl` rewrites every localhost app URL to
    // `https://<tailnet-name>:port` before it reaches the cache, so on a real
    // install a detected URL is PUBLIC-class, not loopback. Gating detection
    // on loopback 403'd every one of them, which put the web face back on the
    // browser's blind probe — i.e. back on the 502-reads-as-healthy bug this
    // endpoint exists to fix. Detection must authorize a public origin.
    const url = await appServer(502);
    const shell = await makePane({ shell: '/bin/cat', cwd: '/tmp' });
    test.cache.setAppUrls(shell.id, [{ url, label: null, source: 'text' }]);
    const res = await test.app.request(
      `/api/panes/${shell.id}/url-health?url=${encodeURIComponent(url)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alive: false, status: 502, reason: 'gateway' });
  });

  it('a DETECTED url authorizes its ORIGIN only — never the path someone printed', async () => {
    // Nothing has to be WRITTEN to get a string into a pane's output: the
    // scanner takes full paths and queries off any line the pane prints. So a
    // detected entry buys a probe of `<origin>/` and nothing else — a planted
    // `…/config/apps/http` can't be turned into a real GET of that path.
    const origin = (await appServer(200)).replace(/\/$/, '');
    const hits: string[] = [];
    const srv = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.statusCode = 200;
      res.end('x');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    stopServers.push(
      () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => r());
        }),
    );
    const base = `http://127.0.0.1:${port}`;
    const shell = await makePane({ shell: '/bin/cat', cwd: '/tmp' });
    test.cache.setAppUrls(shell.id, [{ url: `${base}/`, label: null, source: 'text' }]);
    const res = await test.app.request(
      `/api/panes/${shell.id}/url-health?url=${encodeURIComponent(`${base}/config/apps/http?stop=1`)}`,
    );
    expect(res.status).toBe(200); // same origin → allowed…
    expect(hits).toEqual(['/']); // …but only the root was actually fetched
    expect(origin).toContain('http://127.0.0.1:'); // (sanity on the helper)
  });

  it('detection cannot authorize a PRIVATE target — that still needs a DB url', async () => {
    const shell = await makePane({ shell: '/bin/cat', cwd: '/tmp' });
    test.cache.setAppUrls(shell.id, [{ url: 'http://192.168.1.1/', label: null, source: 'text' }]);
    const res = await test.app.request(
      `/api/panes/${shell.id}/url-health?url=${encodeURIComponent('http://192.168.1.1/')}`,
    );
    expect(res.status).toBe(403);
  });

  it('400s a pane with no url at all, and 404s an unknown pane', async () => {
    const shell = await makePane({ shell: '/bin/cat', cwd: '/tmp' });
    expect((await test.app.request(`/api/panes/${shell.id}/url-health`)).status).toBe(400);
    expect((await test.app.request('/api/panes/nope/url-health')).status).toBe(404);
  });
});
