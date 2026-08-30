import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUSH_TARGET_TTL_MS,
  type PushTarget,
  type PushTargetDeps,
  alreadyApplied,
  applyPushTarget,
  createPushTargetSink,
  isFresh,
  parsePushTarget,
  resetAppliedPushTargets,
  routeFromDeepLink,
} from './push-target';

function target(over: Partial<PushTarget> = {}): PushTarget {
  return {
    id: 'tap-1',
    url: '/w/dev/t/tab-slug?ptab=T1&pane=P1',
    tab_id: 'T1',
    pane_id: 'P1',
    ts: 1_000,
    ...over,
  };
}

function spyDeps() {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const deps: PushTargetDeps = {
    navigateToTab: (r) => calls.push(`nav:${r.wsSlug}/${r.tabSlug}#${r.paneId ?? '-'}`),
    navigateToPath: (p) => calls.push(`path:${p}`),
    rememberPane: (t, p) => calls.push(`remember:${t}/${p}`),
    forceFocusPane: (t, p) => calls.push(`force:${t}/${p}`),
    showPane: (p) => calls.push(`show:${p}`),
    schedule: (fn) => pending.push(fn),
  };
  /** Run every scheduled callback, repeatedly, like a fast-forwarded timer. */
  const flush = () => {
    for (let i = 0; i < 50 && pending.length; i++) {
      const next = pending.shift();
      next?.();
    }
  };
  return { deps, calls, flush };
}

beforeEach(() => resetAppliedPushTargets());

describe('parsePushTarget', () => {
  it('accepts the service worker message shape', () => {
    expect(
      parsePushTarget({
        type: 'muxpad:push-navigate',
        id: 'tap-9',
        url: '/w/a/t/b',
        tab_id: 'T',
        pane_id: 'P',
        ts: 5,
      }),
    ).toEqual({ id: 'tap-9', url: '/w/a/t/b', tab_id: 'T', pane_id: 'P', ts: 5 });
  });

  it('rejects anything without a url — there is nowhere to go', () => {
    expect(parsePushTarget(null)).toBeNull();
    expect(parsePushTarget('/w/a/t/b')).toBeNull();
    expect(parsePushTarget({ tab_id: 'T', pane_id: 'P' })).toBeNull();
    expect(parsePushTarget({ url: '' })).toBeNull();
  });

  it('normalises missing/garbage ids and hints instead of dropping the tap', () => {
    const t = parsePushTarget({ url: '/x', tab_id: 42, pane_id: '', ts: Number.NaN });
    expect(t).toEqual({ id: '/x:0', url: '/x', tab_id: null, pane_id: null, ts: 0 });
  });
});

describe('isFresh', () => {
  it('honours a recent tap and drops an archaeological one', () => {
    expect(isFresh(target({ ts: 1_000 }), 1_000 + PUSH_TARGET_TTL_MS - 1)).toBe(true);
    expect(isFresh(target({ ts: 1_000 }), 1_000 + PUSH_TARGET_TTL_MS + 1)).toBe(false);
  });

  it('trusts a target that carries no timestamp', () => {
    expect(isFresh(target({ ts: 0 }), 9_999_999)).toBe(true);
  });

  it('drops one from a wildly future clock (device clock jump)', () => {
    expect(isFresh(target({ ts: 10_000_000 }), 1_000)).toBe(false);
  });
});

describe('routeFromDeepLink', () => {
  it('pulls workspace + tab out of a payload url', () => {
    expect(routeFromDeepLink('/w/dev/t/muxpad?ptab=T&pane=P')).toEqual({
      wsSlug: 'dev',
      tabSlug: 'muxpad',
    });
  });

  it('decodes percent-escaped slugs (the server encodes them)', () => {
    expect(routeFromDeepLink('/w/my%20ws/t/a%2Fb')).toEqual({ wsSlug: 'my ws', tabSlug: 'a/b' });
  });

  it('survives a malformed escape rather than throwing mid-tap', () => {
    expect(routeFromDeepLink('/w/a/t/%E0%A4%A')).toEqual({ wsSlug: 'a', tabSlug: '%E0%A4%A' });
  });

  it('returns null for anything that is not a tab deep link', () => {
    expect(routeFromDeepLink('/')).toBeNull();
    expect(routeFromDeepLink('/w/dev')).toBeNull();
    expect(routeFromDeepLink('/p/pane-1')).toBeNull();
  });
});

