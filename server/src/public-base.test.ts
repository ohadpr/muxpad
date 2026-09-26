import type { UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Funnel } from './funnel.js';
import {
  DISCOVERY_RETRY_TTL_MS,
  PUBLIC_BASE_PINNED_KEY,
  PUBLIC_BASE_URL_KEY,
  type PublicBaseResolver,
  TAILSCALE_DISCOVERY_KEY,
  createPublicBaseResolver,
  normalizeBaseUrl,
} from './public-base.js';
import { GlobalsStore } from './store/GlobalsStore.js';
import { openDb } from './store/db.js';

const ALIVE: UrlHealth = { alive: true, status: 404, reason: 'client_error', elapsedMs: 1 };
const DEAD: UrlHealth = { alive: false, status: null, reason: 'unreachable', elapsedMs: 1 };

/** The real-world shape: the funnel reports the :8443 url that many networks block. */
const FUNNEL = 'https://example-host.example-tailnet.ts.net:8443';
/** A tunnel on standard :443. Ephemeral — a value, never a constant in src/. */
const TUNNEL = 'https://part-anonymous-brilliant-resume.trycloudflare.com';

let db: Database.Database;
let globals: GlobalsStore;
let funnelCalls: number;
let funnel: Funnel;
let reachable: Set<string>;

