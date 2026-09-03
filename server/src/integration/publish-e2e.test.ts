import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localFunnel } from '../funnel.js';
import { createPublicApp } from '../public-server.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * Isolated-instance e2e for the publish primitive, over REAL sockets and
 * WITHOUT any funnel (localFunnel only — nothing here can exec tailscale or
 * expose a port beyond 127.0.0.1). The point of the raw-socket layer: undici
 * fetch normalizes `..` before sending, so literal-traversal probes must go
 * through node:http with the path passed verbatim.
 */

function rawGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('publish e2e (isolated instance, no funnel)', () => {
  let dataDir: string;
  let srcDir: string;
  let test: TestApp;
  let mainServer: HttpServer;
  let publicServer: HttpServer;
  let mainPort: number;
  let publicPort: number;
  let slug: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-pub-e2e-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-pub-e2e-src-'));

    // Public static server on a loopback ephemeral port.
    const publicDir = join(dataDir, 'public');
    mkdirSync(publicDir, { recursive: true });
    publicServer = await new Promise<HttpServer>((resolve) => {
      const s = serve(
        { fetch: createPublicApp(publicDir).fetch, port: 0, hostname: '127.0.0.1' },
        (info: AddressInfo) => {
          publicPort = info.port;
          resolve(s as unknown as HttpServer);
        },
      );
    });

    // Main app (full route mount incl. /api/publish) on its own port, with
    // the exec-free localFunnel — exactly what MUXPAD_NO_FUNNEL=1 wires up.
    test = await createTestApp({
      db: openDb(':memory:'),
      dataDir,
      publish: { funnel: localFunnel(publicPort, 'funnel disabled (MUXPAD_NO_FUNNEL=1)') },
    });
    mainServer = await new Promise<HttpServer>((resolve) => {
      const s = serve(
        { fetch: test.app.fetch, port: 0, hostname: '127.0.0.1' },
        (info: AddressInfo) => {
          mainPort = info.port;
          resolve(s as unknown as HttpServer);
        },
      );
    });

    // Publish a small site through the real main port.
    const site = join(srcDir, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), '<html>published</html>');
    writeFileSync(join(site, 'notes.txt'), 'notes');
    const res = await fetch(`http://127.0.0.1:${mainPort}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: site }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; url: string; warning?: string };
    slug = body.slug;
    expect(body.url).toBe(`http://127.0.0.1:${publicPort}/${slug}/`);
    expect(body.warning).toContain('MUXPAD_NO_FUNNEL');
  }, 30_000);

  afterAll(async () => {
    mainServer?.closeAllConnections();
    await new Promise<void>((r) => mainServer?.close(() => r()));
    publicServer?.closeAllConnections();
    await new Promise<void>((r) => publicServer?.close(() => r()));
    await test?.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('serves the published artifact on the public port', async () => {
    const res = await rawGet(publicPort, `/${slug}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('<html>published</html>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const txt = await rawGet(publicPort, `/${slug}/notes.txt`);
    expect(txt.status).toBe(200);
    expect(txt.body).toBe('notes');
  });

  it('exposes NO api on the public port (main port still has it)', async () => {
    for (const path of ['/api/health', '/api/workspaces', '/api/publish', '/ws/events']) {
      const res = await rawGet(publicPort, path);
      expect(res.status, path).toBe(404);
    }
    const main = await rawGet(mainPort, '/api/health');
    expect(main.status).toBe(200);
  });

  it('404s the root and traversal probes (literal and encoded)', async () => {
    expect((await rawGet(publicPort, '/')).status).toBe(404);
    const probes = [
      '/../../../../etc/hosts',
      '/../db.sqlite',
      `/${slug}/../../db.sqlite`,
      '/%2e%2e/%2e%2e/etc/hosts',
      `/${slug}/%2e%2e/%2e%2e/db.sqlite`,
      `/${slug}/..%2f..%2fdb.sqlite`,
      '/%2e%2e%2f%2e%2e%2fetc%2fhosts',
      `/${slug}/..%5c..%5cdb.sqlite`,
    ];
    for (const path of probes) {
      const res = await rawGet(publicPort, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('SQLite');
      expect(res.body, path).not.toContain('localhost');
    }
  });

  it('delete via the main port makes the slug 404 publicly', async () => {
    const del = await fetch(`http://127.0.0.1:${mainPort}/api/publish/${slug}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect((await rawGet(publicPort, `/${slug}/`)).status).toBe(404);
  });
});
