import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type PtydHandle, type PtydOptions, startPtyd } from '../ptyd/index.js';
import { PtydClient } from './PtydClient.js';

// Per-test bookkeeping. Each test that boots ptyd appends to `handles`
// and (usually) sets `dir`; clients go in `clients`. The afterEach hook
// tears them down in reverse order: clients first (so reconnect timers
// stop before we yank the socket), then handles, then the tmpdir.
let handles: PtydHandle[] = [];
let clients: PtydClient[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const c of clients) {
    try {
      await c.close();
    } catch {
      // best-effort cleanup
    }
  }
  clients = [];
  for (const h of handles) {
    try {
      await h.stop();
    } catch {
      // ptyd may already be stopped (reconnect tests do this explicitly)
    }
  }
  handles = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function spawnPtyd(opts?: Partial<PtydOptions>): Promise<{
  dir: string;
  socketPath: string;
  handle: PtydHandle;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'ptyd-client-'));
  dirs.push(dir);
  const socketPath = join(dir, 'ptyd.sock');
  const handle = await startPtyd({ socketPath, ...opts });
  handles.push(handle);
  return { dir, socketPath, handle };
}

function newClient(socketPath: string, opts?: { initialBackoffMs?: number }): PtydClient {
  const c = new PtydClient({ socketPath, ...(opts ?? {}) });
  clients.push(c);
  return c;
}

