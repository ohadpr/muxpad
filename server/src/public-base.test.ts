import type { UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Funnel } from './funnel.js';
import {
  PUBLIC_BASE_PINNED_KEY,
  PUBLIC_BASE_URL_KEY,
  type PublicBaseResolver,
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
