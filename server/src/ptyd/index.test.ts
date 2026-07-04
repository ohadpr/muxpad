import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeServerMessage, encodeInput } from '@muxpad/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type PtydHandle, type PtydOptions, startPtyd } from './index.js';
import { type CtrlEvent, type CtrlResponse, decodeMessage, encodeRequest } from './protocol.js';

let handle: PtydHandle | null = null;
let dir = '';
let ws: WebSocket | null = null;

afterEach(async () => {
  if (ws && ws.readyState === ws.OPEN) ws.close();
  ws = null;
  if (handle) await handle.stop();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/**
 * Boot a ptyd in a tmpdir, open a control WS, and return:
 *   - `call(method, params)` — request→response round-trip over the wire.
 *   - `waitForEvent(name)` — resolves when ptyd pushes a matching control
 *     event (e.g. `paneCwd`, `paneExit`). The returned promise rejects on
 *     timeout, so tests don't hang on a missing event.
 *
 * Internally the helper installs ONE persistent `message` listener on the
 * socket and dispatches frames either to pending response promises (by id)
 * or to event subscribers (by event name). This avoids the per-call listener
 * leak the previous shape had whenever an event frame arrived mid-call.
 *
 * Cleanup is handled by the module-level `afterEach`.
 */
async function setupPtyd(opts?: Partial<PtydOptions>): Promise<{
  socketPath: string;
  call: (method: string, params: unknown) => Promise<CtrlResponse>;
  waitForEvent: (name: string, timeoutMs?: number) => Promise<CtrlEvent>;
}> {
  dir = mkdtempSync(join(tmpdir(), 'ptyd-'));
  const socketPath = join(dir, 'ptyd.sock');
  handle = await startPtyd({ socketPath, ...opts });
  const sock = new WebSocket(`ws+unix://${socketPath}:/control`);
  ws = sock;
  await new Promise<void>((resolve, reject) => {
    sock.once('open', resolve);
    sock.once('error', reject);
  });

  // Pending request → resolver, keyed by request id.
  const pending = new Map<number, (r: CtrlResponse) => void>();
  // Event-name → list of one-shot resolvers waiting for the next push.
  const waiters = new Map<string, Array<(e: CtrlEvent) => void>>();

  sock.on('message', (b: Buffer) => {
    let msg;
    try {
      msg = decodeMessage(b.toString());
    } catch {
      return;
    }
    if (msg.kind === 'response') {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
      return;
    }
    if (msg.kind === 'event') {
      const list = waiters.get(msg.event);
      if (list && list.length) {
        // FIFO: oldest waiter wins. Don't fan out to all waiters — that
        // would tie unrelated callers together; we want one event = one
        // resolver, like a single-shot queue.
        const next = list.shift()!;
        next(msg);
      }
    }
  });

  let nextId = 1;
  async function call(method: string, params: unknown): Promise<CtrlResponse> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      sock.send(encodeRequest({ id, method, params }));
    });
  }

  function waitForEvent(name: string, timeoutMs = 3000): Promise<CtrlEvent> {
    return new Promise((resolve, reject) => {
      const list = waiters.get(name) ?? [];
      let settled = false;
      const onEvent = (e: CtrlEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(e);
      };
      list.push(onEvent);
      waiters.set(name, list);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove our pending entry so it doesn't leak past the timeout.
        const cur = waiters.get(name);
        if (cur) {
          const i = cur.indexOf(onEvent);
          if (i >= 0) cur.splice(i, 1);
        }
        reject(new Error(`timed out waiting for event '${name}' after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  return { socketPath, call, waitForEvent };
}

describe('ptyd boot', () => {
  it('listens on the configured unix socket and accepts a control connection', async () => {
    const { call } = await setupPtyd();
    const reply = await call('hasPane', { id: 'nope' });
    expect(reply).toEqual({ kind: 'response', id: 1, ok: true, result: { has: false } });
  });
});

describe('ptyd control RPCs', () => {
  it('ensurePane spawns a runtime that hasPane can see', async () => {
    const { call } = await setupPtyd();
    const ensure = await call('ensurePane', {
      spec: { id: 'p1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    expect(ensure.ok).toBe(true);
    if (ensure.ok) expect(ensure.result).toEqual({ ok: true });
    const has = await call('hasPane', { id: 'p1' });
    expect(has.ok).toBe(true);
    if (has.ok) expect(has.result).toEqual({ has: true });
  });

  it('killPane removes a previously-ensured pane', async () => {
    const { call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'k1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    const kill = await call('killPane', { id: 'k1' });
    expect(kill.ok).toBe(true);
    if (kill.ok) expect(kill.result).toEqual({ ok: true });
    const has = await call('hasPane', { id: 'k1' });
    expect(has.ok).toBe(true);
    if (has.ok) expect(has.result).toEqual({ has: false });
  });

  it('getCurrentCwd returns the runtime cwd (or null) for an existing pane', async () => {
    const { call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'c1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    // Brief wait so the spawned PTY exists for lsof to read its cwd.
    await new Promise((r) => setTimeout(r, 100));
    const cwd = await call('getCurrentCwd', { id: 'c1' });
    expect(cwd.ok).toBe(true);
    if (cwd.ok) {
      const { cwd: value } = cwd.result as { cwd: string | null };
      // Platform variance: macOS resolves /tmp → /private/tmp; linux keeps
      // /tmp. We only assert the shape here (non-empty string or null) —
      // PaneRuntime.test.ts has the more specific path checks.
      expect(value === null || (typeof value === 'string' && value.length > 0)).toBe(true);
    }
    await call('killPane', { id: 'c1' });
  });

  it('getCurrentCwd returns null for an unknown pane id', async () => {
    const { call } = await setupPtyd();
    const cwd = await call('getCurrentCwd', { id: 'nope' });
    expect(cwd.ok).toBe(true);
    if (cwd.ok) expect(cwd.result).toEqual({ cwd: null });
  });

  it('getForegroundCommand returns the cached fg cmd (or null)', async () => {
    const { call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'f1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    const fg = await call('getForegroundCommand', { id: 'f1' });
    expect(fg.ok).toBe(true);
    if (fg.ok) {
      // PaneManager's cmd-poll runs on a 10s interval by default; on a
      // fresh pane the cached value is almost certainly null. We assert
      // only the response shape — the polling itself is exercised in
      // PaneManager tests.
      const { cmd } = fg.result as { cmd: string | null };
      expect(cmd === null || typeof cmd === 'string').toBe(true);
    }
    await call('killPane', { id: 'f1' });
  });

  it('markSeen returns ok and is idempotent (including for unknown ids)', async () => {
    const { call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'm1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    const first = await call('markSeen', { id: 'm1' });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.result).toEqual({ ok: true });
    // Second call: still ok (idempotent — attention is already false).
    const second = await call('markSeen', { id: 'm1' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result).toEqual({ ok: true });
    // Unknown id: still ok — markSeen is a no-op when there's no runtime.
    const ghost = await call('markSeen', { id: 'does-not-exist' });
    expect(ghost.ok).toBe(true);
    if (ghost.ok) expect(ghost.result).toEqual({ ok: true });
    await call('killPane', { id: 'm1' });
  });

  it('flushCwds returns a snapshot of all live cwds', async () => {
    const { call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'fl1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    // Brief wait so lsof can resolve the spawned PTY's cwd.
    await new Promise((r) => setTimeout(r, 100));
    const flush = await call('flushCwds', {});
    expect(flush.ok).toBe(true);
    if (flush.ok) {
      const { entries } = flush.result as {
        entries: Array<{ id: string; cwd: string }>;
      };
      const entry = entries.find((e) => e.id === 'fl1');
      expect(entry).toBeDefined();
      expect(typeof entry?.cwd).toBe('string');
      expect((entry?.cwd ?? '').length).toBeGreaterThan(0);
    }
    await call('killPane', { id: 'fl1' });
  });

  it('flushCwds returns an empty entries array when no panes exist', async () => {
    const { call } = await setupPtyd();
    const flush = await call('flushCwds', {});
    expect(flush.ok).toBe(true);
    if (flush.ok) expect(flush.result).toEqual({ entries: [] });
  });
});

describe('ptyd /pty/:id per-attach WS endpoint', () => {
  // Open a binary WS to /pty/<id> over the same unix socket as control.
  // Returns the socket and a `nextOutput()` helper that resolves with the
  // decoded string body of the next output frame (or rejects on timeout).
  async function openPty(
    socketPath: string,
    id: string,
  ): Promise<{
    sock: WebSocket;
    nextOutput: (timeoutMs?: number) => Promise<string>;
    nextClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  }> {
    const sock = new WebSocket(`ws+unix://${socketPath}:/pty/${id}`);
    await new Promise<void>((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
      sock.once('close', (code, reason) => {
        // Resolve so callers using `nextClose` can observe the close even
        // when 'open' never fires (4404 case rejects above with no listener
        // attached yet; this branch is just a safety net).
        reject(new Error(`closed before open: ${code} ${reason.toString()}`));
      });
    });
    return {
      sock,
      nextOutput(timeoutMs = 2000): Promise<string> {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            sock.off('message', onMsg);
            reject(new Error(`timed out waiting for output after ${timeoutMs}ms`));
          }, timeoutMs);
          const onMsg = (b: Buffer) => {
            try {
              const msg = decodeServerMessage(new Uint8Array(b));
              if (msg.kind === 'output') {
                clearTimeout(timer);
                sock.off('message', onMsg);
                resolve(msg.data);
              }
            } catch {
              // ignore decode errors — keep waiting
            }
          };
          sock.on('message', onMsg);
        });
      },
      nextClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`timed out waiting for close after ${timeoutMs}ms`));
          }, timeoutMs);
          sock.once('close', (code, reason) => {
            clearTimeout(timer);
            resolve({ code, reason: reason.toString() });
          });
        });
      },
    };
  }

  it('attaches to a pane and echoes input', async () => {
    const { socketPath, call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'echo1', shell: '/bin/cat', cwd: '/tmp' },
    });
    const { sock, nextOutput } = await openPty(socketPath, 'echo1');
    sock.send(encodeInput('hi\n'));
    // /bin/cat with a PTY echoes locally and then writes the line on EOL,
    // so we may get a single combined output frame ("hi\r\nhi\r\n") or two
    // frames. Either way, accumulate until we see 'hi'.
    let acc = '';
    for (let i = 0; i < 5 && !acc.includes('hi'); i++) {
      acc += await nextOutput();
    }
    expect(acc).toContain('hi');
    sock.close();
    await call('killPane', { id: 'echo1' });
  });

  it('closes with code 4404 when the pane does not exist', async () => {
    const { socketPath } = await setupPtyd();
    const sock = new WebSocket(`ws+unix://${socketPath}:/pty/nope`);
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 2000);
      sock.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      sock.once('error', () => {
        // ws emits 'error' alongside 'close' on abnormal closures; we still
        // expect 'close' to fire with our 4404 code, so don't reject here.
      });
    });
    expect(closed.code).toBe(4404);
  });

  it('closePtyClients force-closes attached clients with code 4001', async () => {
    const { socketPath, call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'close1', shell: '/bin/cat', cwd: '/tmp' },
    });
    const { sock, nextClose } = await openPty(socketPath, 'close1');
    const closedPromise = nextClose();
    const reply = await call('closePtyClients', { id: 'close1' });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ ok: true });
    const closed = await closedPromise;
    expect(closed.code).toBe(4001);
    // Bucket should now be empty; second call is a no-op.
    const second = await call('closePtyClients', { id: 'close1' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result).toEqual({ ok: true });
    // Avoid double-close warnings in teardown.
    if (sock.readyState === sock.OPEN) sock.close();
    await call('killPane', { id: 'close1' });
  });

  it('closePtyClients is a no-op for unknown pane ids', async () => {
    const { call } = await setupPtyd();
    const reply = await call('closePtyClients', { id: 'does-not-exist' });
    expect(reply).toEqual({ kind: 'response', id: 1, ok: true, result: { ok: true } });
  });

  it('replays prior output to a second attach', async () => {
    const { socketPath, call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'snap1', shell: '/bin/cat', cwd: '/tmp' },
    });
    const a = await openPty(socketPath, 'snap1');
    a.sock.send(encodeInput('snap-marker\n'));
    let accA = '';
    for (let i = 0; i < 5 && !accA.includes('snap-marker'); i++) {
      accA += await a.nextOutput();
    }
    expect(accA).toContain('snap-marker');
    // Second attach: should receive a snapshot frame containing the prior
    // output immediately (synchronously after the open completes).
    const b = await openPty(socketPath, 'snap1');
    const replay = await b.nextOutput();
    expect(replay).toContain('snap-marker');
    a.sock.close();
    b.sock.close();
    await call('killPane', { id: 'snap1' });
  });

  it('skips ring-buffer replay when ?replay=0', async () => {
    const { socketPath, call } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'norep1', shell: '/bin/cat', cwd: '/tmp' },
    });
    const a = await openPty(socketPath, 'norep1');
    a.sock.send(encodeInput('marker-only-once\n'));
    let accA = '';
    for (let i = 0; i < 5 && !accA.includes('marker-only-once'); i++) {
      accA += await a.nextOutput();
    }
    expect(accA).toContain('marker-only-once');
    a.sock.close();
    await new Promise((r) => setTimeout(r, 50));

    const sock = new WebSocket(`ws+unix://${socketPath}:/pty/norep1?replay=0`);
    await new Promise<void>((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });
    let gotOutput = false;
    const onMsg = (b: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(b));
      if (msg.kind === 'output') gotOutput = true;
    };
    sock.on('message', onMsg);
    await new Promise((r) => setTimeout(r, 200));
    sock.off('message', onMsg);
    expect(gotOutput).toBe(false);
    sock.close();
    await call('killPane', { id: 'norep1' });
  });
});

