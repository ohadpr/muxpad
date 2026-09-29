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
  baseDurability,
  createPublicBaseResolver,
  durabilityNote,
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

  /**
   * CORRECTED, not accommodated. This asserted `baseUrl: TUNNEL` on the
   * reasoning that a tunnel on :443 beats the funnel's blocked :8443 — and that
   * single ranking is why every link handed out between 2026-09-19 and
   * 2026-09-28 is dead. The tunnel was preferred for being PUBLIC, and the
   * artifacts are read on the author's own devices, which are all on the
   * tailnet, where there is nothing public to be.
   *
   * What the test was really guarding is that a HINT cannot clobber
   * CONFIGURATION, and that survives untouched — `env` and `pinned` still sit
   * above everything (the two tests above this one). What changed is the order
   * among the candidates muxpad worked out for itself.
   */
  it('the durable tailnet hint now outranks the ephemeral tunnel, by default', async () => {
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    const got = await r.resolve({ hint: FUNNEL, allowDiscovery: true, probe: true });
    expect(got).toMatchObject({ baseUrl: FUNNEL, source: 'hint', durability: 'tailnet' });
    expect(funnelCalls).toBe(0);
  });

  it('…and the tunnel wins the moment a PUBLIC link is what was asked for', async () => {
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    const got = await r.resolve({
      hint: FUNNEL,
      allowDiscovery: true,
      probe: true,
      audience: 'public',
    });
    expect(got).toMatchObject({ baseUrl: TUNNEL, source: 'tunnel', durability: 'ephemeral' });
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
    // `audience: 'public'` because that is now the only case in which a tunnel
    // is the top candidate at all; the guarantee under test (a false-negative
    // probe must not demote it) is unchanged and still matters there.
    const got = await r.resolve({ probe: true, audience: 'public' });
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

  it('exposes the ordered candidates for diagnosis, each with its durability', () => {
    r.setPinned(TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect(r.candidates()).toEqual([
      { url: TUNNEL, source: 'pinned', durability: 'ephemeral' },
      { url: FUNNEL, source: 'persisted', durability: 'tailnet' },
    ]);
  });

  it('de-duplicates a url reachable by two routes, keeping the higher source', () => {
    r.setPinned(TUNNEL);
    globals.set(PUBLIC_BASE_URL_KEY, TUNNEL);
    expect(r.candidates()).toEqual([{ url: TUNNEL, source: 'pinned', durability: 'ephemeral' }]);
  });
});

/**
 * THE DEFECT THESE COVER — measured on the live machine, 2026-09-28.
 *
 * Every artifact published between 2026-09-19 and 2026-09-27 was printed under
 * `search-particle-rules-ten.trycloudflare.com`. At 19:45 on the 27th ptyd
 * restarted, the tunnel pane was rebuilt, cloudflared was handed a NEW random
 * hostname, and that name stopped resolving — NXDOMAIN, permanently. Every link
 * in every report and every chat transcript from those nine days died at once.
 *
 * Nothing was broken. The resolver picked correctly, the supervisor restarted
 * correctly, the bytes never moved. The defect is that `muxpad publish` printed
 * a URL with a shelf life and said nothing about it, so nine days of links were
 * handed out as if they were permanent.
 *
 * So durability is now a property of the ANSWER, carried on every surface that
 * prints one. It is derived from the HOST, never from the source: a quick-tunnel
 * name a human pinned by hand rots exactly as fast as one muxpad minted for
 * itself — which is the 2026-08-30 incident, where a hand-pinned
 * `part-anonymous-brilliant-resume.trycloudflare.com` outlived its process by
 * nineteen days.
 */
describe('durability — how long the ADDRESS lives, not whether it answers now', () => {
  it('classifies a quick tunnel as ephemeral, whatever rung it came in on', () => {
    for (const source of ['pinned', 'tunnel', 'hint', 'persisted'] as const)
      expect(baseDurability('https://any-name.trycloudflare.com', source)).toBe('ephemeral');
  });

  it('classifies a tailnet name as tailnet-only — durable, but not public', () => {
    expect(baseDurability(FUNNEL, 'persisted')).toBe('tailnet');
    expect(baseDurability('https://dt.example-tailnet.ts.net', 'funnel')).toBe('tailnet');
  });

  it('classifies a real domain as permanent', () => {
    expect(baseDurability('https://pub.example.com', 'env')).toBe('permanent');
    expect(baseDurability('https://pub.example.com', 'pinned')).toBe('permanent');
  });

  it('classifies the loopback fallback as local', () => {
    expect(baseDurability('http://127.0.0.1:7778', 'local')).toBe('local');
  });

  it('writes the sentence the CLI prints, and nothing for a base that keeps', () => {
    expect(durabilityNote('ephemeral')).toContain('quick tunnel');
    expect(durabilityNote('ephemeral')).toContain('muxpad publish --url');
    expect(durabilityNote('tailnet')).toContain('tailnet');
    expect(durabilityNote('permanent')).toBeNull();
    expect(durabilityNote('local')).toBeNull();
  });

  it('rides along on the resolved base, so every caller can say it', async () => {
    const live = 'https://any-name.trycloudflare.com';
    const r = make({ tunnelBaseUrl: () => live });
    reachable.add(live);
    expect(await r.resolve({ probe: true })).toMatchObject({
      source: 'tunnel',
      durability: 'ephemeral',
    });
  });

  it('reports the tailnet funnel as durable-but-private, not as a public base', async () => {
    const r = make();
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect(await r.resolve({ probe: true })).toMatchObject({
      source: 'persisted',
      durability: 'tailnet',
    });
  });
});

/**
 * THE DEFECT THIS FIXES, and it is a ranking, not a mechanism.
 *
 * The candidate list already carried both answers — an ephemeral Cloudflare
 * quick-tunnel name and a durable `*.ts.net` one — and it ranked the rotting one
 * first, so that is what `muxpad publish` printed. On 2026-09-28 alone that put
 * at least six dead links into a conversation: each one worked when it was
 * printed and was NXDOMAIN within hours, because a ptyd bounce mints a new
 * hostname and Cloudflare never gives the old one back.
 *
 * The premise behind the old order was that a public link beats a private one.
 * It is wrong for the case that actually happens: these artifacts are read on
 * the author's OWN devices — laptop, phone — and all of them are on the tailnet,
 * where `https://<host>.ts.net:8443` is permanent, needs no login, no tunnel, no
 * supervision and nothing installed. Verified 2026-09-29: Tailscale listens on
 * 100.111.22.33:8443 (the tailnet address ONLY — not loopback, not 0.0.0.0) and
 * answers 200 for a published artifact.
 *
 * So the default is the link that still works tomorrow, and a public link is
 * something you ASK for. Both orders are the same list, sorted by how long the
 * address lives — for the audience it is meant for.
 */
describe('audience — the DEFAULT link is the one that still works tomorrow', () => {
  beforeEach(() => {
    reachable.add(FUNNEL);
    reachable.add(TUNNEL);
  });

  it('prefers the durable tailnet base over the ephemeral tunnel', async () => {
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect(await r.resolve({ probe: true })).toMatchObject({
      baseUrl: FUNNEL,
      durability: 'tailnet',
    });
  });

  it('inverts exactly that for a link meant to be SENT to someone', async () => {
    // Off the tailnet a `*.ts.net` name does not resolve to this machine at all,
    // so for a public link an address with a shelf life genuinely beats one with
    // no reach. The flag is the whole of the difference.
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect(await r.resolve({ probe: true, audience: 'public' })).toMatchObject({
      baseUrl: TUNNEL,
      durability: 'ephemeral',
    });
  });

  it('MUXPAD_PUBLIC_BASE_URL wins in BOTH audiences — a domain is both things', async () => {
    // The whole point of leaving env on top: the day a named tunnel exists on
    // pub.rows.to, it becomes the default with no further change, and `--public`
    // stops being a different answer because there is nothing private about it.
    const domain = 'https://artifacts.example.com';
    reachable.add(domain);
    const r = make({ configuredBaseUrl: domain, tunnelBaseUrl: () => TUNNEL });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    for (const audience of ['tailnet', 'public'] as const) {
      expect(await r.resolve({ probe: true, audience })).toMatchObject({
        baseUrl: domain,
        source: 'env',
        durability: 'permanent',
      });
    }
  });

  it('a human PIN outranks the durability rule too — configuration is not a guess', async () => {
    // Re-ranking applies to what muxpad DISCOVERED. `--set-base` is somebody
    // typing an answer, and its documented job is pointing every surface at a
    // tunnel they chose; sorting it below a tailnet address would silently
    // break that.
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    r.setPinned(TUNNEL);
    expect(await r.resolve({ probe: true })).toMatchObject({
      baseUrl: TUNNEL,
      source: 'pinned',
      durability: 'ephemeral',
    });
  });

  it('falls back to the tunnel when there is NO tailnet — no tailnet, no change', async () => {
    // A machine that is not on a tailnet must behave exactly as it did before:
    // the ephemeral link is the only one there is, and it is still better than
    // loopback.
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    expect(await r.resolve({ probe: true })).toMatchObject({
      baseUrl: TUNNEL,
      source: 'tunnel',
    });
  });

  it('and to the tailnet base when there is no tunnel', async () => {
    const r = make({ tunnelBaseUrl: () => null });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    // Even asking for a public link cannot invent one. It must not silently
    // hand back a private address as though it were shareable — see the note.
    const got = await r.resolve({ probe: true, audience: 'public' });
    expect(got).toMatchObject({ baseUrl: FUNNEL, durability: 'tailnet' });
  });

  it('keeps the source order WITHIN a durability class', async () => {
    // The re-rank is a stable sort, not a replacement: two tailnet candidates
    // still break their tie the way they always did (hint above persisted).
    const other = 'https://other-host.example-tailnet.ts.net:8443';
    reachable.add(other);
    const r = make();
    globals.set(PUBLIC_BASE_URL_KEY, other);
    const list = r.candidates({ hint: FUNNEL });
    expect(list.map((c) => c.source)).toEqual(['hint', 'persisted']);
  });

  it('candidates() reports the order it will actually be resolved in', async () => {
    // `muxpad publish --base` prints this table, and a table that disagreed with
    // the answer above it would be worse than no table.
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    expect(r.candidates().map((c) => c.durability)).toEqual(['tailnet', 'ephemeral']);
    expect(r.candidates({ audience: 'public' }).map((c) => c.durability)).toEqual([
      'ephemeral',
      'tailnet',
    ]);
  });

  it('a dead durable base still steps aside for a live ephemeral one', async () => {
    // Durability decides the ORDER; the probe still demotes the dead. A tailnet
    // base whose funnel mapping has gone away must not take publishing down
    // when there is a working tunnel sitting right behind it.
    const r = make({ tunnelBaseUrl: () => TUNNEL });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL);
    reachable.delete(FUNNEL);
    expect(await r.resolve({ probe: true })).toMatchObject({
      baseUrl: TUNNEL,
      source: 'tunnel',
    });
  });
});

