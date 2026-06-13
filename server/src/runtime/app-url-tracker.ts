import type { AppUrl } from '@muxpad/shared';
import type { AppUrlMarker } from './pty-scanner.js';

/**
 * Turns the scanner's raw detections into a confirmed, deduped, ordered list
 * of web apps a pane is serving. The scanner is deliberately dumb (it reports
 * every http(s) URL it sees); this is where the noise is filtered:
 *
 *   - host must be this machine (isSelfHost) — kills github/docs/registry URLs.
 *   - port must actually be listening (probe) — kills mentioned-but-not-served.
 *   - explicit markers outrank scraped text and never get auto-flipped to;
 *     they just sort first and carry a label.
 *
 * Both queues are bounded, candidates are capped + expired, and probes are
 * driven from refresh() (called on a debounce + the existing 10s poll) rather
 * than the hot output path — so this adds no per-byte work and no unbounded
 * growth. The human picks from the resulting dropdown, so the filter only has
 * to be quiet, never perfectly right.
 */
export interface AppUrlTrackerDeps {
  /** Does this host resolve to the machine ptyd runs on? */
  isSelfHost(host: string): Promise<boolean>;
  /** Is something listening on this host:port right now? */
  probe(host: string, port: number): Promise<boolean>;
  /** Rewrite a localhost URL to a viewer-reachable (tailnet) form. */
  toReachableUrl(rawUrl: string): Promise<string>;
  now(): number;
}

interface Candidate {
  host: string;
  port: number;
  rawUrl: string;
  displayUrl: string;
  label: string | null;
  source: 'marker' | 'text';
  lastSeen: number;
  listening: boolean;
}

// A candidate that stopped listening lingers this long (in case of a quick
// restart) before being dropped from the dropdown.
const NOT_LISTENING_GRACE_MS = 30_000;
// Caps. The pending queue guards against a burst of detections outrunning
// refresh(); the candidate map guards against a pane that prints many
// distinct local URLs. Both are far above any realistic real count.
const MAX_PENDING = 64;
const MAX_CANDIDATES = 16;

interface RawSeen {
  host: string;
  port: number;
  rawUrl: string;
  label: string | null;
  source: 'marker' | 'text';
}

export class AppUrlTracker {
  private candidates = new Map<string, Candidate>();
  private pending: RawSeen[] = [];
  private lastExposed = '[]';

  constructor(private readonly deps: AppUrlTrackerDeps) {}

  /**
   * Record raw scanner detections. Cheap + synchronous (runs on the PTY
   * output path): just parses host/port and queues. All async work —
   * self-host check, probe, rewrite — happens in refresh(). Returns true if
   * anything was queued (so the caller can schedule a refresh).
   */
  ingest(ev: { urls?: string[]; markers?: AppUrlMarker[] }): boolean {
    let queued = false;
    for (const m of ev.markers ?? []) {
      const seen = parse(m.url, 'marker', m.label ?? null);
      if (seen) {
        this.push(seen);
        queued = true;
      }
    }
    for (const raw of ev.urls ?? []) {
      const seen = parse(raw, 'text', null);
      if (seen) {
        this.push(seen);
        queued = true;
      }
    }
    return queued;
  }

  private push(seen: RawSeen): void {
    this.pending.push(seen);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /**
   * Drain queued detections, (re)probe known candidates, expire stale ones.
   * Returns true iff the exposed list() changed — the caller emits a
   * pane.updated only then.
   */
  async refresh(): Promise<boolean> {
    const now = this.deps.now();

    // Promote queued raw detections that pass the self-host gate.
    const drained = this.pending;
    this.pending = [];
    for (const seen of drained) {
      if (!(await this.deps.isSelfHost(seen.host))) continue;
      const key = `${seen.host}:${seen.port}`;
      const existing = this.candidates.get(key);
      if (existing) {
        existing.lastSeen = now;
        // A marker upgrades a text candidate (and refreshes its label);
        // a later text sighting never downgrades a marker.
        if (seen.source === 'marker') {
          existing.source = 'marker';
          existing.label = seen.label;
          existing.rawUrl = seen.rawUrl;
        }
      } else {
        this.candidates.set(key, {
          host: seen.host,
          port: seen.port,
          rawUrl: seen.rawUrl,
          displayUrl: seen.rawUrl,
          label: seen.label,
          source: seen.source,
          lastSeen: now,
          listening: false,
        });
      }
    }

    // Cap: keep the most-recently-seen candidates.
    if (this.candidates.size > MAX_CANDIDATES) {
      const sorted = [...this.candidates.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
      this.candidates = new Map(sorted.slice(0, MAX_CANDIDATES));
    }

    // Re-probe everything and refresh the reachable URL; expire dead ones.
    // Bump lastSeen while it's confirmed listening so the grace window below
    // measures "time since it stopped serving", not "time since its URL was
    // printed" — a server prints its URL once at boot but may run for hours.
    for (const [key, c] of [...this.candidates.entries()]) {
      c.listening = await this.deps.probe(c.host, c.port);
      if (c.listening) {
        c.lastSeen = now;
        c.displayUrl = await this.deps.toReachableUrl(c.rawUrl);
      } else if (now - c.lastSeen > NOT_LISTENING_GRACE_MS) {
        this.candidates.delete(key);
      }
    }

    const exposed = JSON.stringify(this.list());
    if (exposed === this.lastExposed) return false;
    this.lastExposed = exposed;
    return true;
  }

  /** Confirmed-listening apps, markers first then most-recently-seen. */
  list(): AppUrl[] {
    return [...this.candidates.values()]
      .filter((c) => c.listening)
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'marker' ? -1 : 1;
        return b.lastSeen - a.lastSeen;
      })
      .map((c) => ({ url: c.displayUrl, label: c.label, source: c.source }));
  }
}

/** Parse a URL into host/port, defaulting the port from the scheme. */
function parse(rawUrl: string, source: 'marker' | 'text', label: string | null): RawSeen | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, rawUrl, label, source };
}
