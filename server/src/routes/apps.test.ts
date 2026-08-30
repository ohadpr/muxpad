import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppWithStatus, UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '../store/AppStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

const OK: UrlHealth = { alive: true, status: 200, reason: 'ok', elapsedMs: 2 };
const GATEWAY: UrlHealth = { alive: false, status: 502, reason: 'gateway', elapsedMs: 2 };

let db: Database.Database;
let dir: string;
let harness: TestApp;
let health: UrlHealth = OK;
let gaveUpPane: string | null = null;

async function boot(withRegistry = true) {
  harness = await createTestApp({
    db,
    dataDir: dir,
    ...(withRegistry
      ? {
          apps: {
            probe: async () => health,
            gaveUp: (paneId: string) => paneId === gaveUpPane,
          },
        }
      : {}),
  });
}

const req = (path: string, init?: RequestInit) => harness.app.request(`http://local${path}`, init);
const post = (path: string, body?: unknown) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** A registration that passes every validation gate. */
function valid(over: Record<string, unknown> = {}) {
  return {
    name: 'Notes',
    cwd: dir,
    command: './start',
    url: 'http://127.0.0.1:4322',
    ...over,
  };
}

beforeEach(async () => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'apps-routes-'));
  health = OK;
  gaveUpPane = null;
  await boot();
});

afterEach(async () => {
  await harness.cleanup();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/apps', () => {
  it('is an empty list before anything is registered', async () => {
    const res = await req('/api/apps');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apps: [] });
  });

  it('measures status rather than echoing the row', async () => {
    await post('/api/apps', valid());
    // The app is registered and enabled, but nothing is listening: the probe
    // (not the row) is what decides.
    health = GATEWAY;
    const body = (await (await req('/api/apps')).json()) as { apps: AppWithStatus[] };
    const one = body.apps[0] as AppWithStatus;
    expect(one.enabled).toBe(true);
    expect(one.health).toEqual(GATEWAY);
    // Inside the startup grace it is honestly `starting`, not a failure.
    expect(one.state).toBe('starting');
  });

  it('reports gave_up straight from the supervisor ledger', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    gaveUpPane = created.pane_id;
    const body = (await (await req('/api/apps')).json()) as { apps: AppWithStatus[] };
    expect(body.apps[0]?.state).toBe('gave_up');
  });
});

describe('POST /api/apps', () => {
  it('registers, materialises a pane, and keeps the container hidden', async () => {
    const res = await post('/api/apps', valid());
    expect(res.status).toBe(201);
    const created = (await res.json()) as AppWithStatus;
    expect(created.slug).toBe('notes');
    expect(created.pane_id).toBeTruthy();
    expect(created.enabled).toBe(true);
    // The app's pane lives in a workspace no user-facing list ever returns.
    expect(new WorkspaceStore(db).list()).toEqual([]);
    expect(new WorkspaceStore(db).list({ all: true })).toHaveLength(1);
    // …and GET /api/workspaces (what the sidebar actually calls) agrees.
    expect(await (await req('/api/workspaces')).json()).toEqual([]);
  });

  it('start:false registers a genuinely stopped app — no pane at all', async () => {
    const created = (await (
      await post('/api/apps', valid({ start: false }))
    ).json()) as AppWithStatus;
    expect(created.enabled).toBe(false);
    expect(created.pane_id).toBeNull();
    expect(created.state).toBe('stopped');
  });

  it('derives a slug and de-duplicates it', async () => {
    const a = (await (
      await post('/api/apps', valid({ name: 'My Notes' }))
    ).json()) as AppWithStatus;
    expect(a.slug).toBe('my-notes');
    const b = (await (
      await post('/api/apps', valid({ name: 'My Notes' }))
    ).json()) as AppWithStatus;
    expect(b.slug).toBe('my-notes-2');
  });

  it('takes an explicit slug literally and 409s on a collision', async () => {
    await post('/api/apps', valid({ slug: 'notes' }));
    const res = await post('/api/apps', valid({ name: 'Other', slug: 'notes' }));
    expect(res.status).toBe(409);
  });

  // Bodies are built by a THUNK, not inline: `valid()` reads `dir`, which
  // beforeEach assigns — an inline table is evaluated at collection time, when
  // `dir` is still undefined, and every case would 400 for the wrong reason.
  it.each([
    ['a missing cwd', () => valid({ cwd: '/definitely/not/here' }), /no such directory/],
    ['a relative cwd', () => valid({ cwd: 'relative' }), /absolute/],
    ['a non-http url', () => valid({ url: 'file:///etc/passwd' }), /well-formed/],
    ['a quoted url', () => valid({ url: "http://x/'" }), /quotes/],
    ['a multi-line command', () => valid({ command: 'a\nb' }), /single line/],
    ['an empty name', () => valid({ name: '' }), /./],
    ['a bad explicit slug', () => valid({ slug: 'Not A Slug' }), /slug/],
  ])('rejects %s', async (_label, body, message) => {
    const res = await post('/api/apps', body());
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(message);
  });

  it('rejects a name that yields no slug rather than inventing one', async () => {
    const res = await post('/api/apps', valid({ name: '🙂' }));
    expect(res.status).toBe(400);
  });
});