describe('the note says what is true for the link just handed over', () => {
  it('names the tailnet limit plainly, and the flag that escapes it', () => {
    const note = durabilityNote('tailnet');
    expect(note).toContain('tailnet');
    // The old text hedged ("it reaches the public internet only if Funnel is
    // enabled…") because this was a reluctant fallback nobody had measured. It
    // is now the DEFAULT, so it has to be plain about both halves: it works on
    // your own devices, and it works nowhere else.
    expect(note).toContain('--public');
    expect(note).not.toContain('only if Funnel is enabled');
  });

  it('says a PUBLIC link was asked for and is not available', () => {
    // The failure that must never be silent: `--public` on a machine with no
    // tunnel would otherwise print a tailnet address and look like a share link.
    const note = durabilityNote('tailnet', 'public');
    expect(note).toContain('no public');
    expect(note).toContain('cannot open it');
  });

  it('keeps the ephemeral warning for the link that has a shelf life', () => {
    expect(durabilityNote('ephemeral')).toContain('quick tunnel');
    expect(durabilityNote('ephemeral')).toContain('muxpad publish --url');
  });

  it('says nothing about a real domain, in either audience', () => {
    expect(durabilityNote('permanent')).toBeNull();
    expect(durabilityNote('permanent', 'public')).toBeNull();
  });
});