describe('applyPushTarget', () => {
  it('routes to the owning tab AND points it at the pane, every channel', () => {
    const { deps, calls, flush } = spyDeps();
    expect(applyPushTarget(target(), deps)).toBe(true);
    // Seeds before navigating: a TabView that mounts as a RESULT of the
    // navigation must already find the target waiting for it.
    expect(calls.slice(0, 3)).toEqual(['remember:T1/P1', 'force:T1/P1', 'nav:dev/tab-slug#P1']);
    flush();
    // An already-mounted tab with a different active pane ignores ?pane, so
    // show-pane is re-broadcast until something takes.
    expect(calls.filter((c) => c === 'show:P1').length).toBeGreaterThan(1);
  });

  it('applies a tap exactly once, however many channels deliver it', () => {
    // The SW postMessages AND writes the cache dead-drop for the same tap.
    // Applying twice would re-navigate after the user moved on.
    const { deps, calls } = spyDeps();
    expect(applyPushTarget(target(), deps)).toBe(true);
    const after = calls.length;
    expect(applyPushTarget(target(), deps)).toBe(false);
    expect(calls.length).toBe(after);
    expect(alreadyApplied('tap-1')).toBe(true);
  });

  it('treats a LATER tap on the same pane as a new target', () => {
    // Notifications collapse on the pane id; the tap must follow the newest.
    const { deps, calls } = spyDeps();
    applyPushTarget(target({ id: 'P1:100' }), deps);
    applyPushTarget(
      target({ id: 'P1:200', url: '/w/dev/t/other', tab_id: 'T2', pane_id: 'P2' }),
      deps,
    );
    expect(calls).toContain('nav:dev/other#P2');
    expect(calls).toContain('force:T2/P2');
  });

  it('falls back to a plain path push when the url is not a tab deep link', () => {
    const { deps, calls } = spyDeps();
    applyPushTarget(target({ url: '/?x=1', tab_id: null, pane_id: null }), deps);
    expect(calls).toEqual(['path:/?x=1']);
  });

  it('keeps the query on a non-tab deep link — it is the destination', () => {
    // `/hosted/a/<slug>?logs=true` is where an app-server notification points,
    // and `?logs=true` is the half that opens the terminal that explains the
    // failure. Stripping it landed the user on the app's web view instead.
    const { deps, calls } = spyDeps();
    applyPushTarget(
      target({ url: '/hosted/a/notes?logs=true', tab_id: null, pane_id: null }),
      deps,
    );
    expect(calls).toEqual(['path:/hosted/a/notes?logs=true']);
  });

  it('does NOT burn the tap id when routing throws', () => {
    // A swallowed id would make the service worker's forced reload — the only
    // remaining recovery — land on the current page instead of the target.
    const { deps } = spyDeps();
    const boom: PushTargetDeps = {
      ...deps,
      navigateToTab: () => {
        throw new Error('router not mounted');
      },
    };
    expect(() => applyPushTarget(target(), boom)).toThrow('router not mounted');
    expect(alreadyApplied('tap-1')).toBe(false);
    // …and the retry through a healthy path still works.
    const retry = spyDeps();
    expect(applyPushTarget(target(), retry.deps)).toBe(true);
    expect(retry.calls).toContain('nav:dev/tab-slug#P1');
  });
});

