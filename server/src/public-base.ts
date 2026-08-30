import type { UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import type { Funnel } from './funnel.js';
import { GlobalsStore } from './store/GlobalsStore.js';
import { probeUrlHealth } from './url-health.js';

/**
 * Where a published artifact's PUBLIC url comes from — the single resolver.
 *
 * WHY THIS EXISTS
 * ---------------
 * There used to be two half-resolvers: POST /api/publish ran a tiered
 * hint→funnel→persisted chain, and GET /api/publish read the persisted global
 * directly. They agreed only by luck, and they inherited a worse problem: the
 * chain's top entry was whatever `tailscale funnel` reported, which is
 * `https://<host>.ts.net:8443`.
 *
 * PORT 8443 IS NOT REACHABLE FROM MANY NETWORKS. Tailscale Funnel offers
 * 443/8443/10000; muxpad picked 8443, and plenty of real networks (corporate,
 * mobile, guest wifi) block outbound to non-standard HTTPS ports. The artifact
 * loads for the person who published it — same machine, or a permissive
 * network — and 404s or hangs for the person they sent it to. A "share" link
 * that works for you and nobody else is worse than no link, because you cannot
 * tell the difference without a second device on a second network.
 *
 * So the base url is now CONFIGURATION with a fallback chain, not a discovery
 * result. A tunnel on standard :443 (Cloudflare, ngrok, a permanent domain in
 * front of the public port) is set once and every surface follows.
 *
 * PRECEDENCE, highest first — configuration beats discovery, always:
 *
 *   env       MUXPAD_PUBLIC_BASE_URL. Permanent, lives in the launchd plist,
 *             survives every database operation. This is where a real domain
 *             belongs once there is one.
 *   pinned    the `public_base_url_pinned` global, set by
 *             `muxpad publish --set-base`. For a tunnel whose URL is EPHEMERAL
 *             (a Cloudflare quick tunnel mints a new name on every restart):
 *             one command to re-point every surface, no deploy.
 *   hint      the `public_base_url` a publishing CLI discovered in its own
 *             shell. Below the pinned entry ON PURPOSE — this is the funnel
 *             url, and it is exactly what used to clobber a working base on
 *             the next publish.
 *   funnel    server-side `tailscale` discovery (dev / non-launchd only).
 *   persisted the `public_base_url` global, seeded by hint/funnel.
 *   local     the loopback url + a warning. Never shareable, and says so.
 *
 * NOTHING IS HARDCODED HERE. The current Cloudflare tunnel name is ephemeral
 * and appears nowhere in this file or any other — it is a value the user sets.
 *
 * ON THE HEALTH CHECK, AND ITS HONEST LIMIT
 * -----------------------------------------
 * Candidates are probed and a DEAD one is skipped. This genuinely catches the
 * common failure — a quick tunnel's process exits and its name stops
 * resolving — and it is cheap, because the public root deliberately 404s
 * (public-server.ts), so "answered at all" is a perfect liveness signal and
 * needs no special endpoint.
 *
 * What it CANNOT catch is the failure that motivated this file: the server
 * probes from the muxpad machine, where :8443 is reachable, so a funnel that
 * is blocked on the recipient's network probes healthy. No server-side check
 * can see a client-side block. That is precisely why ORDER is configuration
 * rather than measurement — the probe only demotes the dead, it never promotes
 * the unreachable.
 */

/** globals-KV key holding the last base a publish DISCOVERED (hint/funnel). */
export const PUBLIC_BASE_URL_KEY = 'public_base_url';

/** globals-KV key holding a base the USER pinned. Outranks discovery. */
export const PUBLIC_BASE_PINNED_KEY = 'public_base_url_pinned';

/** How long a candidate's reachability probe is reused. The Hosted view polls
 *  every 3s; probing a public tunnel that often would be rude and pointless. */
export const BASE_PROBE_TTL_MS = 30_000;

export type PublicBaseSource = 'env' | 'pinned' | 'hint' | 'funnel' | 'persisted' | 'local';

export interface PublicBase {
  /** Base to prefix slugs with, no trailing slash. */
  baseUrl: string;
  source: PublicBaseSource;
  /** Set when the answer is not known-public (local fallback, or nothing
   *  answered). Callers surface it verbatim. */
  warning?: string;
  /** Reachability of `baseUrl`, when probed. null = not probed. */
  health: UrlHealth | null;
}

/**
 * Validate + normalize a base-url candidate. Only well-formed http(s) origins
 * (optionally with a port) are accepted — no path, query, hash or credentials —
 * and the trailing slash is dropped so callers can append `/<slug>/` uniformly.
 * Returns null on anything else.
 *
 * http is allowed only for loopback: the local fallback needs it, and a plain
 * http PUBLIC base would hand out links that leak the artifact in transit.
 */
export function normalizeBaseUrl(hint: unknown): string | null {
  if (typeof hint !== 'string' || hint.length === 0 || hint.length > 512) return null;
  let url: URL;
  try {
    url = new URL(hint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null;
  return url.origin;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

export interface PublicBaseCandidate {
  url: string;
  source: PublicBaseSource;
}

export interface PublicBaseDeps {
  db: Database.Database;
  funnel: Funnel;
  publicPort: number;
  /** MUXPAD_PUBLIC_BASE_URL, already normalized (or absent). */
  configuredBaseUrl?: string | undefined;
  now?: () => number;
  /** Injectable for tests; defaults to the real server-side probe. */
  probe?: (url: string) => Promise<UrlHealth>;
  probeTtlMs?: number;
}

export interface PublicBaseResolver {
  /**
   * @param opts.hint            a base the calling CLI discovered (POST body).
   * @param opts.allowDiscovery  may exec `tailscale`. FALSE for read paths —
   *   the Hosted view polls, and shelling out per poll would be absurd (and
   *   under launchd it fails anyway).
   * @param opts.probe           check reachability and skip dead candidates.
   */
  resolve(opts?: {
    hint?: unknown;
    allowDiscovery?: boolean;
    probe?: boolean;
  }): Promise<PublicBase>;
  /** Pin a base (or clear the pin with null). */
  setPinned(url: string | null): void;
  /** The ordered candidate list, unprobed. Exposed for `--base` / diagnostics. */
  candidates(opts?: { hint?: unknown }): PublicBaseCandidate[];
}

export function createPublicBaseResolver(deps: PublicBaseDeps): PublicBaseResolver {
  const globals = new GlobalsStore(deps.db);
  const now = deps.now ?? (() => Date.now());
  const doProbe = deps.probe ?? ((url: string) => probeUrlHealth(url, { timeoutMs: 2500 }));
  const ttl = deps.probeTtlMs ?? BASE_PROBE_TTL_MS;
  const seen = new Map<string, { at: number; health: UrlHealth }>();

  const candidates = (opts?: { hint?: unknown }): PublicBaseCandidate[] => {
    const out: PublicBaseCandidate[] = [];
    const add = (raw: string | null | undefined, source: PublicBaseSource) => {
      const url = normalizeBaseUrl(raw);
      if (!url) return;
      if (out.some((c) => c.url === url)) return; // first source for a url wins
      out.push({ url, source });
    };
    add(deps.configuredBaseUrl, 'env');
    add(globals.get(PUBLIC_BASE_PINNED_KEY), 'pinned');
    add(typeof opts?.hint === 'string' ? opts.hint : null, 'hint');
    add(globals.get(PUBLIC_BASE_URL_KEY), 'persisted');
    return out;
  };

  const reach = async (url: string): Promise<UrlHealth> => {
    const hit = seen.get(url);
    const t = now();
    if (hit && t - hit.at < ttl) return hit.health;
    // The public root 404s by design, and a 404 classifies as ALIVE — the
    // server answered. That is exactly the signal wanted here, with no
    // dedicated health endpoint and nothing extra exposed.
    const health = await doProbe(`${url}/`);
    seen.set(url, { at: now(), health });
    return health;
  };

  const resolve = async (opts?: {
    hint?: unknown;
    allowDiscovery?: boolean;
    probe?: boolean;
  }): Promise<PublicBase> => {
    const list = candidates({ ...(opts?.hint !== undefined ? { hint: opts.hint } : {}) });

    // A hint is the caller telling us something we did not know — persist it so
    // headless/cron publishes keep working. It does NOT jump the queue: a
    // pinned or configured base still wins below.
    const hint = normalizeBaseUrl(opts?.hint);
    if (hint) globals.set(PUBLIC_BASE_URL_KEY, hint);

    // Server-side discovery is a LAST RESORT, not the first move — it runs only
    // when nothing is configured, pinned, hinted or persisted.
    //
    // This is the behaviour change that fixes the reported bug. Discovery used
    // to run FIRST on every publish and overwrite the persisted base with the
    // funnel's `:8443` url, so pinning a reachable base held only until the
    // next `muxpad publish`. Deferring it means a base, once known, stays put
    // until something explicitly changes it — and the CLI's hint still refreshes
    // the persisted value on every publish, so a genuinely moved funnel is not
    // stuck either.
    let discoveryWarning: string | undefined;
    // The funnel's OWN local url when it degrades. Preferred over rebuilding
    // one from `publicPort`: the funnel is the thing that actually knows which
    // port the public listener bound (an isolated instance overrides it), and
    // reconstructing it here silently produced a :7778 link on every instance
    // that had moved.
    let discoveredLocal: string | undefined;
    if (opts?.allowDiscovery && list.length === 0) {
      const discovered = await deps.funnel.ensure();
      if (discovered.warning) {
        discoveryWarning = discovered.warning;
        discoveredLocal = discovered.baseUrl;
      } else {
        const url = normalizeBaseUrl(discovered.baseUrl);
        if (url) {
          globals.set(PUBLIC_BASE_URL_KEY, url);
          list.push({ url, source: 'funnel' });
        }
      }
    }

    if (list.length === 0) {
      return {
        baseUrl: discoveredLocal ?? `http://127.0.0.1:${deps.publicPort}`,
        source: 'local',
        // The funnel's own explanation wins when there is one — it says what
        // actually went wrong, where ours only says what is missing.
        warning:
          discoveryWarning ??
          'no public base url configured — this link only works on this machine. Set one with `muxpad publish --set-base <https://…>`.',
        health: null,
      };
    }

    if (!opts?.probe) {
      const first = list[0] as PublicBaseCandidate;
      return { baseUrl: first.url, source: first.source, health: null };
    }

    // Probe in order and take the first that answers. Dead candidates are
    // SKIPPED, never reordered by latency — order is configuration.
    let firstHealth: UrlHealth | null = null;
    for (const c of list) {
      const health = await reach(c.url);
      firstHealth ??= health;
      if (health.alive) return { baseUrl: c.url, source: c.source, health };
    }
    // Nothing answered. Return the top candidate anyway — it is still the
    // user's stated intent, and a loopback url would be actively misleading —
    // but say so, because a link nobody can open is the failure this whole
    // module exists to stop shipping silently.
    const first = list[0] as PublicBaseCandidate;
    return {
      baseUrl: first.url,
      source: first.source,
      warning: `${first.url} is not answering — the tunnel may be down. The link may not work for anyone else.`,
      health: firstHealth,
    };
  };

  return {
    resolve,
    candidates,
    setPinned: (url) => {
      if (url === null) {
        deps.db.prepare('DELETE FROM globals WHERE key = ?').run(PUBLIC_BASE_PINNED_KEY);
        return;
      }
      const normalized = normalizeBaseUrl(url);
      if (!normalized) throw new Error('base must be a well-formed https origin');
      globals.set(PUBLIC_BASE_PINNED_KEY, normalized);
      // Drop the cached probe so the very next read reflects the new pin.
      seen.delete(normalized);
    },
  };
}
