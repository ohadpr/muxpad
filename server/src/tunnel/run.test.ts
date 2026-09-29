import { describe, expect, it } from 'vitest';
import { TUNNEL_BACKOFF_MAX_MS, TUNNEL_BACKOFF_MIN_MS } from './cloudflared.js';
import { type TunnelChild, createTunnelRunner, verifyPublicTarget } from './run.js';

const API = 'http://127.0.0.1:7777';
const NAMES = [
  'https://franklin-discuss-powers-usgs.trycloudflare.com',
  'https://quiet-mango-parallel-tide.trycloudflare.com',
  'https://amber-ladder-vivid-basin.trycloudflare.com',
];

/** A cloudflared the test drives: emit output, then exit, on command. */
function fakeChild(): TunnelChild & {
  emit(chunk: string): void;
  exit(code: number | null): void;
} {
  const listeners: Array<(c: string) => void> = [];
  let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
    resolveExit = r;
  });
  return {
    onOutput: (cb) => listeners.push(cb),
    exited,
    kill: () => resolveExit({ code: null, signal: 'SIGTERM' }),
    emit: (chunk) => {
      for (const cb of listeners) cb(chunk);
    },
    exit: (code) => resolveExit({ code, signal: null }),
  };
}

interface Call {
  method: string;
  body: Record<string, unknown> | null;
}

/**
 * The world the runner talks to: a fake main server that records every
 * announce, plus a `/` that answers like the PUBLIC artifact server unless a
 * test says otherwise.
 */
type Target = { status: number; csp: string } | 'unreachable';

function harness(opts?: { target?: Target; reply?: Record<string, unknown> }) {
  const calls: Call[] = [];
  const state = { target: opts?.target ?? { status: 404, csp: 'sandbox allow-scripts' } };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/publish/tunnel')) {
      calls.push({
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true, ...(opts?.reply ?? {}) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (state.target === 'unreachable') throw new Error('connect ECONNREFUSED');
    return new Response('not found', {
      status: state.target.status,
      headers: { 'content-security-policy': state.target.csp },
    });
  }) as unknown as typeof fetch;
  /** Change what :7778 answers, mid-run. */
  const setTarget = (t: Target) => {
    state.target = t;
  };
  return { calls, fetchImpl, setTarget };
}

describe('verifyPublicTarget — decision 5, enforced not documented', () => {
  it('accepts the public artifact server: a 404 at / with a sandbox CSP', async () => {
    const { fetchImpl } = harness();
    expect(await verifyPublicTarget('http://127.0.0.1:7778', fetchImpl)).toEqual({ ok: true });
  });

  it('REFUSES the main muxpad server, which answers 200 with the SPA', async () => {
    // The main app has no authentication — its own source says reachability IS
    // authorization — and it serves a terminal. This is the check that makes a
    // mis-typed port a refusal instead of a catastrophe.
    const { fetchImpl } = harness({ target: { status: 200, csp: '' } });
    const res = await verifyPublicTarget('http://127.0.0.1:7777', fetchImpl);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('refusing to tunnel it');
  });

  it('refuses anything that 404s WITHOUT the sandbox header', async () => {
    // Some other server on some other port. A blocklist of known-bad ports
    // would have waved this through.
    const { fetchImpl } = harness({ target: { status: 404, csp: '' } });
    expect((await verifyPublicTarget('http://127.0.0.1:8080', fetchImpl)).ok).toBe(false);
  });

  it('refuses when nothing is listening', async () => {
    const { fetchImpl } = harness({ target: 'unreachable' });
    const res = await verifyPublicTarget('http://127.0.0.1:7778', fetchImpl);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('nothing is listening');
    // NOT LISTENING and ANSWERING WRONG are different failures and the runner
    // treats them differently: the first is muxpad being restarted, the second
    // is somebody else holding the port. See the heartbeat tests below.
    expect(res.ok === false && res.listening).toBe(false);
  });

  it('separates "answered wrong" from "nothing there"', async () => {
    const { fetchImpl } = harness({ target: { status: 200, csp: '' } });
    const res = await verifyPublicTarget('http://127.0.0.1:7778', fetchImpl);
    expect(res.ok === false && res.listening).toBe(true);
  });
});

