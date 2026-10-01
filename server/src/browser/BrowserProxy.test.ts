import { describe, expect, it } from 'vitest';
import { BROWSER_PROXY_PREFIX, browserViewerLink, parseBrowserProxyPath } from './BrowserProxy.js';

/**
 * Reaching the viewer from somewhere other than this machine.
 *
 * THE PROBLEM. The browser host binds 127.0.0.1 — it must, since it is a
 * driveable browser holding every cookie the user has, and this machine is on a
 * tailnet. But the whole point of the handoff is that you take the wheel from
 * wherever you are, usually a phone. A loopback URL on a phone is nothing.
 *
 * THE FIX, and why it is a proxy rather than a second listener: muxpad's own
 * cockpit is ALREADY reachable over the tailnet, and already has exactly the
 * right reachability — tailnet-only, never a public funnel. Serving the viewer
 * underneath it means the link inherits that, with no new port exposed, no
 * `tailscale serve` mapping (which would need the CLI, which would raise a TCC
 * prompt — see findChrome.ts), and no second thing to get wrong. It also makes
 * the modal's iframe SAME-ORIGIN with the cockpit, which it was not before.
 */

describe('the proxy path', () => {
  it('splits a profile off the prefix', () => {
    expect(parseBrowserProxyPath(`${BROWSER_PROXY_PREFIX}/default/`)).toEqual({
      profile: 'default',
      rest: '/',
    });
  });

  it('keeps the remainder, which is how /ws and /upload get through', () => {
    expect(parseBrowserProxyPath(`${BROWSER_PROXY_PREFIX}/default/ws`)?.rest).toBe('/ws');
    expect(parseBrowserProxyPath(`${BROWSER_PROXY_PREFIX}/default/upload`)?.rest).toBe('/upload');
  });

  it('treats a bare profile as the root', () => {
    expect(parseBrowserProxyPath(`${BROWSER_PROXY_PREFIX}/default`)).toEqual({
      profile: 'default',
      rest: '/',
    });
  });

  it('is null for anything outside the prefix', () => {
    for (const p of ['/api/browsers', '/', '/browserish/default', '']) {
      expect(parseBrowserProxyPath(p), p).toBeNull();
    }
  });

  it('is null for a profile name that is not a bare slug', () => {
    // The profile is looked up, not used as a path — but refusing it here means
    // a traversal never even reaches the lookup.
    for (const bad of ['..', '%2e%2e', 'a b']) {
      expect(parseBrowserProxyPath(`${BROWSER_PROXY_PREFIX}/${bad}/`), bad).toBeNull();
    }
  });

  it('is null when no profile is named at all', () => {
    expect(parseBrowserProxyPath(BROWSER_PROXY_PREFIX)).toBeNull();
    expect(parseBrowserProxyPath(`${BROWSER_PROXY_PREFIX}/`)).toBeNull();
  });
});

describe('the link handed to a person', () => {
  it('is the TAILNET origin when the machine has one', () => {
    expect(browserViewerLink('default', 'dt-mac-mini.example-tailnet.ts.net')).toBe(
      'https://dt-mac-mini.example-tailnet.ts.net/browser/default/',
    );
  });

  it('falls back to the cockpit origin rather than inventing a hostname', () => {
    // A wrong hostname fails later and less visibly than an honest local one.
    expect(browserViewerLink('default', null, 'http://127.0.0.1:7777')).toBe(
      'http://127.0.0.1:7777/browser/default/',
    );
  });

  it('always ends in a slash, so the viewer’s relative urls resolve', () => {
    // Without it, `./upload` from /browser/default resolves to /browser/upload.
    for (const link of [
      browserViewerLink('default', 'host.ts.net'),
      browserViewerLink('default', null, 'http://127.0.0.1:7777'),
    ]) {
      expect(link.endsWith('/'), link).toBe(true);
    }
  });

  it('normalizes the profile, so one browser has one link', () => {
    expect(browserViewerLink('Default', 'host.ts.net')).toBe(
      'https://host.ts.net/browser/default/',
    );
  });
});
