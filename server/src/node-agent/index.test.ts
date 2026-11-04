import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_NODE_PORT,
  describeSelf,
  isForwardablePath,
  readNodeToken,
  startNodeAgent,
  tokenMatches,
} from './index.js';

const TOKEN = 'a'.repeat(64);
let stop: (() => void) | null = null;
let dir: string | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A free-ish high port per test, so a leaked listener cannot wedge the suite. */
let nextPort = 7850;
const port = () => nextPort++;

describe('the token', () => {
  it('matches only itself, in constant time, without throwing', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches('short', TOKEN)).toBe(false); // length mismatch must not throw
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, '')).toBe(false);
  });

  it('is read per call from disk, and a stub file is not a credential', () => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-node-'));
    expect(readNodeToken(dir)).toBe(null); // absent
    writeFileSync(join(dir, 'node-token'), 'tooshort\n');
    expect(readNodeToken(dir)).toBe(null); // a failed earlier write
    writeFileSync(join(dir, 'node-token'), `${TOKEN}\n`);
    expect(readNodeToken(dir)).toBe(TOKEN); // and it tolerates the newline
  });
});

/**
 * ── AN ALLOW-LIST, NOT A PREFIX CHECK ────────────────────────────────────
 * The plan review said it plainly: "reject arbitrary URL forwarding". A proxy
 * that forwards whatever path it is handed will one day forward something
 * nobody audited.
 */
describe('what may be forwarded to ptyd', () => {
  it('allows exactly the two shapes ptyd has', () => {
    expect(isForwardablePath('/control')).toBe(true);
    expect(isForwardablePath('/pty/01M6G7BXP2Q20W3HPEX2TVW0FP')).toBe(true);
  });

  it('refuses everything else, including traversal and near-misses', () => {
    for (const p of [
      '/',
      '/health',
      '/control/',
      '/controlx',
      '/pty/',
      '/pty/../control',
      '/pty/a/b',
      '/ws/agent-runner/x',
      '/api/panes',
      '//control',
      '/PTY/x',
    ]) {
      expect(isForwardablePath(p), p).toBe(false);
    }
  });
});

describe('the front door', () => {
  const upgrade = (p: number, path: string, token?: string) =>
    new Promise<{ ok: boolean; code?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}${path}`, {
        ...(token ? { headers: { 'x-muxpad-node-token': token } } : {}),
      });
      const done = (r: { ok: boolean; code?: number }) => {
        try {
          ws.close();
        } catch {}
        resolve(r);
      };
      ws.on('open', () => done({ ok: true }));
      ws.on('unexpected-response', (_r, res) =>
        done(res.statusCode === undefined ? { ok: false } : { ok: false, code: res.statusCode }),
      );
      ws.on('error', () => done({ ok: false }));
      setTimeout(() => done({ ok: false, code: 0 }), 2500);
    });

  it('refuses an upgrade with NO token — the tailnet is not a password', async () => {
    // This runs on a company tailnet with other people's dev VMs on it.
    const p = port();
    const a = await startNodeAgent({ port: p, host: '127.0.0.1', token: TOKEN, log: () => {} });
    stop = a.close;
    expect((await upgrade(p, '/control')).ok).toBe(false);
  });

  it('refuses a WRONG token', async () => {
    const p = port();
    const a = await startNodeAgent({ port: p, host: '127.0.0.1', token: TOKEN, log: () => {} });
    stop = a.close;
    expect((await upgrade(p, '/control', 'b'.repeat(64))).ok).toBe(false);
  });

  it('refuses a non-forwardable path EVEN WITH a good token', async () => {
    // Authentication and authorization are different questions; holding the
    // node's token must not mean "proxy anything you like".
    const p = port();
    const a = await startNodeAgent({ port: p, host: '127.0.0.1', token: TOKEN, log: () => {} });
    stop = a.close;
    expect((await upgrade(p, '/api/panes', TOKEN)).ok).toBe(false);
    expect((await upgrade(p, '/ws/agent-runner/x', TOKEN)).ok).toBe(false);
    // NOT `/pty/../control` here: the ws client NORMALISES that to `/control`
    // before it leaves, so the agent legitimately allows what it receives and
    // the test would be asserting the client's behaviour. The traversal guard
    // is a property of `isForwardablePath`, asserted directly above, which is
    // what protects against a client that does NOT normalise.
  });

  it('answers /health WITHOUT a token, so a probe is not a credential test', async () => {
    // A liveness probe that needed the token would report a credential
    // problem as a dead machine, and the control plane could not tell those
    // apart.
    const p = port();
    const a = await startNodeAgent({ port: p, host: '127.0.0.1', token: TOKEN, log: () => {} });
    stop = a.close;
    const r = await fetch(`http://127.0.0.1:${p}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('gates /self behind the token', async () => {
    const p = port();
    const a = await startNodeAgent({ port: p, host: '127.0.0.1', token: TOKEN, log: () => {} });
    stop = a.close;
    expect((await fetch(`http://127.0.0.1:${p}/self`)).status).toBe(404);
    const ok = await fetch(`http://127.0.0.1:${p}/self`, {
      headers: { 'x-muxpad-node-token': TOKEN },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ platform: expect.any(String) });
  });

  it('never writes the presented token to the log', async () => {
    // A credential in a log file is a credential in a backup.
    const lines: string[] = [];
    const p = port();
    const a = await startNodeAgent({
      port: p,
      host: '127.0.0.1',
      token: TOKEN,
      log: (l) => lines.push(l),
    });
    stop = a.close;
    const guess = 'c'.repeat(64);
    await upgrade(p, '/control', guess);
    expect(lines.join('\n')).not.toContain(guess);
    expect(lines.join('\n')).toContain('refused');
  });
});

describe('what it reports about itself', () => {
  it('describes the machine, for the Machines row', () => {
    const d = describeSelf();
    expect(d).toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
      cpus: expect.any(Number),
      memoryGb: expect.any(Number),
    });
  });

  it('has a port that collides with neither muxpad nor a browser host', () => {
    expect(DEFAULT_NODE_PORT).toBe(7797);
    expect(DEFAULT_NODE_PORT).not.toBe(7777);
    expect(DEFAULT_NODE_PORT < 9400 || DEFAULT_NODE_PORT > 9600).toBe(true);
  });
});