describe('createTunnelRunner', () => {
  it('announces the hostname it parses, and retracts it the instant cloudflared exits', async () => {
    const { calls, fetchImpl } = harness();
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      paneId: 'pane-1',
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 1,
    });
    const done = runner.run();
    // Give the target check a tick, then feed it the real banner shape.
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`2026-09-19T21:48:32Z INF |  ${NAMES[0]}   |`);
    await new Promise((r) => setTimeout(r, 5));
    child.exit(1);
    expect(await done).toBe('max-runs');

    const up = calls.filter((c) => c.method === 'POST');
    expect(up).toHaveLength(1);
    expect(up[0]?.body).toEqual({ url: NAMES[0], pane_id: 'pane-1' });
    const down = calls.filter((c) => c.method === 'DELETE');
    expect(down).toHaveLength(1);
    expect(String(down[0]?.body?.error)).toContain('cloudflared exited');
    // And the retraction came AFTER the announce — the dead name is replaced,
    // never preserved.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('announces a DIFFERENT hostname on each restart — the whole feature', async () => {
    // A quick tunnel mints a new random name on every start. Supervision that
    // did not re-announce would keep a dead name pinned with perfect uptime.
    const { calls, fetchImpl } = harness();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let n = 0;
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      paneId: 'pane-1',
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => children[n++] as TunnelChild,
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 3,
    });
    const done = runner.run();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      (children[i] as ReturnType<typeof fakeChild>).emit(`INF |  ${NAMES[i]}  |`);
      await new Promise((r) => setTimeout(r, 5));
      (children[i] as ReturnType<typeof fakeChild>).exit(1);
    }
    await done;
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body?.url)).toEqual(NAMES);
    // Up, down, up, down, up, down — never two urls live at once.
    expect(calls.map((c) => c.method)).toEqual([
      'POST',
      'DELETE',
      'POST',
      'DELETE',
      'POST',
      'DELETE',
    ]);
  });

  it('backs off between restarts, and CAPS the wait', async () => {
    const { fetchImpl } = harness();
    const waits: number[] = [];
    const children = Array.from({ length: 12 }, () => fakeChild());
    let n = 0;
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => children[n++] as TunnelChild,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 12,
    });
    const done = runner.run();
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2));
      // Every start fails immediately, minting no hostname — the storm shape.
      (children[i] as ReturnType<typeof fakeChild>).exit(1);
    }
    await done;
    expect(waits[0]).toBe(TUNNEL_BACKOFF_MIN_MS);
    expect(waits[1]).toBe(TUNNEL_BACKOFF_MIN_MS * 2);
    expect(waits[2]).toBe(TUNNEL_BACKOFF_MIN_MS * 4);
    // …and it stops growing. No unbounded wait, and no spin.
    expect(Math.max(...waits)).toBe(TUNNEL_BACKOFF_MAX_MS);
    expect(waits.at(-1)).toBe(TUNNEL_BACKOFF_MAX_MS);
    // Every failure was reported, with a rising attempt count so the server
    // can tell one unlucky restart from a run of them.
    expect(waits.length).toBeGreaterThan(5);
  });

  it('a long healthy run forgives the past instead of inheriting its ceiling', async () => {
    const { calls, fetchImpl } = harness();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let n = 0;
    let clock = 0;
    const waits: number[] = [];
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => children[n++] as TunnelChild,
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => clock,
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 3,
    });
    const done = runner.run();
    // Two instant failures push the backoff up…
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 2));
      (children[i] as ReturnType<typeof fakeChild>).exit(1);
    }
    // …then a run that lived an hour.
    await new Promise((r) => setTimeout(r, 2));
    (children[2] as ReturnType<typeof fakeChild>).emit(`INF |  ${NAMES[0]}  |`);
    await new Promise((r) => setTimeout(r, 2));
    clock = 3_600_000;
    (children[2] as ReturnType<typeof fakeChild>).exit(0);
    await done;
    // The third run ends the test before its own wait; what proves forgiveness
    // is the attempt counter resetting to 1 after an hour of uptime.
    expect(waits).toEqual([TUNNEL_BACKOFF_MIN_MS, TUNNEL_BACKOFF_MIN_MS * 2]);
    expect(calls.filter((c) => c.method === 'DELETE').at(-1)?.body?.attempts).toBe(1);
  });

  it('degrades cleanly when cloudflared is not installed — no spawn, no crash loop', async () => {
    const { calls, fetchImpl } = harness();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: null,
      fetchImpl,
      spawnChild: () => {
        throw new Error('must not spawn');
      },
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
    });
    expect(await runner.run()).toBe('no-binary');
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.body?.error)).toContain('cloudflared is not installed');
  });

  it('refuses to start at all against a target that is not the public server', async () => {
    const { calls, fetchImpl } = harness({ target: { status: 200, csp: '' } });
    const runner = createTunnelRunner({
      publicPort: 7777,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => {
        throw new Error('must not spawn');
      },
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
    });
    expect(await runner.run()).toBe('refused');
    expect(String(calls[0]?.body?.error)).toContain('refusing to tunnel it');
  });

  it('retracts WITHOUT an error when it is stopped on purpose', async () => {
    const { calls, fetchImpl } = harness();
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`INF |  ${NAMES[0]}  |`);
    await new Promise((r) => setTimeout(r, 5));
    runner.stop();
    expect(await done).toBe('stopped');
    const down = calls.filter((c) => c.method === 'DELETE');
    // A deliberate stop is not a failure: no error, so nothing warns about it.
    expect(down.at(-1)?.body).toEqual({});
  });

  it('re-announces the live url on a heartbeat, so a restarted server relearns it', async () => {
    // The tunnel outlives the main server (ptyd owns it), so a main server
    // that was down when the hostname was minted would otherwise have a
    // perfectly healthy tunnel it knows nothing about, forever.
    const { calls, fetchImpl } = harness();
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      // Only the heartbeat sleeps here (nothing exits, so there is no backoff);
      // a short one turns 30 real seconds into a few milliseconds.
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      log: () => {},
      out: () => {},
      announceIntervalMs: 30_000,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`INF |  ${NAMES[0]}  |`);
    await new Promise((r) => setTimeout(r, 40));
    runner.stop();
    await done;
    const up = calls.filter((c) => c.method === 'POST');
    expect(up.length).toBeGreaterThan(1);
    // Always the SAME url — a heartbeat restates, it never invents.
    expect(new Set(up.map((c) => c.body?.url))).toEqual(new Set([NAMES[0]]));
  });

  it('CLAIMS the tunnel with its pid before it spawns anything', async () => {
    // The runner may be supervised by launchd rather than by a muxpad pane, in
    // which case its pid is the ownership token that replaces the pane id. The
    // claim goes out BEFORE cloudflared, because a publish landing in the four
    // seconds before a hostname exists would otherwise start a rival tunnel in
    // a pane.
    const { calls, fetchImpl } = harness();
    const child = fakeChild();
    let spawned = 0;
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      pid: 4242,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => {
        spawned += 1;
        return child;
      },
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 1,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls[0]).toEqual({ method: 'POST', body: { pid: 4242 } });
    expect(spawned).toBe(1);
    child.emit(`INF |  ${NAMES[0]}  |`);
    await new Promise((r) => setTimeout(r, 5));
    child.exit(1);
    await done;
    // Every announce and retraction carries the pid, so the server can tell a
    // live owner from a record nothing is behind.
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      url: NAMES[0],
      pane_id: null,
      pid: 4242,
    });
    expect(calls.filter((c) => c.method === 'DELETE').at(-1)?.body?.pid).toBe(4242);
  });

  it('WAITS for the public server instead of refusing when nothing is listening', async () => {
    // Under launchd the tunnel job and the main server start together, and the
    // tunnel usually wins the race. Exiting would work — launchd would retry —
    // but every exit is a fresh cloudflared and therefore a new hostname, which
    // is the bug.
    const { calls, fetchImpl, setTarget } = harness({ target: 'unreachable' });
    const child = fakeChild();
    let spawned = 0;
    const waits: number[] = [];
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => {
        spawned += 1;
        return child;
      },
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 3) setTarget({ status: 404, csp: 'sandbox allow-scripts' });
      },
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 1,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toBe(1); // it got there in the end
    expect(waits.length).toBeGreaterThanOrEqual(3); // …after waiting, not exiting
    child.exit(0);
    expect(await done).toBe('max-runs');
    // Nothing was ever tunnelled while the target was silent.
    expect(calls.filter((c) => c.method === 'POST' && c.body?.url)).toHaveLength(0);
  });

  it('still refuses OUTRIGHT when the port answers and is not the public server', async () => {
    // Waiting is only right for silence. Something that answers wrongly is
    // somebody else's server, and waiting for it to become muxpad is waiting
    // for a thing that will not happen.
    const { fetchImpl } = harness({ target: { status: 200, csp: '' } });
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => {
        throw new Error('must not spawn');
      },
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
    });
    expect(await runner.run()).toBe('refused');
  });

  it('keeps the tunnel UP while muxpad is down — that is the whole point', async () => {
    // The trade this feature makes: a tunnel that survives a muxpad restart is
    // a tunnel muxpad is not supervising. For the window where nothing is
    // listening on the public port, HOLDING the hostname is the goal — it is
    // what makes the name come back with muxpad instead of rotating.
    const { fetchImpl, setTarget } = harness();
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      pid: 4242,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      sleep: () => new Promise((r) => setTimeout(r, 2)),
      log: () => {},
      out: () => {},
      announceIntervalMs: 30_000,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`INF |  ${NAMES[0]}  |`);
    setTarget('unreachable'); // muxpad is being restarted
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();
    expect(await done).toBe('stopped'); // it never gave up on the hostname
  });

  it('CLOSES the door when something else takes the public port', async () => {
    // The new failure mode, and its answer. A launchd tunnel outlives muxpad,
    // so "nothing is listening on 7778" can become "something ELSE is listening
    // on 7778" with no muxpad around to notice. The fingerprint is therefore
    // re-checked on the heartbeat, not only at startup.
    const { calls, fetchImpl, setTarget } = harness();
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      pid: 4242,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      sleep: () => new Promise((r) => setTimeout(r, 2)),
      log: () => {},
      out: () => {},
      announceIntervalMs: 30_000,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`INF |  ${NAMES[0]}  |`);
    await new Promise((r) => setTimeout(r, 5));
    setTarget({ status: 200, csp: '' }); // somebody else's server, now public
    expect(await done).toBe('refused');
    // …and the url was retracted, so nothing publishes a link into it.
    expect(calls.filter((c) => c.method === 'DELETE')).not.toHaveLength(0);
  });

  it('shuts down when the server says the tunnel is not wanted', async () => {
    // MUXPAD_PUBLIC_BASE_URL still wins. muxpad cannot stop a launchd job, so
    // the answer to an announce is authoritative: a real domain means there is
    // nothing for a quick tunnel to do, and a clean exit is what keeps launchd
    // from bringing it back (KeepAlive: SuccessfulExit false).
    const { fetchImpl } = harness({ reply: { wanted: false } });
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      pid: 4242,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`INF |  ${NAMES[0]}  |`);
    expect(await done).toBe('not-wanted');
  });

  it('survives the main server being unreachable while it announces', async () => {
    // The tunnel outlives the main server by design (ptyd owns it), so a
    // failed announce is normal and must never be fatal.
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/publish/tunnel')) {
        calls.push({ method: init?.method ?? 'GET', body: null });
        throw new Error('ECONNREFUSED');
      }
      return new Response('not found', {
        status: 404,
        headers: { 'content-security-policy': 'sandbox allow-scripts' },
      });
    }) as unknown as typeof fetch;
    const child = fakeChild();
    const runner = createTunnelRunner({
      publicPort: 7778,
      apiUrl: API,
      bin: '/x/cloudflared',
      fetchImpl,
      spawnChild: () => child,
      sleep: async () => {},
      log: () => {},
      out: () => {},
      announceIntervalMs: 0,
      maxRuns: 1,
    });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    child.emit(`INF |  ${NAMES[0]}  |`);
    await new Promise((r) => setTimeout(r, 5));
    child.exit(1);
    expect(await done).toBe('max-runs');
    expect(calls.length).toBeGreaterThanOrEqual(2); // it tried, and carried on
  });
});