describe('ptyd control push events', () => {
  // Integration coverage focuses on `paneCwd` and `paneExit` — both
  // observable without a way to write into the PTY from the control
  // channel. The other event kinds (paneTitle, paneFg, paneAttention)
  // are exercised by PaneManager unit tests; their wiring through ptyd
  // is identical (same broadcastEvent path), so we don't need separate
  // integration tests for them.

  it('pushes paneCwd after a pane is ensured', async () => {
    // Use a short cwd-poll interval so the event fires within the test
    // window — the default 30s would never tick.
    const { call, waitForEvent } = await setupPtyd({ cwdPollInterval: 50 });
    const evtPromise = waitForEvent('paneCwd');
    await call('ensurePane', {
      spec: { id: 'cwd1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    const evt = await evtPromise;
    expect(evt.event).toBe('paneCwd');
    expect(evt.id).toBe('cwd1');
    const cwd = evt.cwd;
    expect(typeof cwd).toBe('string');
    expect((cwd as string).length).toBeGreaterThan(0);
    await call('killPane', { id: 'cwd1' });
  });

  it('does not push control events to /pty/:id clients (regression for 684ec07)', async () => {
    // The bug being guarded: a previous version of broadcastEvent iterated
    // every wss.client, which included /pty/:id binary sockets. A JSON
    // control frame on a binary socket corrupts the browser's protocol
    // decode (first byte 0x7B = '{' is not a valid server-opcode).
    // Structural fix in 684ec07: broadcastEvent only iterates controlSockets.
    const { socketPath, call, waitForEvent } = await setupPtyd({ cwdPollInterval: 50 });
    await call('ensurePane', {
      spec: { id: 'iso1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' },
    });
    // Open a /pty/:id WS — this is the kind of socket that must NEVER
    // receive a JSON-shaped frame.
    const ptyWs = new WebSocket(`ws+unix://${socketPath}:/pty/iso1`);
    await new Promise<void>((resolve, reject) => {
      ptyWs.once('open', () => resolve());
      ptyWs.once('error', reject);
    });
    const ptyFrames: Buffer[] = [];
    ptyWs.on('message', (b: Buffer | ArrayBuffer) => {
      ptyFrames.push(Buffer.isBuffer(b) ? b : Buffer.from(b as ArrayBuffer));
    });

    // Wait for at least one paneCwd event to fire on /control — proves
    // broadcastEvent ran during the window the /pty/:id socket was open.
    const evt = await waitForEvent('paneCwd');
    expect(evt.id).toBe('iso1');

    // Give one more poll cycle a chance to fire so any errant broadcast
    // would have reached the /pty/:id socket by now.
    await new Promise((r) => setTimeout(r, 100));

    // Each /pty/:id frame must be a binary protocol frame whose first byte
    // is a valid server opcode (0x01 OUTPUT / 0x03 EXIT / 0x04 ERROR /
    // 0x05 PONG). It must NOT start with 0x7B ('{'), which is the leading
    // byte of every JSON control event we send.
    for (const frame of ptyFrames) {
      if (frame.length === 0) continue;
      expect(frame[0]).not.toBe(0x7b);
    }

    ptyWs.close();
    await call('killPane', { id: 'iso1' });
  });

  it('pushes paneExit with cause:killed when killPane is invoked', async () => {
    const { call, waitForEvent } = await setupPtyd();
    await call('ensurePane', {
      spec: { id: 'ex1', shell: '/bin/sh', startup_cmd: 'sleep 30', cwd: '/tmp' },
    });
    const evtPromise = waitForEvent('paneExit');
    await call('killPane', { id: 'ex1' });
    const evt = await evtPromise;
    expect(evt.event).toBe('paneExit');
    expect(evt.id).toBe('ex1');
    expect(evt.cause).toBe('killed');
    expect(typeof evt.code).toBe('number');
  });
});

describe('ptyd — raw url sightings (end-to-end)', () => {
  it('emits paneUrlsSeen with the raw URL a pane prints', async () => {
    const { call, waitForEvent } = await setupPtyd();
    await call('ensurePane', {
      spec: {
        id: 'srv1',
        shell: '/bin/sh',
        startup_cmd: "echo 'ready http://localhost:5173/'",
        cwd: '/tmp',
      },
    });
    const evt = await waitForEvent('paneUrlsSeen', 8000);
    const { urls, markers } = evt as unknown as { urls: string[]; markers: unknown[] };
    expect(Array.isArray(urls)).toBe(true);
    expect(urls).toContain('http://localhost:5173/');
    expect(Array.isArray(markers)).toBe(true);
  });

  it('emits raw sightings even when nothing is listening (ptyd does not probe)', async () => {
    const { call, waitForEvent } = await setupPtyd();
    // Post-split, ptyd is a dumb extractor: it forwards every printed URL.
    // Whether the port is actually listening is decided on the main server
    // (AppUrlDetector / AppUrlTracker), not here — so the sighting DOES arrive.
    await call('ensurePane', {
      spec: {
        id: 'noserve1',
        shell: '/bin/sh',
        startup_cmd: "echo 'see http://localhost:59999/ for docs'",
        cwd: '/tmp',
      },
    });
    const evt = await waitForEvent('paneUrlsSeen', 8000);
    const { urls } = evt as unknown as { urls: string[] };
    expect(urls).toContain('http://localhost:59999/');
  });
});
