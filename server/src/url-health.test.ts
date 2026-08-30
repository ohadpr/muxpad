// Host classification for the url-health SSRF guard. The route refuses
// link-local/metadata targets outright and will only let an output-scraped app
// URL authorize a LOOPBACK probe, so a mis-classification here is the whole
// guard — see routes/panes.ts's trust-model note.
import { describe, expect, it } from 'vitest';
import { classifyUrlHost } from './url-health.js';

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
