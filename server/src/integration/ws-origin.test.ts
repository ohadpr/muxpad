import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

/**
 * The WebSocket half of the same-origin guard, over REAL sockets.
 *
 * same-origin.test.ts pins the decision; this pins the wiring — that every
 * upgrade arm actually consults it, that a refusal is a clean 403 rather than a
 * dropped connection, and above all that the clients muxpad depends on still
 * connect. The last part is the point: a mistake here does not leak anything,
 * it locks the user out of their own terminals, which is strictly worse than
 * the hole being closed.
 *
 * Isolated instance: own ephemeral port, own tmpdir as the data dir (SQLite
 * lives in it), own ptyd unix socket inside another tmpdir. Nothing here reads
 * or writes ~/.muxpad.
 */

let cleanupFns: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
  cleanupFns = [];
});

async function boot(opts: { allowedOrigins?: Set<string> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'muxpad-ws-origin-'));
  cleanupFns.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = openDb(join(dataDir, 'db.sqlite'));
  const ptyd = await spawnPtyd();
  cleanupFns.push(() => ptyd.cleanup());

  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const wsRow = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });

  const refusals: string[] = [];
  const http = createServer();
  const handle = attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache: new PtydCache(),
    events: new EventBus(),
    logRefusal: (line) => refusals.push(line),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  cleanupFns.push(async () => {
    await handle.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });

  /** Every upgrade arm ws.ts serves. If one is added, add it here. */
  const arms = {
    pane: `/ws/pane/${pane.id}`,
    chat: `/ws/chat/${pane.id}`,
    runner: `/ws/agent-runner/${pane.id}`,
    events: '/ws/events',
  };
  return { port, paneId: pane.id, arms, refusals };
}

/**
 * Attempt one handshake and report how it ended. A refusal must surface as an
 * HTTP status (`ws` reports a non-101 response as
 * "Unexpected server response: <code>"), NOT as a bare socket reset — that is
 * what makes a lockout diagnosable in devtools instead of mysterious.
 */
