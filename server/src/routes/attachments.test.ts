import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../store/db.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('serves a stored attachment by filename over HTTP', async () => {
    const fd = new FormData();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'pasted.png');
    const up = (await (
      await test.app.request(`/api/panes/${paneId}/attachments`, { method: 'POST', body: fd })
    ).json()) as { path: string };
    const name = up.path.split('/').pop() as string;

    const res = await test.app.request(`/api/panes/attachments/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  // --- Agent-shared files (show_files → by-path) + Range streaming ---

  // Copy a source file into the served dir and return its bare filename.
  async function share(bytes: Buffer, ext: string): Promise<string> {
    const src = join(tmp, `source${ext}`);
    writeFileSync(src, bytes);
    const res = await test.app.request(`/api/panes/${paneId}/attachments/by-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: src }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    return body.path.split('/').pop() as string;
  }

  it('shares a file by absolute path and serves it whole', async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const name = await share(bytes, '.mp4');
    const res = await test.app.request(`/api/panes/attachments/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('honors byte ranges: normal, suffix, open-ended, over-long, unsatisfiable', async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const name = await share(bytes, '.mp4');
    const get = (range: string) =>
      test.app.request(`/api/panes/attachments/${name}`, { headers: { range } });

    // normal closed range
    let r = await get('bytes=0-99');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(r.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(0, 100));

    // suffix range: the FINAL 100 bytes (regression: used to serve the first 100)
    r = await get('bytes=-100');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(900, 1000));

    // open-ended: start to EOF
    r = await get('bytes=990-');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 990-999/1000');

    // over-long end clamps to size-1 (regression: used to 416)
    r = await get('bytes=0-100000');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-999/1000');
    expect(r.headers.get('content-length')).toBe('1000');

    // start past EOF is unsatisfiable
    r = await get('bytes=5000-6000');
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */1000');
  });

  it('by-path rejects unsupported types and missing sources', async () => {
    const exe = join(tmp, 'tool.exe');
    writeFileSync(exe, Buffer.from([0]));
    expect(
      (
        await test.app.request(`/api/panes/${paneId}/attachments/by-path`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: exe }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await test.app.request(`/api/panes/${paneId}/attachments/by-path`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: join(tmp, 'ghost.png') }),
        })
      ).status,
    ).toBe(404);
  });

  it('rejects path traversal and unsupported names', async () => {
    // basename-only guard: a nested/relative name never resolves.
    expect((await test.app.request('/api/panes/attachments/..%2f..%2fdb.sqlite')).status).toBe(400);
    // attachment-extension allowlist: .sqlite/.exe aren't in the shared map.
    expect((await test.app.request('/api/panes/attachments/db.sqlite')).status).toBe(400);
    // a supported non-image type (.txt) passes the allowlist; absent → 404.
    expect((await test.app.request('/api/panes/attachments/notes.txt')).status).toBe(404);
    // well-formed but absent.
    expect((await test.app.request('/api/panes/attachments/deadbeef.png')).status).toBe(404);
  });
});
