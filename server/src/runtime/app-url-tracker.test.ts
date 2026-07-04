import { beforeEach, describe, expect, it } from 'vitest';
import { AppUrlTracker, type AppUrlTrackerDeps } from './app-url-tracker.js';

/**
 * Deterministic deps: a controllable clock, a set of "self" hosts, a set of
 * "listening" ports, and a fixed tailnet rewrite. Lets us drive the tracker's
 * filter (self-host + listening), dedup, ordering, and expiry without sockets.
 */
function makeDeps(overrides: Partial<AppUrlTrackerDeps> = {}): {
  deps: AppUrlTrackerDeps;
  selfHosts: Set<string>;
  listening: Set<number>;
  setNow: (n: number) => void;
} {
  const selfHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
  const listening = new Set<number>();
  let clock = 1000;
  const deps: AppUrlTrackerDeps = {
    isSelfHost: async (host) => selfHosts.has(host),
    probe: async (_host, port) => listening.has(port),
    toReachableUrl: async (url) => url.replace('localhost', 'host.ts.net'),
    now: () => clock,
    ...overrides,
  };
  return { deps, selfHosts, listening, setNow: (n) => (clock = n) };
}

describe('AppUrlTracker', () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    h = makeDeps();
  });

  it('surfaces a self-host URL once its port is listening', async () => {
    const t = new AppUrlTracker(h.deps);
    h.listening.add(5173);
    t.ingest({ urls: ['http://localhost:5173'] });
    expect(await t.refresh()).toBe(true);
    expect(t.list()).toEqual([{ url: 'http://host.ts.net:5173', label: null, source: 'text' }]);
  });

  it('drops a non-self host (github-looking URL)', async () => {
    const t = new AppUrlTracker(h.deps);
    h.listening.add(443);
    t.ingest({ urls: ['https://github.com/u/r'] });
    expect(await t.refresh()).toBe(false);
    expect(t.list()).toEqual([]);
  });

  it('drops a self URL whose port is not listening', async () => {
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['http://localhost:3000'] }); // nothing listening on 3000
    expect(await t.refresh()).toBe(false);
    expect(t.list()).toEqual([]);
  });

  it('a tailnet self URL is accepted (host in identity set)', async () => {
    h.selfHosts.add('host.ts.net');
    h.listening.add(5173);
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['http://host.ts.net:5173'] });
    expect(await t.refresh()).toBe(true);
    expect(t.list()[0]!.url).toContain(':5173');
  });

  it('markers sort before scraped text and carry a label', async () => {
    h.listening.add(5173);
    h.listening.add(8787);
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['http://localhost:8787'] });
    t.ingest({ markers: [{ url: 'http://localhost:5173', label: 'Web' }] });
    await t.refresh();
    const list = t.list();
    expect(list[0]).toMatchObject({ source: 'marker', label: 'Web' });
    expect(list[1]).toMatchObject({ source: 'text' });
  });

  it('a marker upgrades a previously-scraped candidate on the same port', async () => {
    h.listening.add(5173);
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['http://localhost:5173'] });
    await t.refresh();
    expect(t.list()[0]!.source).toBe('text');
    t.ingest({ markers: [{ url: 'http://localhost:5173', label: 'Web' }] });
    await t.refresh();
    expect(t.list()).toHaveLength(1);
    expect(t.list()[0]).toMatchObject({ source: 'marker', label: 'Web' });
  });

  it('dedups repeated sightings of the same host:port', async () => {
    h.listening.add(5173);
    const t = new AppUrlTracker(h.deps);
    for (let i = 0; i < 10; i++) t.ingest({ urls: ['http://localhost:5173'] });
    await t.refresh();
    expect(t.list()).toHaveLength(1);
  });

  it('lingers in grace on a quick restart, then drops once aged out', async () => {
    h.listening.add(5173);
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['http://localhost:5173'] });
    await t.refresh();
    expect(t.list()).toHaveLength(1);

    // Server dies; within the grace window it's not listed but still tracked.
    h.listening.delete(5173);
    h.setNow(1000 + 5_000);
    expect(await t.refresh()).toBe(true); // list went 1 → 0
    expect(t.list()).toEqual([]);

    // Comes back within grace → re-listed without a fresh sighting (the
    // candidate was retained), proving the quick-restart grace works.
    h.listening.add(5173);
    h.setNow(1000 + 10_000);
    expect(await t.refresh()).toBe(true);
    expect(t.list()).toHaveLength(1);

    // Dies again and ages out past the grace window → dropped entirely, and
    // a later re-listen does NOT resurrect it (no candidate left to probe).
    h.listening.delete(5173);
    h.setNow(1000 + 10_000 + 40_000);
    await t.refresh();
    expect(t.list()).toEqual([]);
    h.listening.add(5173);
    expect(await t.refresh()).toBe(false);
    expect(t.list()).toEqual([]);
  });

  it('refresh() returns false when the exposed list is unchanged', async () => {
    h.listening.add(5173);
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['http://localhost:5173'] });
    expect(await t.refresh()).toBe(true);
    expect(await t.refresh()).toBe(false); // same list, no churn
  });

  it('ignores unparseable and non-http URLs', async () => {
    const t = new AppUrlTracker(h.deps);
    t.ingest({ urls: ['not a url', 'ftp://localhost:21', 'file:///etc/passwd'] });
    expect(await t.refresh()).toBe(false);
    expect(t.list()).toEqual([]);
  });

  it('sorts a reachable host ahead of a loopback one (same server, both shown)', async () => {
    // A dev server that prints both its localhost and its LAN/VPN URL should
    // surface both; the externally-reachable one is the more useful default.
    const local = makeDeps({ toReachableUrl: async (u) => u }); // no rewrite
    local.selfHosts.add('10.0.0.9');
    local.listening.add(5173);
    const t = new AppUrlTracker(local.deps);
    t.ingest({ urls: ['http://localhost:5173', 'http://10.0.0.9:5173'] });
    await t.refresh();
    expect(t.list().map((u) => u.url)).toEqual([
      'http://10.0.0.9:5173',
      'http://localhost:5173',
    ]);
  });
});