async function handshake(
  url: string,
  options?: { origin?: string; headers?: Record<string, string> },
): Promise<'open' | `status:${number}` | 'reset'> {
  const sock = new WebSocket(url, {
    ...(options?.origin !== undefined ? { origin: options.origin } : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
  });
  try {
    return await new Promise<'open' | `status:${number}` | 'reset'>((resolve) => {
      const done = setTimeout(() => resolve('reset'), 5000);
      const finish = (v: 'open' | `status:${number}` | 'reset') => {
        clearTimeout(done);
        resolve(v);
      };
      sock.once('open', () => finish('open'));
      sock.once('unexpected-response', (_req, res) => {
        res.resume();
        finish(`status:${res.statusCode ?? 0}`);
      });
      sock.once('error', () => finish('reset'));
      sock.once('close', () => finish('reset'));
    });
  } finally {
    sock.close();
    sock.terminate();
  }
}

const EVIL = 'https://evil.example.com';

describe('WebSocket upgrade origin guard', () => {
  it('ALLOWS a same-origin browser-style handshake on every arm', async () => {
    // What the real app sends: XtermPane, ChatPane/DocChat and events.ts all
    // build their URL from `location.host`, so Origin and Host agree.
    const { port, arms, refusals } = await boot();
    const origin = `http://127.0.0.1:${port}`;
    for (const [name, path] of Object.entries(arms)) {
      expect([name, await handshake(`ws://127.0.0.1:${port}${path}`, { origin })]).toEqual([
        name,
        'open',
      ]);
    }
    expect(refusals).toEqual([]);
  });

  it('REFUSES a foreign-Origin handshake on every arm, with a 403 and one log line', async () => {
    // The hole. Before the guard, this page owned a live shell: open
    // /ws/pane/<id> and send OP_INPUT. Browsers apply no CORS to WebSockets,
    // so nothing else was going to stop it.
    const { port, arms, refusals } = await boot();
    for (const [name, path] of Object.entries(arms)) {
      expect([name, await handshake(`ws://127.0.0.1:${port}${path}`, { origin: EVIL })]).toEqual([
        name,
        'status:403',
      ]);
    }
    // Refused four arms; the per-origin throttle collapses them into one line,
    // which still has to name the origin AND the escape hatch.
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(EVIL);
    expect(refusals[0]).toContain('MUXPAD_ALLOWED_ORIGINS');
  });

  it('REFUSES an opaque `null` Origin (a sandboxed published artifact)', async () => {
    // public-server.ts serves every published artifact from a sandboxed
    // iframe, i.e. agent-written HTML running as `Origin: null` on loopback.
    const { port, arms } = await boot();
    expect(await handshake(`ws://127.0.0.1:${port}${arms.pane}`, { origin: 'null' })).toBe(
      'status:403',
    );
  });

  it('ALLOWS a no-Origin handshake — the agent runner and the CLI case', async () => {
    // agent-runner/index.ts is `new WebSocket(url)` from the `ws` library with
    // no options: no Origin, and it reconnects forever after every
    // `muxpad restart`. Refusing it would not fail loudly, it would spin. No
    // browser lands here — Origin is mandatory for browser WS clients.
    const { port, arms, refusals } = await boot();
    for (const [name, path] of Object.entries(arms)) {
      expect([name, await handshake(`ws://127.0.0.1:${port}${path}`)]).toEqual([name, 'open']);
    }
    expect(refusals).toEqual([]);
  });

  it('ALLOWS a cross-hostname Origin named in MUXPAD_ALLOWED_ORIGINS', async () => {
    // The escape hatch for a reverse proxy that rewrites Host. Without it, the
    // 403 would name a variable that could not fix the lockout.
    const { port, arms } = await boot({ allowedOrigins: new Set(['muxpad.example.com']) });
    expect(
      await handshake(`ws://127.0.0.1:${port}${arms.pane}`, {
        origin: 'https://muxpad.example.com',
      }),
    ).toBe('open');
    expect(await handshake(`ws://127.0.0.1:${port}${arms.pane}`, { origin: EVIL })).toBe(
      'status:403',
    );
  });

  it('matches on HOSTNAME only, so a TLS terminator cannot lock the user out', async () => {
    // `tailscale serve` fronts plain http on :7777 with https on :443 and
    // forwards the original Host. Comparing scheme or port would refuse every
    // socket in the user's own app.
    const { port, arms } = await boot();
    const result = await handshake(`ws://127.0.0.1:${port}${arms.pane}`, {
      origin: 'https://muxpad-mini.tail1234.ts.net',
      headers: { Host: 'muxpad-mini.tail1234.ts.net' },
    });
    expect(result).toBe('open');
  });

  it('a refusal does not wedge the server — the next legitimate socket connects', async () => {
    // The refusal writes a raw 403 onto a socket `ws` has never touched. If
    // that threw (no 'error' listener on a raw upgrade socket is a
    // process-level throw) or left the listener in a bad state, the fix would
    // be a better denial of service than the bug.
    const { port, arms } = await boot();
    for (let i = 0; i < 5; i++) {
      expect(await handshake(`ws://127.0.0.1:${port}${arms.runner}`, { origin: EVIL })).toBe(
        'status:403',
      );
    }
    expect(await handshake(`ws://127.0.0.1:${port}${arms.runner}`)).toBe('open');
    expect(await handshake(`ws://127.0.0.1:${port}${arms.events}`)).toBe('open');
  });

  it('still 403s BEFORE the pane lookup, so it cannot be probed for pane ids', async () => {
    // Order matters: the guard runs above the path dispatch. A foreign page
    // must not be able to tell "no such pane" (socket reset) from "real pane"
    // (upgrade) and enumerate ids by timing the difference.
    const { port } = await boot();
    expect(await handshake(`ws://127.0.0.1:${port}/ws/pane/nope`, { origin: EVIL })).toBe(
      'status:403',
    );
    expect(await handshake(`ws://127.0.0.1:${port}/ws/agent-runner/nope`, { origin: EVIL })).toBe(
      'status:403',
    );
    // …and an unknown path is still just dropped, guard or no guard.
    expect(await handshake(`ws://127.0.0.1:${port}/ws/nonsense`)).toBe('reset');
  });
});
