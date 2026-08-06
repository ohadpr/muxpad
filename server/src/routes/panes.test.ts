import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

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

  it('rejects non-http(s) pane URLs (javascript:/data:/file:) on create and patch', async () => {
    // These schemes pass z.string().url() but land in an allow-scripts iframe —
    // the http(s) allowlist is what keeps a script/local-file payload out.
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
    ]) {
      const res = await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'url', url }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status, url).toBe(400);
    }
    // PATCH face_url is the same iframe sink — same gate, but '' still clears it.
    const shell = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const bad = await test.app.request(`/api/panes/${shell.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ face: 'web', face_url: 'javascript:alert(1)' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    const clear = await test.app.request(`/api/panes/${shell.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ face_url: '' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(clear.status).toBe(200);
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

  it('chat face is agent-pane-only on both create and patch', async () => {
    // POST: plain shell pane asking for the chat face → rejected.
    const bad = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify({ face: 'chat' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    // POST: agent pane (startup_cmd marker) → allowed.
    const good = await test.app.request(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify({ face: 'chat', startup_cmd: 'muxpad agent' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(good.status).toBe(201);
    const agentPane = (await good.json()) as { id: string; face: string };
    expect(agentPane.face).toBe('chat');
    // PATCH: flipping a non-agent pane to chat → rejected; terminal/web fine.
    const shell = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const patchBad = await test.app.request(`/api/panes/${shell.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ face: 'chat' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patchBad.status).toBe(400);
    const patchOk = await test.app.request(`/api/panes/${shell.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ face: 'web', face_url: 'https://x.example.com' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patchOk.status).toBe(200);
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

  // ── pane move (POST /api/panes/:id/move) ──────────────────────────────

  /** Make a pane in `tab`, returning its id. */
  const makePane = async (tab: string): Promise<string> => {
    const p = (await (
      await test.app.request(`/api/tabs/${tab}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };
    return p.id;
  };
  const getLayout = async (tab: string): Promise<unknown> =>
    ((await (await test.app.request(`/api/tabs/${tab}`)).json()) as { layout: unknown }).layout;
  const setLayout = (tab: string, layout: unknown) =>
    test.app.request(`/api/tabs/${tab}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    });
  const move = (paneId: string, body: unknown) =>
    test.app.request(`/api/panes/${paneId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const mkTab = async (name: string, workspace = wsId): Promise<string> =>
    (
      (await (
        await test.app.request('/api/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, workspace_id: workspace }),
        })
      ).json()) as { id: string }
    ).id;

  it('moves a pane to an existing tab: source loses it, dest gains it', async () => {
    const a = await makePane(tabId);
    const b = await makePane(tabId);
    await setLayout(tabId, { direction: 'row', first: a, second: b });
    const dest = await mkTab('Dest');
    const d1 = await makePane(dest);
    await setLayout(dest, d1);

    const res = await move(a, { to_tab_id: dest });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from_tab_removed: boolean; to_tab: { id: string } };
    expect(body.from_tab_removed).toBe(false);
    expect(body.to_tab.id).toBe(dest);

    // Source collapsed to just b; dest now a split holding d1 + a.
    expect(await getLayout(tabId)).toBe(b);
    expect(await getLayout(dest)).toMatchObject({ direction: 'row', first: d1, second: a });
    // The pane row really reparented.
    const detail = (await (await test.app.request(`/api/tabs/${dest}`)).json()) as {
      panes: { id: string }[];
    };
    expect(detail.panes.map((p) => p.id).sort()).toEqual([a, d1].sort());
  });

  it('moving the last pane out deletes the now-empty source tab', async () => {
    const only = await makePane(tabId);
    await setLayout(tabId, only);
    const dest = await mkTab('Dest');
    await setLayout(dest, await makePane(dest));

    const res = await move(only, { to_tab_id: dest });
    const body = (await res.json()) as { from_tab_removed: boolean };
    expect(body.from_tab_removed).toBe(true);
    expect((await test.app.request(`/api/tabs/${tabId}`)).status).toBe(404);
  });

  it('extracts a pane into a fresh tab (new_tab)', async () => {
    const a = await makePane(tabId);
    const b = await makePane(tabId);
    await setLayout(tabId, { direction: 'row', first: a, second: b });

    const res = await move(a, { new_tab: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { to_tab: { id: string }; from_tab_removed: boolean };
    expect(body.from_tab_removed).toBe(false);
    // New tab holds exactly the extracted pane as its root.
    expect(await getLayout(body.to_tab.id)).toBe(a);
    // Source collapsed to b.
    expect(await getLayout(tabId)).toBe(b);
  });

  it('extracting the SOLE pane of a tab is a no-op (keeps the tab intact)', async () => {
    const only = await makePane(tabId);
    await setLayout(tabId, only);
    const res = await move(only, { new_tab: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from_tab_id: string; to_tab: { id: string } };
    // Returns the SAME tab — no new tab created, source not deleted.
    expect(body.to_tab.id).toBe(tabId);
    expect(body.from_tab_id).toBe(tabId);
    expect((await test.app.request(`/api/tabs/${tabId}`)).status).toBe(200);
    expect(await getLayout(tabId)).toBe(only);
  });

  it('moves a pane to a tab in a different workspace (metadata-only re-home)', async () => {
    // Cross-workspace moves are allowed: ptys and agent runners key by pane
    // id, so nothing running notices, and the sidebar drop targets span
    // workspaces. The response names the SOURCE workspace so the caller can
    // refresh its tab cache.
    const a = await makePane(tabId);
    await setLayout(tabId, a);
    const otherWs = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Other' }),
      })
    ).json()) as { id: string };
    const foreignTab = await mkTab('Foreign', otherWs.id);
    const res = await move(a, { to_tab_id: foreignTab });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      to_tab: { id: string };
      from_workspace_id: string;
      from_tab_removed: boolean;
    };
    expect(body.to_tab.id).toBe(foreignTab);
    expect(body.from_workspace_id).toBe(wsId);
    expect(body.from_tab_removed).toBe(true); // `a` was the source's only pane
    expect(await getLayout(foreignTab)).toBe(a);
  });

  it('move emits dest pane.added + source pane.removed', async () => {
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
      const mk = async (name: string) =>
        (
          (await (
            await local.app.request('/api/tabs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, workspace_id: ws.id }),
            })
          ).json()) as { id: string }
        ).id;
      const src = await mk('Src');
      const dst = await mk('Dst');
      const mkP = async (tab: string) =>
        (
          (await (
            await local.app.request(`/api/tabs/${tab}/panes`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
          ).json()) as { id: string }
        ).id;
      const keep = await mkP(src);
      const moving = await mkP(src);
      await local.app.request(`/api/tabs/${src}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout: { direction: 'row', first: keep, second: moving } }),
      });
      await local.app.request(`/api/tabs/${dst}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout: await mkP(dst) }),
      });

      const received: MuxpadEvent[] = [];
      events.subscribe((e) => received.push(e));
      await local.app.request(`/api/panes/${moving}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to_tab_id: dst }),
      });

      const added = received.find((e) => e.type === 'pane.added');
      const removed = received.find((e) => e.type === 'pane.removed');
      expect(added?.type === 'pane.added' && added.tab_id).toBe(dst);
      expect(removed?.type === 'pane.removed' && removed.pane_id).toBe(moving);
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

  it('as-terminal converts a --pick pane into a plain terminal', async () => {
    const p = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startup_cmd: 'muxpad agent --pick', face: 'chat' }),
      })
    ).json()) as { id: string; startup_cmd: string; face: string };
    expect(p.startup_cmd).toBe('muxpad agent --pick');
    expect(p.face).toBe('chat');

    const res = await test.app.request(`/api/panes/${p.id}/as-terminal`, { method: 'POST' });
    expect(res.status).toBe(204);

    const got = (await (await test.app.request(`/api/panes/${p.id}`)).json()) as {
      startup_cmd: string | null;
      face: string;
    };
    expect(got.startup_cmd).toBeNull();
    expect(got.face).toBe('terminal');
  });

  it('as-terminal rejects non-pick panes with 409', async () => {
    const p = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${p.id}/as-terminal`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('as-web converts a --pick pane into a blank URL pane', async () => {
    const p = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startup_cmd: 'muxpad agent --pick', face: 'chat' }),
      })
    ).json()) as { id: string };

    const res = await test.app.request(`/api/panes/${p.id}/as-web`, { method: 'POST' });
    expect(res.status).toBe(204);

    const got = (await (await test.app.request(`/api/panes/${p.id}`)).json()) as {
      kind: string;
      url: string | null;
      startup_cmd: string | null;
    };
    expect(got.kind).toBe('url');
    expect(got.url).toBeNull();
    expect(got.startup_cmd).toBeNull();
  });

  it('as-web rejects non-pick panes with 409', async () => {
    const p = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };
    const res = await test.app.request(`/api/panes/${p.id}/as-web`, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