describe('createPushTargetSink', () => {
  it('HOLDS a tap that arrives before the router is mounted, then applies it', () => {
    // The boot drain of the service worker's dead-drop resolves inside the
    // window between root.render() and React's first commit. Routing there is
    // a no-op, which is precisely "the app came forward on the wrong pane".
    const { deps, calls } = spyDeps();
    const sink = createPushTargetSink(deps);
    expect(sink.deliver(target())).toBe('held');
    expect(calls).toEqual([]);
    sink.ready();
    expect(calls.slice(0, 3)).toEqual(['remember:T1/P1', 'force:T1/P1', 'nav:dev/tab-slug#P1']);
  });

  it('applies immediately once ready, and ready() is idempotent', () => {
    const { deps, calls } = spyDeps();
    const sink = createPushTargetSink(deps);
    sink.ready();
    sink.ready();
    expect(calls).toEqual([]);
    expect(sink.deliver(target())).toBe('applied');
    expect(calls).toContain('nav:dev/tab-slug#P1');
    sink.ready(); // must not replay
    expect(calls.filter((c) => c.startsWith('nav:')).length).toBe(1);
  });

  it('applies only the MOST RECENT of several taps held at once', () => {
    // Notifications stack (or collapse under one tag) while the app is away.
    // Two navigations in a row means the first was never seen; the user tapped
    // the second one because that is the pane they care about.
    const { deps, calls } = spyDeps();
    const sink = createPushTargetSink(deps);
    sink.deliver(target({ id: 'tap-a', url: '/w/dev/t/one', tab_id: 'T1', pane_id: 'P1' }));
    sink.deliver(target({ id: 'tap-b', url: '/w/dev/t/two', tab_id: 'T2', pane_id: 'P2' }));
    expect(sink.held()?.id).toBe('tap-b');
    sink.ready();
    expect(calls.filter((c) => c.startsWith('nav:'))).toEqual(['nav:dev/two#P2']);
    // The superseded tap is retired, so its dead-drop twin can't resurrect it
    // and yank the user back a moment later.
    expect(alreadyApplied('tap-a')).toBe(true);
    sink.deliver(target({ id: 'tap-a', url: '/w/dev/t/one', tab_id: 'T1', pane_id: 'P1' }));
    expect(calls.filter((c) => c.startsWith('nav:'))).toEqual(['nav:dev/two#P2']);
  });

  it('reports a duplicate rather than re-routing (both channels deliver one tap)', () => {
    const { deps } = spyDeps();
    const sink = createPushTargetSink(deps);
    sink.ready();
    expect(sink.deliver(target())).toBe('applied');
    expect(sink.deliver(target())).toBe('duplicate');
  });

  it('holds across the whole boot, not just the first tap', () => {
    // A held tap must survive an intervening duplicate delivery of itself
    // (postMessage + dead-drop for the SAME tap, both pre-mount).
    const { deps, calls } = spyDeps();
    const sink = createPushTargetSink(deps);
    expect(sink.deliver(target())).toBe('held');
    expect(sink.deliver(target())).toBe('held');
    sink.ready();
    expect(calls.filter((c) => c.startsWith('nav:')).length).toBe(1);
  });

  it('still navigates when the payload carries no pane hint', () => {
    const { deps, calls, flush } = spyDeps();
    applyPushTarget(target({ tab_id: null, pane_id: null }), deps);
    flush();
    expect(calls).toEqual(['nav:dev/tab-slug#-']);
  });
});

describe('takeStoredPushTarget', () => {
  it('reads, CLEARS, and TTL-filters the service worker dead-drop', async () => {
    const del = vi.fn(async () => true);
    const entry = { json: async () => ({ id: 'tap-7', url: '/w/a/t/b', ts: 1_000 }) };
    vi.stubGlobal('caches', {
      open: async () => ({ match: async () => entry, delete: del }),
    });
    const { takeStoredPushTarget } = await import('./push-target');

    // Clearing on READ is what stops a ten-minute-old tap from yanking the
    // user back the next time they foreground the app.
    expect(await takeStoredPushTarget(1_500)).toMatchObject({ id: 'tap-7' });
    expect(del).toHaveBeenCalledTimes(1);
    expect(await takeStoredPushTarget(1_000 + PUSH_TARGET_TTL_MS + 1)).toBeNull();
    expect(del).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('is silent when Cache Storage is missing or throws', async () => {
    vi.stubGlobal('caches', undefined);
    const { takeStoredPushTarget } = await import('./push-target');
    expect(await takeStoredPushTarget()).toBeNull();
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('nope');
      },
    });
    expect(await takeStoredPushTarget()).toBeNull();
    vi.unstubAllGlobals();
  });
});
