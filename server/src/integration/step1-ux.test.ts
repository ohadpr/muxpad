// Step 1 end-to-end against a REAL isolated instance: HTTP + WS + an in-process
// ptyd, with a FAKE runner speaking the /ws/agent-runner protocol (the same
// pattern agent-wait.test.ts uses). Everything here is torn down in afterAll —
// no live daemon, no ~/.muxpad, its own data dir and ephemeral port.
//
// Covers the seams the unit tests can't: a do-mode pane's startup command +
// the mode frame the server pushes to a connecting runner, the documented
// mid-session switch behavior, turn-done bumping the tab's last_activity_at,
// and GET /api/tabs carrying pinned + ordering data.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAgentBridge } from '../agent-bridge.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { TabActivity } from '../tab-activity.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const SID = '11111111-2222-3333-4444-555555555555';
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('Step 1 e2e — agent modes + the living sidebar', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let db: Database.Database;
  let ptyd: SpawnedPtyd;
  let cache: PtydCache;
  let wsServer: ReturnType<typeof attachWsServer>;
  let wsId: string;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-step1-'));
    db = openDb(':memory:');
    const events = new EventBus();
    const agentBridge = createAgentBridge();
    ptyd = await spawnPtyd();
    cache = new PtydCache();
    cache.attach(ptyd.client);
    const app = createApp({ db, ptyd: ptyd.client, cache, dataDir: tmp, events, agentBridge });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
    wsServer = attachWsServer({
      http: server as unknown as Server,
      db,
      ptyd: ptyd.client,
      cache,
      events,
      agentBridge,
      // Tiny throttle window so the throttled path is observable without
      // sleeping a minute; the forced paths are unaffected either way.
      tabActivity: new TabActivity(db, { throttleMs: 50 }),
    });
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  afterAll(async () => {
    for (const s of openSockets) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    await wsServer.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${port}`;
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  async function agentTab(body: Record<string, unknown> = {}) {
    const tab = await api<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', ...body }),
    });
    const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${tab.id}`);
    return { tab, paneId: detail.panes[0]!.id };
  }

  /** A fake runner that records every server→runner frame it receives. */
  async function connectRunner(paneId: string, sid = SID) {
    const sock = new WebSocket(`${base().replace('http', 'ws')}/ws/agent-runner/${paneId}`);
    const received: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => received.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      sock.once('open', () => res());
      sock.once('error', rej);
    });
    openSockets.push(sock);
    sock.send(JSON.stringify({ t: 'hello', sid, cwd: tmp, pid: 1, turnActive: false }));
    // Wait for the hello's own mode-convergence frame rather than a fixed
    // sleep: without this the helper can return BEFORE it lands, and a test
    // that snapshots `received.length` to isolate a later switch would then
    // see the hello frame bleed into its slice (flaky under load).
    const deadline = Date.now() + 5_000;
    while (!received.some((f) => f.t === 'mode') && Date.now() < deadline) {
      await settle(25);
    }
    return { sock, received };
  }

  const startupCmd = (paneId: string) =>
    (
      db.prepare('SELECT startup_cmd FROM panes WHERE id = ?').get(paneId) as {
        startup_cmd: string;
      }
    ).startup_cmd;
  const lastActivity = (tabId: string) =>
    (
      db.prepare('SELECT last_activity_at FROM tabs WHERE id = ?').get(tabId) as {
        last_activity_at: number | null;
      }
    ).last_activity_at;

  // ── Feature A ───────────────────────────────────────────────────────────

  it('a do-mode pane carries the overlay flag and the runner is told its mode on hello', async () => {
    const { paneId } = await agentTab({ mode: 'do' });
    expect(startupCmd(paneId)).toBe('muxpad agent --mode do');

    const { received } = await connectRunner(paneId, 'sid-do-1');
    // The server converges every connecting runner on the DB's mode, so a
    // runner that booted from a stale command can't run the wrong contract.
    expect(received.filter((f) => f.t === 'mode')).toEqual([{ t: 'mode', mode: 'do' }]);
    // …and the self-heal rewrite preserves the flag alongside --resume.
    expect(startupCmd(paneId)).toBe('muxpad agent --mode do --resume sid-do-1');
  });

  it('a deep pane is byte-for-byte the pre-mode shape and is told "deep"', async () => {
    const { paneId } = await agentTab();
    expect(startupCmd(paneId)).toBe('muxpad agent');
    const { received } = await connectRunner(paneId, 'sid-deep-1');
    expect(received.filter((f) => f.t === 'mode')).toEqual([{ t: 'mode', mode: 'deep' }]);
    expect(startupCmd(paneId)).toBe('muxpad agent --resume sid-deep-1');
  });

  it('a mid-session switch behaves exactly as documented: notify now, overlay on respawn', async () => {
    const { paneId } = await agentTab();
    const { received } = await connectRunner(paneId, 'sid-switch');
    const before = received.length;

    const patched = await api<{ mode: string }>(`/api/panes/${paneId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode: 'do' }),
    });
    await settle();

    expect(patched.mode).toBe('do');
    // 1. The live runner is NOTIFIED (it will prepend one <muxpad-mode> note).
    expect(received.slice(before)).toEqual([{ t: 'mode', mode: 'do' }]);
    // 2. The next RESPAWN gets the real system-prompt overlay — and the
    //    session is preserved (--resume intact), i.e. no respawn happened now.
    expect(startupCmd(paneId)).toBe('muxpad agent --mode do --resume sid-switch');
  });

  it('a switch with no runner connected still persists and arms the respawn', async () => {
    const { paneId } = await agentTab();
    await api(`/api/panes/${paneId}`, { method: 'PATCH', body: JSON.stringify({ mode: 'do' }) });
    expect(startupCmd(paneId)).toBe('muxpad agent --mode do');
  });

  it('the chat socket delivers the pane mode and re-pushes it on a switch', async () => {
    const { paneId } = await agentTab({ mode: 'do' });
    await connectRunner(paneId, 'sid-chat');
    const chat = new WebSocket(`${base().replace('http', 'ws')}/ws/chat/${paneId}`);
    const frames: Array<Record<string, unknown>> = [];
    chat.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      chat.once('open', () => res());
      chat.once('error', rej);
    });
    openSockets.push(chat);
    await settle();
    expect(frames.find((f) => f.t === 'session')?.mode).toBe('do');

    await api(`/api/panes/${paneId}`, { method: 'PATCH', body: JSON.stringify({ mode: 'deep' }) });
    await settle();
    const sessionFrames = frames.filter((f) => f.t === 'session');
    expect(sessionFrames.at(-1)?.mode).toBe('deep');
    chat.close();
  });

  // ── Feature B ───────────────────────────────────────────────────────────

  it('the session frame carries authoritative hasMessages (no empty-state flash)', async () => {
    // Regression: the empty state inferred "this chat is new" from
    // events.length === 0, which is true for a beat on EVERY reconnect while
    // history replays — so the "or open instead" offer flashed over real
    // conversations, and a click in that window hit a destructive route.
    const { paneId } = await agentTab({ mode: 'do' });
    await connectRunner(paneId, 'sid-hasmsg');
    const chat = new WebSocket(`${base().replace('http', 'ws')}/ws/chat/${paneId}`);
    const frames: Array<Record<string, unknown>> = [];
    chat.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      chat.once('open', () => res());
      chat.once('error', rej);
    });
    openSockets.push(chat);
    await settle();
    // A brand-new chat: the server says so explicitly, not by omission.
    const first = frames.find((f) => f.t === 'session');
    expect(first?.hasMessages).toBe(false);
    chat.close();
  });

  it('turn-done bumps the tab’s last_activity_at', async () => {
    const { tab, paneId } = await agentTab();
    const { sock } = await connectRunner(paneId, 'sid-activity');
    // Backdate so any bump is unambiguous.
    db.prepare('UPDATE tabs SET last_activity_at = 1 WHERE id = ?').run(tab.id);
    expect(lastActivity(tab.id)).toBe(1);

    sock.send(JSON.stringify({ t: 'turn-start' }));
    await settle(100);
    sock.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await settle();

    const after = lastActivity(tab.id);
    expect(after).not.toBeNull();
    expect(after as number).toBeGreaterThan(1);
  });

  it('turn-done is FORCED — two turns in quick succession both bump', async () => {
    const { tab, paneId } = await agentTab();
    const { sock } = await connectRunner(paneId, 'sid-activity-2');
    sock.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await settle(120);
    const first = lastActivity(tab.id) as number;
    sock.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await settle(120);
    expect(lastActivity(tab.id) as number).toBeGreaterThan(first);
  });

  it('GET /api/tabs returns pinned + last_activity_at and the pinned-first order', async () => {
    // A dedicated workspace so the panes/tabs created above can't perturb it.
    const ws2 = new WorkspaceStore(db).create({ name: 'W2' }).id;
    const mk = async (name: string) =>
      api<Tab>('/api/tabs', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: ws2, name }),
      });
    const a = await mk('A');
    const b = await mk('B');
    const c = await mk('C');
    const setAt = (id: string, at: number) =>
      db.prepare('UPDATE tabs SET last_activity_at = ? WHERE id = ?').run(at, id);
    setAt(a.id, 100);
    setAt(b.id, 300);
    setAt(c.id, 200);

    let list = await api<Tab[]>(`/api/tabs?workspaceId=${ws2}`);
    expect(list.map((t) => t.name)).toEqual(['B', 'C', 'A']); // recency
    expect(list.every((t) => t.pinned === false)).toBe(true);
    expect(list.every((t) => typeof t.last_activity_at === 'number')).toBe(true);

    // Pin the STALEST tab: it must jump to the front and stay there.
    await api(`/api/tabs/${a.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
    list = await api<Tab[]>(`/api/tabs?workspaceId=${ws2}`);
    expect(list.map((t) => t.name)).toEqual(['A', 'B', 'C']);
    expect(list[0]?.pinned).toBe(true);
    expect(list[1]?.pinned).toBe(false);
  });

  it('a user send bumps activity even before any turn completes', async () => {
    const { tab, paneId } = await agentTab();
    await connectRunner(paneId, 'sid-send');
    db.prepare('UPDATE tabs SET last_activity_at = 1 WHERE id = ?').run(tab.id);
    const res = await fetch(`${base()}/api/agent-sessions/${paneId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do the thing' }),
    });
    expect(res.status).toBe(202);
    await settle(100);
    expect(lastActivity(tab.id) as number).toBeGreaterThan(1);
  });
});
