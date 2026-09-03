// The web face's liveness decision. The bug this encodes: the page can only
// probe with `fetch(mode:'no-cors')`, and an opaque response carries no status
// — so `tailscale serve` answering 502 for a dead local backend was read as
// "alive" and the user got a silent blank iframe with no notice and no
// recovery. The server can read the status; these tests pin exactly how much
// authority each probe gets.
import type { UrlHealth } from '@muxpad/shared';
import { describe, expect, it, vi } from 'vitest';
import { probeUrlLive, serverVerdict } from './face-switch';

const health = (over: Partial<UrlHealth>): UrlHealth => ({
  alive: true,
  status: 200,
  reason: 'ok',
  elapsedMs: 5,
  ...over,
});

describe('serverVerdict', () => {
  it('treats a gateway status as authoritative death', () => {
    for (const status of [502, 503, 504]) {
      expect(serverVerdict(health({ alive: false, status, reason: 'gateway' }))).toBe('dead');
    }
  });

  it('treats anything the server actually reached as alive', () => {
    expect(serverVerdict(health({ status: 200, reason: 'ok' }))).toBe('alive');
    expect(serverVerdict(health({ status: 401, reason: 'client_error' }))).toBe('alive');
    expect(serverVerdict(health({ status: 500, reason: 'server_error' }))).toBe('alive');
  });

  it('defers to the browser when the SERVER could not reach it', () => {
    expect(serverVerdict(health({ alive: false, status: null, reason: 'unreachable' }))).toBe(
      'fallback',
    );
    expect(serverVerdict(health({ alive: false, status: null, reason: 'timeout' }))).toBe(
      'fallback',
    );
  });
});

describe('probeUrlLive', () => {
  it('reports the tailscale-502 case dead WITHOUT consulting the browser', async () => {
    // The whole point: the opaque probe would say "alive" here, and asking it
    // could only produce the wrong answer. So we must not ask.
    const opaque = vi.fn(async () => true);
    const r = await probeUrlLive('p1', 'https://host.ts.net/app', {
      health: async () => health({ alive: false, status: 502, reason: 'gateway' }),
      opaque,
    });
    expect(r).toEqual({ alive: false, reason: 'gateway', status: 502 });
    expect(opaque).not.toHaveBeenCalled();
  });

  it('reports a healthy app alive without consulting the browser', async () => {
    const opaque = vi.fn(async () => false);
    const r = await probeUrlLive('p1', 'http://127.0.0.1:4321/', {
      health: async () => health({ status: 200, reason: 'ok' }),
      opaque,
    });
    expect(r.alive).toBe(true);
    expect(opaque).not.toHaveBeenCalled();
  });

  it('keeps an auth-walled app alive — a 401 is not a stopped server', async () => {
    const r = await probeUrlLive('p1', 'http://127.0.0.1:4321/', {
      health: async () => health({ alive: true, status: 401, reason: 'client_error' }),
      opaque: async () => false,
    });
    expect(r.alive).toBe(true);
    expect(r.status).toBe(401);
  });

  it('lets the browser overrule "unreachable" — the URL may be on the viewer’s network only', async () => {
    // A pane URL reachable from this phone's LAN/VPN but not from the muxpad
    // host. The server failing to reach it says nothing about the user.
    const r = await probeUrlLive('p1', 'http://192.168.7.20:3000/', {
      health: async () => health({ alive: false, status: null, reason: 'unreachable' }),
      opaque: async () => true,
    });
    expect(r).toEqual({ alive: true, reason: 'opaque', status: null });
  });

  it('keeps the server’s reason when both probes agree it is dead', async () => {
    // 'timeout' tells the user something 'opaque' never could.
    const r = await probeUrlLive('p1', 'http://127.0.0.1:4321/', {
      health: async () => health({ alive: false, status: null, reason: 'timeout' }),
      opaque: async () => false,
    });
    expect(r).toEqual({ alive: false, reason: 'timeout', status: null });
  });

  it('degrades to the old browser-only behaviour when the endpoint itself fails', async () => {
    // A 403/404 from url-health, or a muxpad API blip. Losing 502 detection is
    // a regression; declaring every app dead because OUR api hiccuped is an
    // outage. So: fall back, never condemn.
    const rejecting = async () => {
      throw new Error('403 forbidden');
    };
    await expect(
      probeUrlLive('p1', 'http://127.0.0.1:4321/', { health: rejecting, opaque: async () => true }),
    ).resolves.toEqual({ alive: true, reason: 'opaque', status: null });
    await expect(
      probeUrlLive('p1', 'http://127.0.0.1:4321/', {
        health: rejecting,
        opaque: async () => false,
      }),
    ).resolves.toEqual({ alive: false, reason: 'unreachable', status: null });
  });

  it('never rejects, whatever both probes do', async () => {
    const boom = async () => {
      throw new Error('nope');
    };
    await expect(
      probeUrlLive('p1', 'http://x/', { health: boom, opaque: async () => false }),
    ).resolves.toMatchObject({ alive: false });
  });
});
