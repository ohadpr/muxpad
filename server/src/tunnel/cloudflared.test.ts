import { describe, expect, it } from 'vitest';
import {
  TUNNEL_BACKOFF_MAX_MS,
  TUNNEL_BACKOFF_MIN_MS,
  findCloudflared,
  parseQuickTunnelUrl,
  tunnelBackoffMs,
} from './cloudflared.js';

/**
 * REAL OUTPUT, captured verbatim from `cloudflared tunnel --url
 * http://127.0.0.1:59999` (version 2026.8.2, macOS arm64) on 2026-09-19 —
 * every line, in order, including the legal notice that contains two OTHER
 * https urls. Nothing here is invented, because the point of this fixture is
 * that it is not: the parser's whole job is to survive a format nobody in this
 * repo controls, and a fixture written from memory tests the memory.
 */
const REAL_OUTPUT = `2026-09-19T21:48:29Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
2026-09-19T21:48:29Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-19T21:48:32Z INF +--------------------------------------------------------------------------------------------+
2026-09-19T21:48:32Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-19T21:48:32Z INF |  https://franklin-discuss-powers-usgs.trycloudflare.com                                    |
2026-09-19T21:48:32Z INF +--------------------------------------------------------------------------------------------+
2026-09-19T21:48:32Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp /etc/cloudflared /usr/local/etc/cloudflared]
2026-09-19T21:48:32Z INF Version 2026.8.2 (Checksum b6bc98e794894b4ccee49c027c7cae050bbf74a92212e2c4bef348f5b33fa846)
2026-09-19T21:48:32Z INF GOOS: darwin, GOVersion: go1.26.6, GoArch: arm64
2026-09-19T21:48:32Z INF Settings: map[ha-connections:1 protocol:quic url:http://127.0.0.1:59999]
2026-09-19T21:48:32Z INF cloudflared will not automatically update if installed by a package manager.
2026-09-19T21:48:32Z INF Generated Connector ID: 253d7217-b301-4190-96c3-4a4e3d3c795e
2026-09-19T21:48:32Z INF Initial protocol quic
2026-09-19T21:48:33Z INF Starting metrics server on 127.0.0.1:20241/metrics
2026-09-19T21:48:33Z INF Registered tunnel connection connIndex=0 connection=9aa38282-9cb6-4ab7-8201-d90176923920 event=0 ip=198.41.192.167 location=sjc06 protocol=quic`;

describe('parseQuickTunnelUrl', () => {
  it('reads the hostname out of real cloudflared output', () => {
    expect(parseQuickTunnelUrl(REAL_OUTPUT)).toBe(
      'https://franklin-discuss-powers-usgs.trycloudflare.com',
    );
  });

  it('ignores the cloudflare.com urls in the legal notice that precedes it', () => {
    // The notice is the FIRST thing printed and contains two https urls. A
    // `https://\S+` grep would pin the public base to Cloudflare's own website
    // on every start — and the failure would be invisible, because that name
    // resolves and the reachability probe would call it healthy.
    const noticeOnly = REAL_OUTPUT.split('\n').slice(0, 2).join('\n');
    expect(parseQuickTunnelUrl(noticeOnly)).toBeNull();
  });

  it('survives arriving in arbitrary chunks, as a pipe delivers it', () => {
    // The url line is padded inside an ASCII box, so it is neither the start
    // nor the end of its line.
    const line =
      '2026-09-19T21:48:32Z INF |  https://franklin-discuss-powers-usgs.trycloudflare.com    |';
    expect(parseQuickTunnelUrl(line)).toBe(
      'https://franklin-discuss-powers-usgs.trycloudflare.com',
    );
  });

  it('is stateless across calls', () => {
    // The regex is module-level and /g, which is stateful — a missed
    // lastIndex reset makes every OTHER call return null.
    for (let i = 0; i < 4; i++) {
      expect(parseQuickTunnelUrl(REAL_OUTPUT)).toBe(
        'https://franklin-discuss-powers-usgs.trycloudflare.com',
      );
    }
  });

  it('refuses a lookalike host that merely starts with a tunnel name', () => {
    expect(
      parseQuickTunnelUrl('visit https://franklin-discuss.trycloudflare.com.evil.test/x'),
    ).toBeNull();
    expect(parseQuickTunnelUrl('https://sub.domain.trycloudflare.com')).toBeNull();
  });

  it('returns an origin, never a url with a path', () => {
    const url = parseQuickTunnelUrl('https://abc-def.trycloudflare.com/some/path');
    expect(url).toBe('https://abc-def.trycloudflare.com');
  });

  it('returns null for output with no hostname yet', () => {
    expect(
      parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'),
    ).toBeNull();
    expect(parseQuickTunnelUrl('')).toBeNull();
  });
});

describe('findCloudflared', () => {
  it('honours an explicit override', () => {
    expect(
      findCloudflared({
        env: { MUXPAD_CLOUDFLARED_BIN: '/custom/cf' },
        exists: (p) => p === '/custom/cf',
      }),
    ).toBe('/custom/cf');
  });

  it('refuses an override that is not there rather than silently picking another', () => {
    expect(
      findCloudflared({
        env: { MUXPAD_CLOUDFLARED_BIN: '/custom/cf', PATH: '/usr/bin' },
        exists: (p) => p === '/usr/bin/cloudflared',
      }),
    ).toBeNull();
  });

  it('searches PATH, then the homebrew fallback', () => {
    expect(
      findCloudflared({
        env: { PATH: '/nope:/usr/bin' },
        exists: (p) => p === '/usr/bin/cloudflared',
      }),
    ).toBe('/usr/bin/cloudflared');
    // launchd hands the daemon a minimal PATH, which is exactly where the
    // fallback earns its keep.
    expect(
      findCloudflared({
        env: { PATH: '/nope' },
        exists: (p) => p === '/opt/homebrew/bin/cloudflared',
      }),
    ).toBe('/opt/homebrew/bin/cloudflared');
  });

  it('answers null — not an exception — when cloudflared is missing', () => {
    expect(findCloudflared({ env: { PATH: '/nope' }, exists: () => false })).toBeNull();
  });
});

describe('tunnelBackoffMs', () => {
  it('starts small and doubles', () => {
    expect(tunnelBackoffMs(1)).toBe(TUNNEL_BACKOFF_MIN_MS);
    expect(tunnelBackoffMs(2)).toBe(TUNNEL_BACKOFF_MIN_MS * 2);
    expect(tunnelBackoffMs(3)).toBe(TUNNEL_BACKOFF_MIN_MS * 4);
  });

  it('CAPS, and stays capped however many times it has failed', () => {
    // The storm guard: an account-less quick tunnel that Cloudflare refuses
    // fails in well under a second, so an uncapped retry rate is a spin
    // against someone else's API.
    expect(tunnelBackoffMs(20)).toBe(TUNNEL_BACKOFF_MAX_MS);
    expect(tunnelBackoffMs(10_000)).toBe(TUNNEL_BACKOFF_MAX_MS);
    // 2 ** 10000 is Infinity — the cap must survive that too.
    expect(Number.isFinite(tunnelBackoffMs(10_000))).toBe(true);
  });

  it('never waits before the first attempt', () => {
    expect(tunnelBackoffMs(0)).toBe(0);
  });
});