describe('start / stop / delete', () => {
  it('stop kills the pane; start builds a fresh one; neither loses the row', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    const firstPane = created.pane_id as string;

    const stopped = (await (await post(`/api/apps/${created.slug}/stop`)).json()) as AppWithStatus;
    expect(stopped.state).toBe('stopped');
    expect(stopped.pane_id).toBeNull();
    expect(await harness.ptyd.client.hasPane(firstPane)).toBe(false);

    const started = (await (await post(`/api/apps/${created.slug}/start`)).json()) as AppWithStatus;
    expect(started.enabled).toBe(true);
    expect(started.pane_id).toBeTruthy();
    expect(started.pane_id).not.toBe(firstPane);
  });

  it('DELETE removes the row and the pane together', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    const paneId = created.pane_id as string;
    const res = await req(`/api/apps/${created.slug}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(new AppStore(db).list()).toEqual([]);
    expect(db.prepare('SELECT id FROM panes WHERE id = ?').get(paneId)).toBeUndefined();
    expect(await harness.ptyd.client.hasPane(paneId)).toBe(false);
  });

  it.each(['start', 'stop'])('404s on an unknown ref (%s)', async (verb) => {
    expect((await post(`/api/apps/nope/${verb}`)).status).toBe(404);
  });

  it('404s deleting an unknown app', async () => {
    expect((await req('/api/apps/nope', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /api/apps/:ref', () => {
  it('resolves by slug and by id', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    expect(((await (await req(`/api/apps/${created.slug}`)).json()) as AppWithStatus).id).toBe(
      created.id,
    );
    expect(((await (await req(`/api/apps/${created.id}`)).json()) as AppWithStatus).slug).toBe(
      created.slug,
    );
  });

  it('404s on an unknown ref', async () => {
    expect((await req('/api/apps/nope')).status).toBe(404);
  });
});

describe('PATCH /api/apps/:ref', () => {
  it('rebuilds a running app when the command changes', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    const before = created.pane_id;
    const res = await req(`/api/apps/${created.slug}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: './other' }),
    });
    const patched = (await res.json()) as AppWithStatus;
    expect(patched.command).toBe('./other');
    // The startup command is only read when the pty is created, so an edit that
    // did NOT rebuild would leave the registry and the process disagreeing.
    expect(patched.pane_id).not.toBe(before);
    const pane = db.prepare('SELECT startup_cmd FROM panes WHERE id = ?').get(patched.pane_id) as {
      startup_cmd: string;
    };
    expect(pane.startup_cmd).toContain('./other');
  });

  it('does not rebuild for a hot field (autostart)', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    const res = await req(`/api/apps/${created.slug}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autostart: false }),
    });
    const patched = (await res.json()) as AppWithStatus;
    expect(patched.autostart).toBe(false);
    expect(patched.pane_id).toBe(created.pane_id);
  });

  it('validates the same way POST does', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    for (const body of [{ cwd: '/nope/nope' }, { url: 'ftp://x' }, { command: 'a\nb' }]) {
      const res = await req(`/api/apps/${created.slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('404s on an unknown ref', async () => {
    const res = await req('/api/apps/nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('without a registry (HTTP-only wiring)', () => {
  beforeEach(async () => {
    await harness.cleanup();
    await boot(false);
  });

  it('reads work and writes 503 — never a 404 that hides the wiring', async () => {
    expect((await req('/api/apps')).status).toBe(200);
    expect((await post('/api/apps', valid())).status).toBe(503);
    expect((await post('/api/apps/x/start')).status).toBe(503);
    expect((await req('/api/apps/x', { method: 'DELETE' })).status).toBe(503);
  });

  it('degrades status honestly instead of inventing one', async () => {
    new AppStore(db).create({
      slug: 'notes',
      name: 'Notes',
      cwd: dir,
      command: './start',
      url: 'http://127.0.0.1:1',
    });
    const body = (await (await req('/api/apps')).json()) as { apps: AppWithStatus[] };
    expect(body.apps[0]?.pty).toBeNull();
    expect(body.apps[0]?.health).toBeNull();
  });
});

describe('the hidden container does not leak', () => {
  it('keeps an app pane out of GET /api/panes — the map agents are pointed at', async () => {
    const created = (await (await post('/api/apps', valid())).json()) as AppWithStatus;
    // `muxpad pane list --all` reads this, and the universal agent
    // instructions teach `muxpad pane send <id>` in the very next breath.
    // Listing an app's pane here invites an agent to type keystrokes into a
    // running web server it has no business touching.
    const listed = (await (await req('/api/panes')).json()) as Array<{
      id: string;
      workspace_name: string;
    }>;
    expect(listed.map((p) => p.id)).not.toContain(created.pane_id);
    expect(listed.map((p) => p.workspace_name)).not.toContain('· apps ·');

    // …but ?all=1 still reaches it, for debugging a stuck pty. Same convention
    // as GET /api/workspaces?all=1.
    const all = (await (await req('/api/panes?all=1')).json()) as Array<{ id: string }>;
    expect(all.map((p) => p.id)).toContain(created.pane_id);
  });

  it('keeps the container out of the workspace list the sidebar reads', async () => {
    await post('/api/apps', valid());
    expect(await (await req('/api/workspaces')).json()).toEqual([]);
    expect((await (await req('/api/workspaces?all=1')).json()) as unknown[]).toHaveLength(1);
  });
});
