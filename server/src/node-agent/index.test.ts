import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_NODE_PORT,
  defaultShell,
  describeSelf,
  isApiFunnelPath,
  isForwardablePath,
  isLoopbackPeer,
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
    // NOT /ws/agent-runner any more: that is now a LINK route, where a runner
    // on this machine attaches so its frames can ride up to the server. It
    // still requires the node token — which is why the runner now presents one
    // when this machine has a node-token file.
    expect((await upgrade(p, '/ws/other', TOKEN)).ok).toBe(false);
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

describe('the shell it reports', () => {
  it('is absolute, so a pane created from it can actually start', () => {
    // The server's own default is `/bin/zsh` and there is no zsh here; a pane
    // created with it dies instantly, reported as nothing but "the pty exited
    // immediately after starting".
    expect(defaultShell().startsWith('/')).toBe(true);
  });

  it('rides along in describeSelf, which is how the server learns it', () => {
    expect(describeSelf().shell).toBe(defaultShell());
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

/**
 * ── THE IN-PANE CLI'S FUNNEL ─────────────────────────────────────────────
 *
 * A remote pane's `MUXPAD_API_URL` points here, and these calls carry NO
 * token — a pane cannot hold one, because its environment is readable by
 * anything running as the user. What protects them is that the funnel only
 * answers over loopback, and this agent binds 0.0.0.0 because the control
 * plane has to be able to dial it across the tailnet. That tailnet has other
 * people's dev VMs on it.
 */
describe('who may use the API funnel', () => {
  it('knows loopback, including the IPv4-mapped form Node reports', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    // A dual-stack listener reports this, and missing it would refuse every
    // pane on exactly the machines the funnel exists to serve.
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('127.0.0.53')).toBe(true);
    expect(isLoopbackPeer('100.64.0.7')).toBe(false); // a tailnet peer
    expect(isLoopbackPeer('10.0.0.5')).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  it('recognises the funnel path and nothing adjacent to it', () => {
    expect(isApiFunnelPath('/api/say/key')).toBe(true);
    expect(isApiFunnelPath('/api')).toBe(true);
    expect(isApiFunnelPath('/apix/say')).toBe(false);
    expect(isApiFunnelPath('/control')).toBe(false);
    expect(isApiFunnelPath('/health')).toBe(false);
  });

  it('answers 503 with no link, rather than hanging the pane', async () => {
    // A `muxpad card` that never returns reads to the user as the chat
    // freezing, so "no control plane" must be an ANSWER.
    const p = port();
    const a = await startNodeAgent({ port: p, host: '127.0.0.1', token: TOKEN, log: () => {} });
    stop = a.close;
    const res = await fetch(`http://127.0.0.1:${p}/api/say/key`);
    expect(res.status).toBe(503);
  });
});
