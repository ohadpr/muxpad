import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../store/db.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, type TestApp } from '../test-helpers/createTestApp.js';

describe('attachments', () => {
  let test: TestApp;
  let paneId: string;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-att-'));
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
    const w = (await (
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
        body: JSON.stringify({ name: 'T', workspace_id: w.id }),
      })
    ).json()) as { id: string };
    const p = (await (
      await test.app.request(`/api/tabs/${t.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };
    paneId = p.id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('saves an uploaded image and returns its absolute path', async () => {
    const fd = new FormData();
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
      type: 'image/png',
    });
    fd.append('file', blob, 'pasted.png');
    const res = await test.app.request(`/api/panes/${paneId}/attachments`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/\.png$/);
    expect(readFileSync(body.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('returns 400 if file is missing', async () => {
    const fd = new FormData();
    const res = await test.app.request(`/api/panes/${paneId}/attachments`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing pane', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([0])]), 'x.bin');
    const res = await test.app.request('/api/panes/nope/attachments', {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(404);
  });
});
