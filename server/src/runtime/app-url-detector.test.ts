import type { AppUrl } from '@muxpad/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AppUrlDetector } from './app-url-detector.js';
import type { AppUrlTrackerDeps } from './app-url-tracker.js';

/**
 * Drive the detector with controllable deps (no real sockets/DNS): a set of
 * "self" hosts and a set of "listening" ports. `nextCallback()` resolves the
 * next time the detector surfaces a confirmed list — the confirm pass is
 * debounced (~400ms), so tests await this rather than sleeping a fixed time.
 */
function makeHarness(overrides: Partial<AppUrlTrackerDeps> = {}) {
  const selfHosts = new Set(['localhost', '127.0.0.1']);
  const listening = new Set<number>();
  const deps: AppUrlTrackerDeps = {
    isSelfHost: async (h) => selfHosts.has(h),
    probe: async (_h, port) => listening.has(port),
    toReachableUrl: async (u) => u,
    now: () => Date.now(),
    ...overrides,
  };
  const calls: Array<{ paneId: string; urls: AppUrl[] }> = [];
  let resolveNext: (() => void) | null = null;
  const detector = new AppUrlDetector(
    (paneId, urls) => {
      calls.push({ paneId, urls });
      resolveNext?.();
      resolveNext = null;
    },
    () => deps,
  );
  const nextCallback = () =>
    new Promise<void>((r) => {
      resolveNext = r;
    });
  return { detector, selfHosts, listening, calls, nextCallback };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AppUrlDetector', () => {
  let h: ReturnType<typeof makeHarness> | null = null;
  afterEach(() => {
    h?.detector.stop();
    h = null;
  });

  it('surfaces a listening self-host URL after a sighting', async () => {
    h = makeHarness();
    h.listening.add(5173);
    h.detector.ingest('p1', ['http://localhost:5173'], []);
    await h.nextCallback();
    expect(h.calls).toEqual([
      { paneId: 'p1', urls: [{ url: 'http://localhost:5173', label: null, source: 'text' }] },
    ]);
  });

  it('does NOT surface a URL whose port is not listening', async () => {
    h = makeHarness(); // nothing in `listening`
    h.detector.ingest('p1', ['http://localhost:59999'], []);
    // Wait well past the confirm debounce; the probe rejects it, so the list
    // stays empty and the onAppUrls callback never fires.
    await sleep(550);
    expect(h.calls).toEqual([]);
  });

  it('does NOT surface a non-self host even when its port is listening', async () => {
    h = makeHarness();
    h.listening.add(443);
    h.detector.ingest('p1', ['https://github.com/u/r'], []);
    await sleep(550);
    expect(h.calls).toEqual([]);
  });

  it('keeps per-pane trackers isolated', async () => {
    h = makeHarness();
    h.listening.add(3000);
    h.detector.ingest('paneA', ['http://localhost:3000'], []);
    await h.nextCallback();
    expect(h.calls.at(-1)).toEqual({
      paneId: 'paneA',
      urls: [{ url: 'http://localhost:3000', label: null, source: 'text' }],
    });
  });

  it('forget() stops a pane from surfacing further', async () => {
    h = makeHarness();
    h.listening.add(5173);
    h.detector.ingest('p1', ['http://localhost:5173'], []);
    h.detector.forget('p1'); // drop before the debounced confirm runs
    await sleep(550);
    expect(h.calls).toEqual([]);
  });
});
