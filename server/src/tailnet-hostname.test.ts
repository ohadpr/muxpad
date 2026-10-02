import { describe, expect, it } from 'vitest';
import { tailnetHostname } from './tailnet-hostname.js';

/** os.networkInterfaces()-shaped fixture, trimmed to the fields we read. */
const ifaces = (addrs: Record<string, Array<{ address: string; family: string }>>) =>
  addrs as unknown as ReturnType<typeof import('node:os').networkInterfaces>;

const TAILNET = ifaces({
  lo0: [{ address: '127.0.0.1', family: 'IPv4' }],
  en0: [{ address: '192.168.1.40', family: 'IPv4' }],
  utun4: [{ address: '100.64.0.1', family: 'IPv4' }],
});

describe('tailnetHostname', () => {
  it('reverse-resolves the 100.64/10 address and drops the trailing dot', async () => {
    const asked: string[] = [];
    const got = await tailnetHostname({
      interfaces: () => TAILNET,
      reverse: async (ip) => {
        asked.push(ip);
        return ['example-host.example-tailnet.ts.net.'];
      },
    });
    expect(got).toBe('example-host.example-tailnet.ts.net');
    // Only the tailnet address is asked about — not the LAN or loopback one.
    expect(asked).toEqual(['100.64.0.1']);
  });

  it('ignores addresses outside 100.64/10', async () => {
    // 100.5.x.x is ORDINARY public space, not CGNAT. Treating the whole 100/8
    // as tailnet would reverse-resolve a stranger's host and believe the answer.
    const got = await tailnetHostname({
      interfaces: () =>
        ifaces({
          en0: [
            { address: '100.5.0.1', family: 'IPv4' },
            { address: '100.200.0.1', family: 'IPv4' },
            { address: '10.0.0.1', family: 'IPv4' },
          ],
        }),
      reverse: async () => {
        throw new Error('must not reverse a non-CGNAT address');
      },
    });
    expect(got).toBeNull();
  });

  it('accepts the whole CGNAT range and nothing either side of it', async () => {
    const seen: string[] = [];
    for (const addr of ['100.63.0.1', '100.64.0.1', '100.127.255.255', '100.128.0.1']) {
      const got = await tailnetHostname({
        interfaces: () => ifaces({ utun0: [{ address: addr, family: 'IPv4' }] }),
        reverse: async (ip) => {
          seen.push(ip);
          return ['h.example-tailnet.ts.net'];
        },
      });
      // Inside the range → resolved; outside → never even asked.
      expect(got === null).toBe(addr === '100.63.0.1' || addr === '100.128.0.1');
    }
    expect(seen).toEqual(['100.64.0.1', '100.127.255.255']);
  });

  it('refuses a PTR answer that is not a ts.net name', async () => {
    // MagicDNS off, or a home router answering the PTR for CGNAT space. A
    // hostname from that is not a tailnet name and would build a dead link.
    const got = await tailnetHostname({
      interfaces: () => TAILNET,
      reverse: async () => ['mini.lan'],
    });
    expect(got).toBeNull();
  });

  it('returns null when there is no tailnet address at all', async () => {
    const got = await tailnetHostname({
      interfaces: () => ifaces({ en0: [{ address: '192.168.1.40', family: 'IPv4' }] }),
      reverse: async () => {
        throw new Error('must not be called');
      },
    });
    expect(got).toBeNull();
  });

  it('returns null — never throws — when the reverse lookup fails', async () => {
    // ENOTFOUND is the normal answer when tailscaled is down. This runs on the
    // publish path, so it degrades rather than failing the publish.
    const got = await tailnetHostname({
      interfaces: () => TAILNET,
      reverse: async () => {
        const err = new Error('queryPtr ENOTFOUND') as NodeJS.ErrnoException;
        err.code = 'ENOTFOUND';
        throw err;
      },
    });
    expect(got).toBeNull();
  });

  it('rejects a PTR answer merely CONTAINING ts.net', async () => {
    const got = await tailnetHostname({
      interfaces: () => TAILNET,
      reverse: async () => ['ts.net.attacker.example'],
    });
    expect(got).toBeNull();
  });
});
