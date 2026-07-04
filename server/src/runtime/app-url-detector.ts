import type { AppUrl } from '@muxpad/shared';
import { AppUrlTracker, type AppUrlTrackerDeps } from './app-url-tracker.js';
import { isSelfHost, probeListening, toReachableUrl } from './host-identity.js';
import type { AppUrlMarker } from './pty-scanner.js';

// First-surface latency: after a fresh sighting, wait this long before the
// (async) confirm pass so a server's boot burst of URLs coalesces into one.
const REFRESH_DEBOUNCE_MS = 400;
// Re-probe cadence: re-confirm every tracked pane so a server that has since
// died drops out of the dropdown and a late-binding one appears. Matches the
// old ptyd cmd-poll cadence the tracker used to ride on.
const REPROBE_INTERVAL_MS = 10_000;

/**
 * Server-side owner of app-url detection. ptyd extracts raw URL/marker
 * sightings from pane output and ships them over the control channel
 * (`paneUrlsSeen`); this is where they're judged — host classification + the
 * listening probe, one {@link AppUrlTracker} per pane — and the confirmed list
 * is handed back via `onAppUrls` whenever it changes.
 *
 * The whole point of living here rather than in ptyd: detection heuristics
 * (which host counts as local, how candidates are sorted/probed) change often,
 * and the main server restarts without dropping PTYs. ptyd stays dumb, so a
 * detection tweak is a server-only restart — never a terminal-killing bounce.
 */
export class AppUrlDetector {
  private trackers = new Map<string, AppUrlTracker>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private reprobe: NodeJS.Timeout | null = null;
  // Per-pane refresh serialization. A tracker's refresh() is async and
  // mutates shared state across awaits, and it can be triggered from both the
  // debounce and the 10s sweep — overlapping passes could drop a candidate
  // (the MAX_CANDIDATES reassign) or double-probe. `running` marks an in-flight
  // refresh; a request that arrives while one runs sets `rerun` so the latest
  // sightings still get confirmed once the current pass finishes.
  private running = new Set<string>();
  private rerun = new Set<string>();

  /**
   * @param onAppUrls  called with the confirmed list whenever a pane's set
   *   of listening apps changes (including back to empty).
   * @param makeDeps   tracker dependency factory; overridable for tests.
   */
  constructor(
    private readonly onAppUrls: (paneId: string, urls: AppUrl[]) => void,
    private readonly makeDeps: () => AppUrlTrackerDeps = defaultDeps,
  ) {
    this.reprobe = setInterval(() => void this.refreshAll(), REPROBE_INTERVAL_MS);
    this.reprobe.unref?.();
  }

  /** Record raw scanner sightings for a pane and schedule a confirm pass. */
  ingest(paneId: string, urls: string[], markers: AppUrlMarker[]): void {
    let tracker = this.trackers.get(paneId);
    if (!tracker) {
      tracker = new AppUrlTracker(this.makeDeps());
      this.trackers.set(paneId, tracker);
    }
    if (tracker.ingest({ urls, markers })) this.scheduleRefresh(paneId);
  }

  /** Drop a pane's tracker and any pending confirm (call on pane exit). */
  forget(paneId: string): void {
    const pending = this.debounce.get(paneId);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(paneId);
    }
    this.rerun.delete(paneId);
    // An in-flight refreshOne can't be cancelled, but deleting the tracker
    // makes its post-await membership re-check bail before calling onAppUrls,
    // so a forgotten pane can't resurrect a cache entry.
    this.trackers.delete(paneId);
  }

  /** Stop the re-probe timer and clear pending work (shutdown / tests). */
  stop(): void {
    if (this.reprobe) {
      clearInterval(this.reprobe);
      this.reprobe = null;
    }
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    this.rerun.clear();
  }

  private scheduleRefresh(paneId: string): void {
    if (this.debounce.has(paneId)) return; // a confirm is already queued
    const t = setTimeout(() => {
      this.debounce.delete(paneId);
      void this.refreshOne(paneId);
    }, REFRESH_DEBOUNCE_MS);
    t.unref?.();
    this.debounce.set(paneId, t);
  }

  private async refreshOne(paneId: string): Promise<void> {
    // Serialize per tracker: if a pass is already running for this pane, mark
    // it to re-run once and bail, so two passes never mutate one tracker's
    // state concurrently.
    if (this.running.has(paneId)) {
      this.rerun.add(paneId);
      return;
    }
    const tracker = this.trackers.get(paneId);
    if (!tracker) return;
    this.running.add(paneId);
    try {
      let changed: boolean;
      try {
        changed = await tracker.refresh();
      } catch {
        return; // a probe/lookup blip; the periodic re-probe will retry
      }
      // forget() may have run during the await — don't resurrect a dropped
      // pane's cache entry by calling back for it.
      if (this.trackers.get(paneId) !== tracker) return;
      if (changed) this.onAppUrls(paneId, tracker.list());
    } finally {
      this.running.delete(paneId);
      // A sighting/sweep arrived mid-pass — run once more to confirm it.
      if (this.rerun.delete(paneId) && this.trackers.has(paneId)) {
        void this.refreshOne(paneId);
      }
    }
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([...this.trackers.keys()].map((id) => this.refreshOne(id)));
  }
}

/** Real dependencies: same-machine host check, TCP probe, tailnet rewrite. */
function defaultDeps(): AppUrlTrackerDeps {
  return {
    isSelfHost: (host) => isSelfHost(host),
    probe: (host, port) => probeListening(host, port),
    toReachableUrl: (url) => toReachableUrl(url),
    now: () => Date.now(),
  };
}