function make(over: Partial<Parameters<typeof createPublicBaseResolver>[0]> = {}) {
  return createPublicBaseResolver({
    db,
    funnel,
    publicPort: 7778,
    probe: async (url) => (reachable.has(url.replace(/\/$/, '')) ? ALIVE : DEAD),
    // NO TAILNET unless a test asks for one. Stated explicitly even though the
    // resolver now defaults to off, because it is load-bearing for most tests
    // below: the real lookup does a live PTR, so a test that got one would pass
    // or fail depending on whether the box running it is on a tailnet.
    tailnetHostname: async () => null,
    ...over,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  globals = new GlobalsStore(db);
  funnelCalls = 0;
  funnel = {
    async ensure() {
      funnelCalls += 1;
      return { baseUrl: FUNNEL };
    },
  };
  reachable = new Set([FUNNEL, TUNNEL]);
});

describe('normalizeBaseUrl', () => {
  it('accepts a plain https origin and drops the trailing slash', () => {
    expect(normalizeBaseUrl('https://x.example/')).toBe('https://x.example');
    expect(normalizeBaseUrl(`${TUNNEL}/`)).toBe(TUNNEL);
    expect(normalizeBaseUrl('https://x.example:8443')).toBe('https://x.example:8443');
  });

  it('refuses anything that is not a bare origin', () => {
    for (const bad of [
      undefined,
      '',
      'not a url',
      'https://x.example/path',
      'https://x.example/?q=1',
      'https://x.example/#f',
      'https://u:p@x.example',
      'ftp://x.example',
      `https://${'x'.repeat(600)}.example`,
    ]) {
      expect(normalizeBaseUrl(bad)).toBeNull();
    }
  });

  it('allows http ONLY for loopback', () => {
    // The local fallback needs http; a public http base would hand out links
    // that leak the artifact in transit.
    expect(normalizeBaseUrl('http://127.0.0.1:7778')).toBe('http://127.0.0.1:7778');
    expect(normalizeBaseUrl('http://localhost:7778')).toBe('http://localhost:7778');
    expect(normalizeBaseUrl('http://example.com')).toBeNull();
  });
});

describe('precedence — configuration beats discovery', () => {
  it('env outranks everything', async () => {
    globals.set(PUBLIC_BASE_PINNED_KEY, TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    const r = make({ configuredBaseUrl: 'https://artifacts.example.com' });
    reachable.add('https://artifacts.example.com');
    const got = await r.resolve({ hint: FUNNEL, allowDiscovery: true, probe: true });
    expect(got).toMatchObject({ baseUrl: 'https://artifacts.example.com', source: 'env' });
  });

  it('a PIN beats the funnel hint — the bug this whole module exists for', async () => {
    const r = make();
    r.setPinned(TUNNEL);
    // Every publish sends the funnel url as a hint. It must not win…
    const got = await r.resolve({ hint: FUNNEL, allowDiscovery: true, probe: true });
    expect(got.baseUrl).toBe(TUNNEL);
    expect(got.source).toBe('pinned');
    // …and, crucially, must not survive as the answer NEXT time either. The
    // hint is still persisted (it is real information), but it stays below.
    expect(globals.get(PUBLIC_BASE_URL_KEY)).toBe(FUNNEL);
    expect((await r.resolve({ probe: true })).baseUrl).toBe(TUNNEL);
  });

  it('MUXPAD_PUBLIC_BASE_URL beats a live tunnel — the domain is the answer', async () => {
    // Precedence half of decision 1. (The other half is that the tunnel is not
    // even RUN when env is set — tunnel/TunnelApp.test.ts.)
    const r = make({
      configuredBaseUrl: 'https://artifacts.example.com',
      tunnelBaseUrl: () => TUNNEL,
    });
    reachable.add('https://artifacts.example.com');
    const got = await r.resolve({ hint: FUNNEL, allowDiscovery: true, probe: true });
    expect(got).toMatchObject({ baseUrl: 'https://artifacts.example.com', source: 'env' });
  });

  it('a human PIN outranks the tunnel muxpad minted for itself', async () => {
    const pinned = 'https://mine.example.com';
    reachable.add(pinned);
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    r.setPinned(pinned);
    expect(await r.resolve({ probe: true })).toMatchObject({ baseUrl: pinned, source: 'pinned' });
  });

  it("the TUNNEL outranks the publish hint — the funnel's :8443 must not clobber it", async () => {
    // This is the original bug in its new form: every publish sends the funnel
    // url as a hint. A live, muxpad-owned tunnel on :443 must win.
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    const got = await r.resolve({ hint: FUNNEL, allowDiscovery: true, probe: true });
    expect(got).toMatchObject({ baseUrl: TUNNEL, source: 'tunnel' });
    expect(funnelCalls).toBe(0);
  });

  it('a tunnel that is down offers no candidate at all', async () => {
    // tunnelBaseUrl() applies the ownership rules; a dead tunnel returns null,
    // so the chain falls through instead of preserving a dead hostname.
    const r = make({ tunnelBaseUrl: () => null });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    const got = await r.resolve({ probe: true });
    expect(got.source).toBe('persisted');
    expect(r.candidates().some((c) => c.source === 'tunnel')).toBe(false);
  });

  it('trusts a tunnel url without probing it — we own the process that IS it', async () => {
    // Deliberately inverted from the old contract, which demoted a tunnel the
    // probe could not reach. Observed live: the tunnel served 200 through
    // Cloudflare's edge while THIS machine's resolver returned NXDOMAIN for
    // its own hostname, so muxpad demoted a working public URL and published
    // the Tailscale funnel — already established as blocked on many networks.
    // A false negative here does not degrade the link, it swaps a working one
    // for a broken one.
    //
    // The liveness the probe was approximating is known exactly: the record
    // exists only while our supervised cloudflared runs, is retracted the
    // instant it exits, is ignored unless its announcing pane is still the
    // app's, and is cleared at boot. The residual window is the ~20s after a
    // ptyd restart, where a record can briefly outlive its process — a link
    // that is briefly dead, against a link that was always wrong.
    const live = 'https://any-name.trycloudflare.com';
    const r = make({ tunnelBaseUrl: () => live });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    // `live` is NOT in `reachable` — the point is that it wins anyway.
    const got = await r.resolve({ probe: true });
    expect(got.baseUrl).toBe(live);
    expect(got.source).toBe('tunnel');
  });

  it('explains a tunnel that keeps failing, instead of a generic shrug', async () => {
    const r = make({
      tunnelBaseUrl: () => null,
      tunnelWarning: () => 'the cloudflare tunnel has failed to start 5 times in a row',
    });
    const got = await r.resolve({ probe: true });
    expect(got.source).toBe('local');
    expect(got.warning).toContain('failed to start 5 times');
  });

  it('names the tunnel when it is why nothing answers', async () => {
    const dead = 'https://gone-forever-name.trycloudflare.com';
    const r = make({
      tunnelBaseUrl: () => dead,
      tunnelWarning: () => 'the cloudflare tunnel has failed to start 5 times in a row',
    });
    const got = await r.resolve({ probe: true });
    expect(got.baseUrl).toBe(dead);
    expect(got.warning).toContain('failed to start 5 times');
  });

  it('a hint is used and persisted when nothing outranks it, without exec', async () => {
    const r = make();
    const got = await r.resolve({ hint: TUNNEL, allowDiscovery: true, probe: true });
    expect(got).toMatchObject({ baseUrl: TUNNEL, source: 'hint' });
    expect(globals.get(PUBLIC_BASE_URL_KEY)).toBe(TUNNEL);
    // Discovery is a LAST resort — the caller already told us.
    expect(funnelCalls).toBe(0);
  });

  it('discovery runs only when nothing else is known', async () => {
    const r = make();
    const got = await r.resolve({ allowDiscovery: true, probe: true });
    expect(got).toMatchObject({ baseUrl: FUNNEL, source: 'funnel' });
    expect(funnelCalls).toBe(1);
    // Once persisted, it is never re-discovered — so a pin set afterwards is
    // not clobbered by the next publish.
    const r2 = make();
    r2.setPinned(TUNNEL);
    expect((await r2.resolve({ allowDiscovery: true, probe: true })).baseUrl).toBe(TUNNEL);
    expect(funnelCalls).toBe(1);
  });

  it('read paths never exec', async () => {
    const r = make();
    await r.resolve({ probe: true });
    expect(funnelCalls).toBe(0);
  });

  // THE POINT OF ALL OF THIS. Tailscale here is a Mac App Store install: the
  // only binary is inside the sandboxed app bundle, `brew install` is not
  // happening, and touching the bundle always raises the macOS prompt. So the
  // tailnet name has to come from somewhere that is not the bundle — the
  // machine's own 100.64/10 address, reverse-resolved through MagicDNS.
  describe('no-exec tailnet discovery outranks the funnel', () => {
    it('uses the PTR name and never calls funnel.ensure()', async () => {
      const r = make({ tailnetHostname: async () => 'example-host.example-tailnet.ts.net' });
      const got = await r.resolve({ allowDiscovery: true, probe: true });
      expect(got).toMatchObject({ baseUrl: FUNNEL, source: 'tailnet' });
      expect(funnelCalls).toBe(0);
      // Persisted like any other discovery, so later publishes ask nothing.
      expect(globals.get(PUBLIC_BASE_URL_KEY)).toBe(FUNNEL);
    });

    it('falls through to the funnel exec only when the PTR yields nothing', async () => {
      const r = make({ tailnetHostname: async () => null });
      const got = await r.resolve({ allowDiscovery: true, probe: true });
      expect(got.source).toBe('funnel');
      expect(funnelCalls).toBe(1);
    });

    it('does not run on read paths, like every other discovery', async () => {
      let asked = 0;
      const r = make({
        tailnetHostname: async () => {
          asked += 1;
          return 'dt-mac-mini.example-tailnet.ts.net';
        },
      });
      await r.resolve({ probe: true });
      expect(asked).toBe(0);
    });

    it('is OFF by default — only the real server wires it', async () => {
      // Same safety property localFunnel gives the funnel: nothing a test builds
      // may reach the network (or tailscale) unless it asked to. This bit me for
      // real — making the lookup live-by-default broke six route tests on a
      // machine that happens to be on a tailnet, and would have passed on one
      // that is not. The live resolver is wired in exactly one place, index.ts.
      const bare = createPublicBaseResolver({
        db,
        funnel,
        publicPort: 7778,
        probe: async () => ALIVE,
      });
      const got = await bare.resolve({ allowDiscovery: true, probe: true });
      expect(got.source).toBe('funnel');
      expect(funnelCalls).toBe(1);
    });

    it('is NOT rationed by the funnel retry TTL — it costs nothing', async () => {
      // A machine whose funnel exec failed an hour ago, then joined a tailnet.
      // If the free tier sat behind the same TTL as the exec, it would go on
      // publishing local-only links for the rest of the six hours for no reason.
      const clock = 1_700_000_000_000;
      globals.set(TAILSCALE_DISCOVERY_KEY, String(clock - 60_000));
      const r = make({
        now: () => clock,
        tailnetHostname: async () => 'example-host.example-tailnet.ts.net',
      });
      const got = await r.resolve({ allowDiscovery: true, probe: true });
      expect(got).toMatchObject({ baseUrl: FUNNEL, source: 'tailnet' });
      // …and still without the exec the TTL was rationing.
      expect(funnelCalls).toBe(0);
    });

    it('ignores a PTR name that does not make a valid https origin', async () => {
      const r = make({ tailnetHostname: async () => 'not a hostname' });
      const got = await r.resolve({ allowDiscovery: true, probe: true });
      // Rejected by normalizeBaseUrl, so the funnel still gets its turn.
      expect(got.source).toBe('funnel');
      expect(funnelCalls).toBe(1);
    });
  });

  // A FAILING discovery persists nothing, so before this the gate on
  // `list.length === 0` never closed: every publish on a machine with no
  // reachable tailnet re-execed the Tailscale app binary, and macOS asked
  // about it every time. The attempt itself is now the thing remembered.
  describe('the discovery attempt is remembered even when it fails', () => {
    let clock: number;
    const failing = (): Funnel => ({
      async ensure() {
        funnelCalls += 1;
        return { baseUrl: 'http://127.0.0.1:7778', warning: 'The Tailscale GUI failed to start' };
      },
    });

    beforeEach(() => {
      clock = 1_700_000_000_000;
    });

    it('execs once, then not again for the whole TTL — across processes', async () => {
      const opts = { funnel: failing(), now: () => clock };
      await make(opts).resolve({ allowDiscovery: true, probe: true });
      expect(funnelCalls).toBe(1);
      expect(globals.get(TAILSCALE_DISCOVERY_KEY)).toBe(String(clock));

      // A FRESH resolver — the marker has to outlive the process, because a
      // restarted daemon that re-asked would be back to prompting.
      clock += 60_000;
      const again = await make(opts).resolve({ allowDiscovery: true, probe: true });
      expect(funnelCalls).toBe(1);
      // Still degrades honestly; it just does so without shelling out.
      expect(again.source).toBe('local');
      expect(again.warning).toBeTruthy();
    });

    it('retries once the TTL has elapsed', async () => {
      const opts = { funnel: failing(), now: () => clock };
      await make(opts).resolve({ allowDiscovery: true, probe: true });
      clock += DISCOVERY_RETRY_TTL_MS + 1;
      await make(opts).resolve({ allowDiscovery: true, probe: true });
      expect(funnelCalls).toBe(2);
    });

    it('a SUCCESSFUL discovery still short-circuits on the persisted base', async () => {
      const r = make({ now: () => clock });
      await r.resolve({ allowDiscovery: true, probe: true });
      expect(funnelCalls).toBe(1);
      clock += DISCOVERY_RETRY_TTL_MS * 10;
      // Way past the retry TTL, but there is a persisted candidate now, so the
      // TTL never comes into it.
      await make({ now: () => clock }).resolve({ allowDiscovery: true, probe: true });
      expect(funnelCalls).toBe(1);
    });
  });

  // What the CLI asks before it decides to shell out in the pane shell.
  describe('discoveryNeeded', () => {
    it('is false while any candidate is known', () => {
      const r = make();
      expect(r.discoveryNeeded()).toBe(true);
      globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
      expect(make().discoveryNeeded()).toBe(false);
    });

    it('is false after a recent attempt, true again after the TTL', () => {
      let clock = 1_700_000_000_000;
      globals.set(TAILSCALE_DISCOVERY_KEY, String(clock));
      expect(make({ now: () => clock }).discoveryNeeded()).toBe(false);
      clock += DISCOVERY_RETRY_TTL_MS + 1;
      expect(make({ now: () => clock }).discoveryNeeded()).toBe(true);
    });

    it('is a pure read — asking never execs, so UI polling cannot eat the slot', () => {
      const r = make();
      r.discoveryNeeded();
      r.discoveryNeeded();
      expect(funnelCalls).toBe(0);
      expect(globals.get(TAILSCALE_DISCOVERY_KEY)).toBeNull();
    });
  });

  it('falls back to a loopback url that says it is not shareable', async () => {
    const r = make({
      funnel: {
        async ensure() {
          return { baseUrl: 'http://127.0.0.1:7778', warning: 'tailscale funnel unavailable' };
        },
      },
    });
    const got = await r.resolve({ allowDiscovery: true, probe: true });
    expect(got.source).toBe('local');
    expect(got.baseUrl).toBe('http://127.0.0.1:7778');
    // The funnel's own explanation wins — it says what went wrong.
    expect(got.warning).toContain('funnel unavailable');
  });
});

describe('reachability', () => {
  it('skips a DEAD candidate and takes the next one', async () => {
    const r = make();
    r.setPinned(TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    // The quick tunnel's process exits and its name stops resolving.
    reachable.delete(TUNNEL);
    const got = await r.resolve({ probe: true });
    expect(got).toMatchObject({ baseUrl: FUNNEL, source: 'persisted' });
  });

  it('keeps the top candidate when NOTHING answers, and warns', async () => {
    const r = make();
    r.setPinned(TUNNEL);
    reachable.clear();
    const got = await r.resolve({ probe: true });
    // A loopback url here would be actively misleading — it is not what the
    // user asked for and it is not shareable either.
    expect(got.baseUrl).toBe(TUNNEL);
    expect(got.warning).toContain('not answering');
  });

  it('never reorders by latency — order is configuration, not measurement', async () => {
    // Both alive: the pinned one wins even though `persisted` was probed too.
    const r = make();
    r.setPinned(TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect((await r.resolve({ probe: true })).baseUrl).toBe(TUNNEL);
  });

  it('caches a probe for the TTL so a polled view is not a load test', async () => {
    let calls = 0;
    let t = 1_000_000;
    const r = createPublicBaseResolver({
      db,
      funnel,
      publicPort: 7778,
      now: () => t,
      probeTtlMs: 30_000,
      probe: async () => {
        calls += 1;
        return ALIVE;
      },
    });
    r.setPinned(TUNNEL);
    for (let i = 0; i < 5; i++) await r.resolve({ probe: true });
    expect(calls).toBe(1);
    t += 31_000;
    await r.resolve({ probe: true });
    expect(calls).toBe(2);
  });

  it('does not probe at all when not asked', async () => {
    let calls = 0;
    const r = createPublicBaseResolver({
      db,
      funnel,
      publicPort: 7778,
      probe: async () => {
        calls += 1;
        return ALIVE;
      },
    });
    r.setPinned(TUNNEL);
    const got = await r.resolve();
    expect(got.baseUrl).toBe(TUNNEL);
    expect(got.health).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('pinning', () => {
  let r: PublicBaseResolver;
  beforeEach(() => {
    r = make();
  });

  it('round-trips and can be cleared', async () => {
    r.setPinned(TUNNEL);
    expect(globals.get(PUBLIC_BASE_PINNED_KEY)).toBe(TUNNEL);
    expect((await r.resolve({ probe: true })).source).toBe('pinned');
    r.setPinned(null);
    expect(globals.get(PUBLIC_BASE_PINNED_KEY)).toBeNull();
  });

  it('refuses a malformed base rather than storing a link that cannot work', () => {
    expect(() => r.setPinned('not a url')).toThrow();
    expect(() => r.setPinned('https://x.example/with/path')).toThrow();
    expect(globals.get(PUBLIC_BASE_PINNED_KEY)).toBeNull();
  });

  it('exposes the ordered candidates for diagnosis', () => {
    r.setPinned(TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect(r.candidates()).toEqual([
      { url: TUNNEL, source: 'pinned' },
      { url: FUNNEL, source: 'persisted' },
    ]);
  });

  it('de-duplicates a url reachable by two routes, keeping the higher source', () => {
    r.setPinned(TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, TUNNEL);
    expect(r.candidates()).toEqual([{ url: TUNNEL, source: 'pinned' }]);
  });
});
