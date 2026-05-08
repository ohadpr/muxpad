import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openDb } from '../store/db.js';
import { PaneManager } from '../runtime/PaneManager.js';

describe('panes routes', () => {
  let app: ReturnType<typeof createApp>;
  let workspaceId: string;
  let tmp: string;
  let mgr: PaneManager;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-panes-'));
    mgr = new PaneManager();
    app = createApp({ db: openDb(':memory:'), paneManager: mgr, dataDir: tmp });
    const w = (await (
      await app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    workspaceId = w.id;
  });

  afterEach(async () => {
    await mgr.killAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a pane with defaults', async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const p = (await res.json()) as { id: string; shell: string };
    expect(p.id).toBeTruthy();
    expect(p.shell).toMatch(/sh|zsh|bash/);
  });

  it('creates a pane with explicit shell + cmd', async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell: '/bin/sh', startup_cmd: 'echo hi', cwd: '/tmp' }),
    });
    const p = (await res.json()) as { startup_cmd: string };
    expect(p.startup_cmd).toBe('echo hi');
  });

  it('deletes a pane', async () => {
    const p = (await (
      await app.request(`/api/workspaces/${workspaceId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };
    const res = await app.request(`/api/panes/${p.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 creating pane in missing workspace', async () => {
    const res = await app.request('/api/workspaces/nope/panes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