/**
 * `reachable` used to be `null` for the winning tunnel, because the tunnel
 * branch returns before the probe. The REASON for that early return is sound and
 * unchanged (see public-base.ts): a probe can only ever demote a tunnel whose
 * liveness we already know by construction, and a false negative swaps a working
 * public link for a blocked :8443 one.
 *
 * But "do not RANK on it" was implemented as "do not MEASURE it", and those are
 * different. `muxpad publish --base` printed `reachable: not checked` for the one
 * candidate the user most wanted checked. So: probe it, report it, and still
 * return it regardless.
 */
describe('the tunnel is measured for reporting, never for ranking', () => {
  it('reports health for a tunnel that answers', async () => {
    const live = 'https://any-name.trycloudflare.com';
    const r = make({ tunnelBaseUrl: () => live });
    reachable.add(live);
    const got = await r.resolve({ probe: true });
    expect(got.source).toBe('tunnel');
    expect(got.health?.alive).toBe(true);
  });

  it('still returns the tunnel when the probe says dead — the whole point', async () => {
    const live = 'https://any-name.trycloudflare.com';
    const r = make({ tunnelBaseUrl: () => live });
    globals.set(PUBLIC_BASE_URL_KEY, FUNNEL); // a reachable alternative, deliberately
    // NOT in `reachable`: this machine's resolver NXDOMAINs the tunnel's own
    // hostname while Cloudflare's edge serves it 200. Observed live.
    // `audience: 'public'` for the same reason as the test above — that is where
    // a tunnel leads the list now.
    const got = await r.resolve({ probe: true, audience: 'public' });
    expect(got.baseUrl).toBe(live);
    expect(got.source).toBe('tunnel');
    expect(got.health?.alive).toBe(false);
  });

  it('does not probe the tunnel when probing was not asked for', async () => {
    let calls = 0;
    const live = 'https://any-name.trycloudflare.com';
    const r = createPublicBaseResolver({
      db,
      funnel,
      publicPort: 7778,
      tunnelBaseUrl: () => live,
      probe: async () => {
        calls += 1;
        return ALIVE;
      },
    });
    const got = await r.resolve();
    expect(got.baseUrl).toBe(live);
    expect(got.health).toBeNull();
    expect(calls).toBe(0);
  });
});
