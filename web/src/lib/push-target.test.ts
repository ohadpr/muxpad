import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUSH_TARGET_TTL_MS,
  type PushTarget,
  type PushTargetDeps,
  alreadyApplied,
  applyPushTarget,
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
    expect(calls).toEqual(['path:/']);
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