function waitForEvent(c: PtydClient, name: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.off(name, onEvent);
      reject(new Error(`timed out waiting for '${name}' after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    };
    c.once(name, onEvent);
  });
}

describe('PtydClient — basic RPC', () => {
  it('hasPane returns false for an unknown id', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    expect(await client.hasPane('nope')).toBe(false);
  });

  it('ensurePane → hasPane → killPane round-trip', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await client.ensurePane({
      id: 'p1',
      shell: '/bin/sh',
      startup_cmd: 'sleep 5',
      cwd: '/tmp',
    });
    expect(await client.hasPane('p1')).toBe(true);
    await client.killPane('p1');
    expect(await client.hasPane('p1')).toBe(false);
  });

  it('getCurrentCwd / getForegroundCommand return null for unknown ids', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    expect(await client.getCurrentCwd('nope')).toBeNull();
    expect(await client.getForegroundCommand('nope')).toBeNull();
  });

  it('markSeen and closePtyClients are idempotent for unknown ids', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await expect(client.markSeen('nope')).resolves.toBeUndefined();
    await expect(client.closePtyClients('nope')).resolves.toBeUndefined();
  });

  it('flushCwds returns an empty array on a fresh daemon', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    expect(await client.flushCwds()).toEqual([]);
  });

  it('concurrent calls resolve correctly (id correlation)', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    // Three independent calls in flight at once; ensure each gets its own
    // response. hasPane is the cheapest RPC, perfect for stress.
    const [a, b, c] = await Promise.all([
      client.hasPane('a'),
      client.hasPane('b'),
      client.hasPane('c'),
    ]);
    expect([a, b, c]).toEqual([false, false, false]);
  });

  it('calls before connect reject fast with "ptyd disconnected"', async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    // Don't wait for 'connected' — call immediately. The socket hasn't
    // hit OPEN yet, so we expect a synchronous-ish rejection.
    await expect(client.hasPane('whatever')).rejects.toThrow('ptyd disconnected');
  });
});

describe('PtydClient — event re-emit', () => {
  it("re-emits 'paneExit' when ptyd kills a pane", async () => {
    const { socketPath } = await spawnPtyd();
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    await client.ensurePane({
      id: 'ex1',
      shell: '/bin/sh',
      startup_cmd: 'sleep 30',
      cwd: '/tmp',
    });
    const exitPromise = waitForEvent(client, 'paneExit');
    await client.killPane('ex1');
    const payload = (await exitPromise) as { id: string; code: number; cause: string };
    expect(payload.id).toBe('ex1');
    expect(payload.cause).toBe('killed');
    expect(typeof payload.code).toBe('number');
  });

  it("re-emits 'paneCwd' when ptyd's polling tick fires", async () => {
    // Short cwd-poll so the event fires inside the test window. The
    // default is 30s, which would never tick in a unit test.
    const { socketPath } = await spawnPtyd({ cwdPollInterval: 50 });
    const client = newClient(socketPath);
    await waitForEvent(client, 'connected');
    const cwdPromise = waitForEvent(client, 'paneCwd');
    await client.ensurePane({
      id: 'cwd1',
      shell: '/bin/sh',
      startup_cmd: 'sleep 5',
      cwd: '/tmp',
    });
    const payload = (await cwdPromise) as { id: string; cwd: string };
    expect(payload.id).toBe('cwd1');
    expect(typeof payload.cwd).toBe('string');
    expect(payload.cwd.length).toBeGreaterThan(0);
    await client.killPane('cwd1');
  });
});

describe('PtydClient — reconnect on disconnect', () => {
  it('pending RPCs reject with "ptyd disconnected" when the socket closes mid-flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptyd-client-'));
    dirs.push(dir);
    const socketPath = join(dir, 'ptyd.sock');
    const handle = await startPtyd({ socketPath });
    handles.push(handle);
    const client = newClient(socketPath, { initialBackoffMs: 50 });
    await waitForEvent(client, 'connected');
    // Issue an RPC, then immediately yank the WS out from under it. We
    // can't easily make ptyd hang on a real call (responses are fast),
    // so we directly terminate the client's WS — this is the same code
    // path as a network-level drop, which is what we want to verify.
    const pending = client.hasPane('p1');
    // Reach into the client to terminate its WS. The handler should
    // observe 'close', fail every pending RPC, and emit 'disconnected'.
    const ws = (client as unknown as { ws: { terminate(): void } }).ws;
    ws.terminate();
    await expect(pending).rejects.toThrow('ptyd disconnected');
  });

  it('reconnects after ptyd is stopped and restarted on the same socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptyd-client-'));
    dirs.push(dir);
    const socketPath = join(dir, 'ptyd.sock');
    let handle = await startPtyd({ socketPath });
    // Tight backoff so the reconnect happens inside our test budget.
    const client = newClient(socketPath, { initialBackoffMs: 50 });
    await waitForEvent(client, 'connected');
    expect(client.connected).toBe(true);

    // Stop ptyd; the client should observe a 'disconnected' event.
    const disconnected = waitForEvent(client, 'disconnected');
    await handle.stop();
    await disconnected;
    expect(client.connected).toBe(false);

    // Restart ptyd on the same socket path. The reconnect loop is already
    // running on a 50ms backoff, so within a few hundred ms we should be
    // back online.
    handle = await startPtyd({ socketPath });
    handles.push(handle); // afterEach will tear this one down
    await waitForEvent(client, 'connected', 5000);

    // And RPCs should work again.
    expect(await client.hasPane('nope')).toBe(false);
  });

  it('reconnects once ptyd starts at a previously-missing socket path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptyd-client-'));
    dirs.push(dir);
    const socketPath = join(dir, 'ptyd.sock');
    // Construct client BEFORE ptyd exists. The first connect attempt
    // will fail; the client should retry on backoff.
    const client = newClient(socketPath, { initialBackoffMs: 50 });
    // We expect a 'disconnected' event from the initial failed attempt,
    // and the payload should carry the underlying WS error (so operators
    // can tell "wrong socket path" from "ptyd crashed mid-session"). We
    // assert truthiness rather than `.code === 'ENOENT'` to stay portable.
    const err = await waitForEvent(client, 'disconnected');
    expect(err).toBeInstanceOf(Error);
    expect(client.connected).toBe(false);

    // Now start ptyd; client should connect on the next backoff tick.
    const handle = await startPtyd({ socketPath });
    handles.push(handle);
    await waitForEvent(client, 'connected', 5000);
    expect(client.connected).toBe(true);
    expect(await client.hasPane('nope')).toBe(false);
  });

  it('close() is idempotent and stops reconnection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptyd-client-'));
    dirs.push(dir);
    const socketPath = join(dir, 'ptyd.sock');
    // Never start ptyd — exercise close() while the client is in its
    // initial reconnect loop.
    const client = new PtydClient({ socketPath, initialBackoffMs: 50 });
    await new Promise<void>((resolve) => client.once('disconnected', () => resolve()));
    await client.close();
    // Second close: should resolve without throwing.
    await client.close();
    expect(client.connected).toBe(false);
  });
});
