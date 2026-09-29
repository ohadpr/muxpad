// Host classification for the url-health SSRF guard. The route refuses
// link-local/metadata targets outright and will only let an output-scraped app
// URL authorize a LOOPBACK probe, so a mis-classification here is the whole
// guard — see routes/panes.ts's trust-model note.
import { describe, expect, it } from 'vitest';
import { classifyStatus, classifyUrlHost } from './url-health.js';

/**
 * The gateway rule, which had no test at all — and it is now load-bearing for
 * more than the iframe face it was written for.
 *
 * `MUXPAD_PUBLIC_BASE_URL` pins the published base in CONFIGURATION, so unlike
 * the `tunnel` source it is not gated on the tunnel record and nothing
 * structural demotes it when the connector behind it dies. The only thing that
 * does is this classifier: a Cloudflare hostname whose tunnel has no connector
 * answers 502, and 502 has to mean DEAD or public-base.ts keeps publishing links
 * to a hostname that is answering nothing but an error page.
 */
describe('classifyStatus — a proxy answering for a backend that is gone', () => {
  it('treats the gateway statuses as DEAD', () => {
    for (const s of [502, 503, 504]) {
      expect(classifyStatus(s), `status ${s}`).toEqual({ alive: false, reason: 'gateway' });
    }
  });

  it('but an app answering badly is still alive — its own error beats our notice', () => {
    // The distinction the whole file exists for: 500 is the app, 502 is a proxy
    // saying the app is gone. Collapsing them either hides a real outage or
    // reports a working app as stopped.
    expect(classifyStatus(500).alive).toBe(true);
    expect(classifyStatus(401).alive).toBe(true);
    expect(classifyStatus(404).alive).toBe(true);
    expect(classifyStatus(200).alive).toBe(true);
  });
});

describe('classifyUrlHost', () => {
  it('refuses anything that is not parseable http(s)', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'ftp://x/']) {
      expect(classifyUrlHost(u)).toBeNull();
    }
  });

  it('sees through the alternate spellings of an IPv4 address', () => {
    // `new URL` normalizes decimal/hex/short forms to dotted-quad, and drops
    // userinfo out of `hostname` — so the classifier gets the real target.
    // Asserted because a regression here silently reopens the loopback hole.
    for (const u of [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://ok.example.com@127.0.0.1/',
    ]) {
      expect(classifyUrlHost(u)).toBe('loopback');
    }
  });

  it('flattens IPv4-mapped IPv6 literals before judging them', () => {
    // THE TRAP: `new URL('http://[::ffff:169.254.169.254]/')` normalizes the
    // host to `[::ffff:a9fe:a9fe]`, so a naive string compare never matches
    // while the address still routes to the metadata endpoint.
    expect(classifyUrlHost('http://[::ffff:169.254.169.254]/')).toBe('link_local');
    expect(classifyUrlHost('http://[::ffff:127.0.0.1]/')).toBe('loopback');
    expect(classifyUrlHost('http://[0:0:0:0:0:ffff:7f00:1]/')).toBe('loopback');
    expect(classifyUrlHost('http://[::ffff:0:192.168.1.5]/')).toBe('private');
    expect(classifyUrlHost('http://[::ffff:8.8.8.8]/')).toBe('public');
    // Deprecated IPv4-COMPATIBLE form too (`::a.b.c.d`, normalized to `::7f00:1`).
    expect(classifyUrlHost('http://[::127.0.0.1]/')).toBe('loopback');
    expect(classifyUrlHost('http://[::169.254.169.254]/')).toBe('link_local');
  });

  it('treats the unspecified addresses as loopback — they reach localhost', () => {
    // A dev server really does print `http://0.0.0.0:3000`, so refusing them
    // outright would break a real case; calling them merely "private" would put
    // them on the permissive path instead of the strict loopback one.
    expect(classifyUrlHost('http://0.0.0.0:3000/')).toBe('loopback');
    expect(classifyUrlHost('http://[::]:3000/')).toBe('loopback');
    // The rest of 0.0.0.0/8 is not special-cased.
    expect(classifyUrlHost('http://0.1.2.3/')).toBe('private');
  });

  it('classifies link-local and metadata endpoints, trailing dot and case included', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.169.254./',
      'http://METADATA.GOOGLE.INTERNAL/',
      'http://metadata.goog/',
      'http://[fe80::1]/',
    ]) {
      expect(classifyUrlHost(u)).toBe('link_local');
    }
  });

  it('classifies the private ranges, including CGNAT (tailnet) and ULA', () => {
    for (const u of [
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://100.64.0.1/', // tailnet
      'http://[fd00::1]/',
      'http://nas.local/',
      'http://buildbox/', // bare single label = intranet
    ]) {
      expect(classifyUrlHost(u)).toBe('private');
    }
  });

  it('leaves 172.15/172.32 out of RFC1918 (the off-by-one boundary)', () => {
    expect(classifyUrlHost('http://172.15.0.1/')).toBe('public');
    expect(classifyUrlHost('http://172.32.0.1/')).toBe('public');
  });

  it('treats localhost and ::1 as loopback, real names as public', () => {
    expect(classifyUrlHost('http://localhost:3000/')).toBe('loopback');
    expect(classifyUrlHost('http://[::1]:8080/')).toBe('loopback');
    expect(classifyUrlHost('https://example.com/x')).toBe('public');
    // Not resolved: a public name pointing at a private address reads public.
    // It still has to have been DECLARED on the pane to be probed at all.
    expect(classifyUrlHost('http://localtest.me/')).toBe('public');
  });
});
