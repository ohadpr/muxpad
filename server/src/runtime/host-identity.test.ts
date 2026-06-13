import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPrivateAddress,
  isSelfHost,
  normalizeHost,
  probeListening,
  toReachableUrl,
} from './host-identity.js';

/** Open a throwaway TCP server on a free port of `bindHost`; returns {port, close}. */
function listenEphemeral(bindHost = '127.0.0.1'): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('host-identity — probeListening', () => {
  let toClose: (() => void) | null = null;
  afterEach(() => {
    toClose?.();
    toClose = null;
  });

  it('returns true for a host:port that is actually listening', async () => {
    const { port, close } = await listenEphemeral();
    toClose = close;
    expect(await probeListening('127.0.0.1', port)).toBe(true);
  });

  it('returns false for a port nothing is listening on', async () => {
    // Grab then immediately release a port so we know it is free.
    const { port, close } = await listenEphemeral();
    close();
    expect(await probeListening('127.0.0.1', port, 200)).toBe(false);
  });

  it('returns false for an out-of-range port instead of throwing', async () => {
    expect(await probeListening('127.0.0.1', 0)).toBe(false);
    expect(await probeListening('127.0.0.1', 70000)).toBe(false);
  });

  it('dials the candidate host, not a fixed loopback (concrete-IP bind)', async () => {
    // A server bound only to ::1 is invisible to a 127.0.0.1 probe — the old
    // bug. Dialing the candidate's own host finds it.
    const { port, close } = await listenEphemeral('::1');
    toClose = close;
    expect(await probeListening('::1', port)).toBe(true);
    expect(await probeListening('127.0.0.1', port, 200)).toBe(false);
  });

  it('maps an unspecified IPv6 bind (::) to its loopback when probing', async () => {
    // Python 3.14 prints http://[::]:PORT/; the candidate host is `::`, which
    // is not directly connectable — we must probe ::1.
    const { port, close } = await listenEphemeral('::1');
    toClose = close;
    expect(await probeListening('::', port)).toBe(true);
  });

  it('maps an unspecified IPv4 bind (0.0.0.0) to 127.0.0.1 when probing', async () => {
    const { port, close } = await listenEphemeral('127.0.0.1');
    toClose = close;
    expect(await probeListening('0.0.0.0', port)).toBe(true);
  });
});

describe('host-identity — normalizeHost', () => {
  it('strips the brackets Node wraps around IPv6 literals', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('[::]')).toBe('::');
    expect(normalizeHost('[FE80::1]')).toBe('fe80::1');
  });

  it('lowercases and passes through ordinary hosts unchanged', () => {
    expect(normalizeHost('LOCALHOST')).toBe('localhost');
    expect(normalizeHost('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('host-identity — isPrivateAddress', () => {
  it('accepts loopback / RFC1918 / link-local / CGNAT ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.20',
      '172.16.5.5',
      '172.31.255.255',
      '169.254.1.1',
      '100.64.0.1',
      '100.118.83.18', // CGNAT (Tailscale-style)
      '100.127.255.255',
      '::1',
      'fe80::1',
      'fd7a:115c:a1e0::1', // unique-local (Tailscale-style)
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('rejects public addresses and out-of-range neighbours', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1', // just below the 172.16/12 block
      '172.32.0.1', // just above it
      '100.63.0.1', // just below CGNAT
      '100.128.0.1', // just above CGNAT
      '2606:4700::1', // public IPv6
      '999.0.0.1', // not a valid octet
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});

describe('host-identity — isSelfHost', () => {
  it('recognizes local host forms', async () => {
    expect(await isSelfHost('localhost')).toBe(true);
    expect(await isSelfHost('127.0.0.1')).toBe(true);
    expect(await isSelfHost('0.0.0.0')).toBe(true);
  });

  it('recognizes bracketed IPv6 loopback/unspecified forms (the dropped-app bug)', async () => {
    // new URL('http://[::1]:3000').hostname === '[::1]' — must still match.
    expect(await isSelfHost('[::1]')).toBe(true);
    expect(await isSelfHost('[::]')).toBe(true);
  });

  it('accepts private/LAN/VPN address literals without any DNS or VPN CLI', async () => {
    expect(await isSelfHost('192.168.1.50')).toBe(true);
    expect(await isSelfHost('10.1.2.3')).toBe(true);
    expect(await isSelfHost('100.118.83.18')).toBe(true); // tailnet-style CGNAT IP
  });

  it('rejects a public address literal (no DNS needed)', async () => {
    expect(await isSelfHost('8.8.8.8')).toBe(false);
    expect(await isSelfHost('1.1.1.1')).toBe(false);
  });

  it('rejects an external host name (the github-looking case)', async () => {
    // Resolves to a public IP (or fails to resolve) — either way, not local.
    expect(await isSelfHost('github.com')).toBe(false);
  });
});

describe('host-identity — toReachableUrl', () => {
  it('leaves a non-local URL unchanged', async () => {
    expect(await toReachableUrl('https://github.com/u/r')).toBe('https://github.com/u/r');
  });

  it('returns the original string for an unparseable URL', async () => {
    expect(await toReachableUrl('not a url')).toBe('not a url');
  });

  it('rewrites an all-interfaces host to loopback when not on a tailnet', async () => {
    // 0.0.0.0 is a valid bind address but won't load in a browser. Only
    // assert the swap when this machine isn't on a tailnet (otherwise the
    // result is the tailnet name, which is also fine but host-dependent).
    const out = await toReachableUrl('http://0.0.0.0:3000/');
    if (!out.includes('.ts.net')) {
      expect(out).toBe('http://127.0.0.1:3000/');
    }
  });

  it('rewrites an unspecified IPv6 bind ([::]) to loopback when not on a tailnet', async () => {
    // The bracketed IPv6 form must be recognized as unspecified, same as 0.0.0.0.
    const out = await toReachableUrl('http://[::]:3000/');
    if (!out.includes('.ts.net')) {
      expect(out).toBe('http://127.0.0.1:3000/');
    }
  });
});
