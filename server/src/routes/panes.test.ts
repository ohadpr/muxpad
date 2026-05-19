import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../store/db.js';
import { EventBus } from '../events.js';
import type { MuxpadEvent } from '@muxpad/shared';
import { createTestApp, type TestApp } from '../test-helpers/createTestApp.js';

describe('panes routes', () => {
  let test: TestApp;
  let wsId: string;
  let tabId: string;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-panes-'));
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
    // Bootstrap a workspace + tab to scope panes under.
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    wsId = ws.id;
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
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a pane with defaults', async () => {
    const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
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
    const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell: '/bin/sh', startup_cmd: 'echo hi', cwd: '/tmp' }),
    });
    const p = (await res.json()) as { startup_cmd: string };
    expect(p.startup_cmd).toBe('echo hi');
  });

  it('deletes a pane', async () => {
    const p = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${p.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 creating pane in missing tab', async () => {
    const res = await test.app.request('/api/tabs/nope/panes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('append_to_layout splices new pane at the layout root when no source', async () => {
    // Fresh tab — layout starts empty (or a single-pane string), append
    // sets the new pane as the root.
    const tab2 = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'L', workspace_id: wsId }),
      })
    ).json()) as { id: string };
    const p1 = (await (
      await test.app.request(`/api/tabs/${tab2.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ append_to_layout: true }),
      })
    ).json()) as { id: string };
    const after = (await (await test.app.request(`/api/tabs/${tab2.id}`)).json()) as {
      layout: unknown;
    };
    expect(after.layout).toBe(p1.id);
  });

  it('append_to_layout with split_from splits right of the source pane', async () => {
    const tab2 = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'S', workspace_id: wsId }),
      })
    ).json()) as { id: string };
    const p1 = (await (
      await test.app.request(`/api/tabs/${tab2.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ append_to_layout: true }),
      })
    ).json()) as { id: string };
    const p2 = (await (
      await test.app.request(`/api/tabs/${tab2.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ append_to_layout: true, split_from: p1.id }),
      })
    ).json()) as { id: string };
    const after = (await (await test.app.request(`/api/tabs/${tab2.id}`)).json()) as {
      layout: { direction: string; first: string; second: string };
    };
    expect(after.layout).toMatchObject({ direction: 'row', first: p1.id, second: p2.id });
  });

  it('omitting append_to_layout leaves the tab layout untouched (UI behavior)', async () => {
    const before = (await (await test.app.request(`/api/tabs/${tabId}`)).json()) as {
      layout: unknown;
    };
    await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const after = (await (await test.app.request(`/api/tabs/${tabId}`)).json()) as {
      layout: unknown;
    };
    expect(after.layout).toEqual(before.layout);
  });

  it('creates a url pane with kind=url and url', async () => {
    const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'url', url: 'https://example.com' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; url: string; shell: string | null };
    expect(body.kind).toBe('url');
    expect(body.url).toBe('https://example.com');
    expect(body.shell).toBeNull();
  });

  it('rejects kind=url without url', async () => {
    const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'url' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects shell/cwd/startup_cmd combined with kind=url', async () => {
    const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'url', url: 'https://x.example.com', startup_cmd: 'vim' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /panes/:id updates url for a url pane', async () => {
    const created = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'url', url: 'https://a.example.com' }),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ url: 'https://b.example.com' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { url: string };
    expect(updated.url).toBe('https://b.example.com');
  });

  it('PATCH rejects url update on shell panes', async () => {
    const created = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ url: 'https://x.example.com' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH flips shell → url, killing the PTY and updating the row', async () => {
    const created = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'url' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      kind: string;
      url: string | null;
      shell: string | null;
      cwd: string | null;
    };
    expect(updated.kind).toBe('url');
    expect(updated.url).toBeNull();
    expect(updated.shell).toBeNull();
    expect(updated.cwd).toBeNull();
  });

  it('PATCH flips url → shell with default shell + cwd', async () => {
    const created = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'url', url: 'https://example.com' }),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'shell' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      kind: string;
      url: string | null;
      shell: string | null;
    };
    expect(updated.kind).toBe('shell');
    expect(updated.url).toBeNull();
    expect(updated.shell).toBeTruthy();
  });

  it('PATCH with same kind ignores the kind field', async () => {
    const created = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string; shell: string; cwd: string };
    const res = await test.app.request(`/api/panes/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'shell' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const after = (await res.json()) as { kind: string; shell: string; cwd: string };
    expect(after.kind).toBe('shell');
    // Row unchanged — same shell/cwd it was created with.
    expect(after.shell).toBe(created.shell);
    expect(after.cwd).toBe(created.cwd);
  });

  it('POST /panes emits pane.added on the event bus', async () => {
    // Locks in the route → EventBus wiring. We boot a *separate* app with
    // our own bus so we can subscribe before issuing the request and
    // assert on the broadcast payload end-to-end.
    const events = new EventBus();
    const local = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events });
    try {
      const ws = (await (
        await local.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'W' }),
        })
      ).json()) as { id: string };
      const t = (await (
        await local.app.request('/api/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
        })
      ).json()) as { id: string };

      const received: MuxpadEvent[] = [];
      events.subscribe((e) => received.push(e));

      const res = await local.app.request(`/api/tabs/${t.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'url', url: 'https://example.com' }),
      });
      const body = (await res.json()) as { id: string };

      const added = received.find((e) => e.type === 'pane.added');
      expect(added).toBeDefined();
      expect(added!.type).toBe('pane.added');
      if (added?.type === 'pane.added') {
        expect(added.tab_id).toBe(t.id);
        expect(added.pane.id).toBe(body.id);
        expect(added.pane.kind).toBe('url');
        expect(added.pane.url).toBe('https://example.com');
      }
    } finally {
      await local.cleanup();
    }
  });

  it('DELETE /panes emits pane.removed with tab_id captured before delete', async () => {
    const events = new EventBus();
    const local = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events });
    try {
      const ws = (await (
        await local.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'W' }),
        })
      ).json()) as { id: string };
      const t = (await (
        await local.app.request('/api/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
        })
      ).json()) as { id: string };
      const created = (await (
        await local.app.request(`/api/tabs/${t.id}/panes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'url', url: 'https://x.example.com' }),
        })
      ).json()) as { id: string };

      const received: MuxpadEvent[] = [];
      events.subscribe((e) => received.push(e));

      const res = await local.app.request(`/api/panes/${created.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      const removed = received.find((e) => e.type === 'pane.removed');
      expect(removed).toBeDefined();
      if (removed?.type === 'pane.removed') {
        expect(removed.tab_id).toBe(t.id);
        expect(removed.pane_id).toBe(created.id);
      }
    } finally {
      await local.cleanup();
    }
  });

  it('rejects respawn on a url pane with 400', async () => {
    // URL panes have no PTY — respawn is nonsensical and must be guarded
    // so ptyd never sees a null-shell spec.
    const { PaneStore } = await import('../store/PaneStore.js');
    const db = openDb(':memory:');
    const local = await createTestApp({ db, dataDir: tmp });
    try {
      const ws = (await (
        await local.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'W' }),
        })
      ).json()) as { id: string };
      const t = (await (
        await local.app.request('/api/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
        })
      ).json()) as { id: string };
      const panes = new PaneStore(db);
      const urlPane = panes.create({ tab_id: t.id, kind: 'url', url: 'https://example.com' });

      const res = await local.app.request(`/api/panes/${urlPane.id}/respawn`, {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    } finally {
      await local.cleanup();
    }
  });
});
