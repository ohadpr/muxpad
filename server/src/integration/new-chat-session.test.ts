// THE ASSERTION NOBODY HAD: tapping "New chat" in the web app ends up with a
// LIVE AGENT SESSION, not a tab that merely exists.
//
// The web app's whole create path is one call — `POST /api/tabs` with
// HOUSE_CHAT_CREATE — and every test around it stopped at "the rows are
// right". Rows being right is exactly what a dead New chat tab looks like:
// correct tab, correct pane, correct startup_cmd, and no runner. The two
// steps that actually make it a chat were untested, so this covers both.
//
//   1. THE EAGER SPAWN HAPPENED. bootstrapTab asks ptyd for the pty inside a
//      `try { } catch { }` whose comment claims the runtime will "spawn lazily
//      when a client attaches" — which is not true for a chat-face pane,
//      because the chat view attaches to /ws/chat, never to the pty. If that
//      call silently fails, nothing else starts the agent.
//
//   2. A CLIENT THAT CONNECTED FIRST STILL LEARNS. The runner takes seconds to
//      boot, so the web client reliably opens /ws/chat BEFORE any session
//      exists and gets `session: null`. It must be told when the runner
//      arrives; a one-shot hello would leave the chat empty forever, which is
//      precisely the reported symptom.
//
// Fully isolated: own tmpdir data dir, own ptyd socket, ephemeral loopback
// port. MUXPAD_PORT is pointed at this instance before any pane spawns so a
// pty's injected MUXPAD_API_URL can never reach the live cockpit on 7777.
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
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

/** The body web/src/lib/agent-backend.ts's HOUSE_CHAT_CREATE produces. Kept
 *  literal rather than imported: the point is to pin the WIRE the web app
 *  sends, so a change to that constant has to be made deliberately here too. */
const HOUSE_CHAT_CREATE = { bootstrap: 'agent', backend: 'claude', mode: 'chat' } as const;
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('web "New chat" ends up with a live agent session', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let db: Database.Database;
  let ptyd: SpawnedPtyd;
  let wsServer: ReturnType<typeof attachWsServer>;
  let wsId: string;
  let prevPort: string | undefined;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-newchat-'));
    db = openDb(':memory:');
    const events = new EventBus();
    const agentBridge = createAgentBridge();
    ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const app = createApp({ db, ptyd: ptyd.client, cache, dataDir: tmp, events, agentBridge });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
    prevPort = process.env.MUXPAD_PORT;
    process.env.MUXPAD_PORT = String(port);
    wsServer = attachWsServer({
      http: server as unknown as Server,
      db,
      ptyd: ptyd.client,
      cache,
      events,
      agentBridge,
    });
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  afterAll(async () => {
    if (prevPort === undefined) delete process.env.MUXPAD_PORT;
    else process.env.MUXPAD_PORT = prevPort;
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

  /** Tap "New chat": the one request the web app makes. */
  async function newChat() {
    const res = await fetch(`${base()}/api/tabs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: wsId, ...HOUSE_CHAT_CREATE }),
    });
    expect(res.status).toBe(201);
    const tab = (await res.json()) as Tab;
    const detail = (await (await fetch(`${base()}/api/tabs/${tab.id}`)).json()) as Tab & {
      panes: Array<{ id: string; face: string; startup_cmd: string | null }>;
    };
    return { tab, pane: detail.panes[0]! };
  }

  it('bootstraps a chat-face pane and EAGERLY spawns its pty', async () => {
    const { pane } = await newChat();
    expect(pane.face).toBe('chat');
    expect(pane.startup_cmd).toBe('muxpad agent --mode chat');
    // The step whose failure is swallowed. Nothing else would start this pane:
    // a chat-face pane's client never attaches to the pty, so there is no
    // lazy-spawn fallback behind this.
    expect(await ptyd.client.hasPane(pane.id)).toBe(true);
  });

  it('pushes the session to a chat client that connected BEFORE the runner', async () => {
    const { pane } = await newChat();

    // The web client opens its socket immediately — well before a real runner
    // could have booted.
    const chat = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${pane.id}`);
    openSockets.push(chat);
    const frames: Array<Record<string, unknown>> = [];
    chat.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      chat.once('open', () => res());
      chat.once('error', rej);
    });

    // The hello says what is true right now: no session. This is the state the
    // UI renders as "Starting…".
    await settle(300);
    const hello = frames.find((f) => f.t === 'session');
    expect(hello).toBeDefined();
    expect(hello?.session ?? null).toBeNull();

    // Now the runner finishes booting and hellos, exactly as `muxpad agent` does.
    const runner = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
    openSockets.push(runner);
    await new Promise<void>((res, rej) => {
      runner.once('open', () => res());
      runner.once('error', rej);
    });
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: tmp, pid: 1, turnActive: false }));

    // The already-open chat socket must be TOLD. Without this the web app sits
    // on its one-shot hello and shows an empty chat forever.
    const deadline = Date.now() + 5_000;
    let live: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      live = frames.find(
        (f) => f.t === 'session' && (f.session as { current_sid?: string } | null)?.current_sid,
      );
      if (live) break;
      await settle(50);
    }
    expect(live, 'no session frame reached the chat client after the runner hello').toBeDefined();
    expect((live?.session as { current_sid: string }).current_sid).toBe(SID);

    // …and the HTTP view agrees, which is what a reloading client reads.
    const byPane = (await (
      await fetch(`${base()}/api/agent-sessions/by-pane/${pane.id}`)
    ).json()) as { current_sid: string };
    expect(byPane.current_sid).toBe(SID);
  }, 20_000);
});
