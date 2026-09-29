import type { UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { FUNNEL_PORT, type Funnel } from './funnel.js';
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
 *   tunnel    the hostname of the cloudflare quick tunnel MUXPAD ITSELF owns
 *             and supervises (tunnel/TunnelApp.ts). Below `pinned` because a
 *             human who named a base outranks one muxpad minted for itself;
 *             above `hint` because `hint` IS the funnel url, and letting it
 *             outrank a live tunnel is the clobber this file was written to
 *             stop. Gated on the tunnel process still owning it — a dead
 *             tunnel's name is never offered as a candidate.
 *   hint      the `public_base_url` a publishing CLI discovered in its own
 *             shell. Below the pinned entry ON PURPOSE — this is the funnel
 *             url, and it is exactly what used to clobber a working base on
 *             the next publish.
 *   tailnet   this machine's own tailnet name, worked out with NO exec at all —
 *             its 100.64/10 address reverse-resolved through MagicDNS
 *             (tailnet-hostname.ts). Above `funnel` because it costs nothing:
 *             Tailscale here is a Mac App Store install whose only binary is
 *             inside the sandboxed app bundle, so every `funnel`/`status` exec
 *             raises a macOS "access data from other apps" prompt. Same answer,
 *             no dialog.
 *   funnel    server-side `tailscale` discovery. Now genuinely last-resort: it
 *             is the only tier that can CREATE a Funnel mapping, and the only
 *             one that costs a prompt.
 *   persisted the `public_base_url` global, seeded by hint/tailnet/funnel.
 *   local     the loopback url + a warning. Never shareable, and says so.
 *
 * NOTHING IS HARDCODED HERE. The current Cloudflare tunnel name is ephemeral
 * and appears nowhere in this file or any other — it is a value muxpad's own
 * tunnel supervisor writes at runtime, or that the user sets by hand.
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
 *
 * AND WHAT NO PROBE CAN EVER CATCH — see {@link BaseDurability}
 * -------------------------------------------------------------
 * The probe answers "does this answer NOW". The failure that actually kills
 * published links answers YES to that, right up until it doesn't: a Cloudflare
 * quick tunnel is perfectly healthy for days and then, at one restart, its
 * hostname is reassigned and every link ever built from it is dead forever.
 * Measured here on 2026-09-27: one ptyd restart took out nine days of links.
 *
 * Health and durability are therefore BOTH carried on every answer, because
 * they fail independently and a caller that knows only the first will keep
 * handing out links with a shelf life and calling them permanent.
 *
 * THE ORDER IS NOT SORTED BY DURABILITY, deliberately. The durable candidate on
 * this machine is the `*.ts.net` funnel url, and it is tailnet-only (verified:
 * Funnel is off, so :8443 hangs the TLS handshake from off-tailnet). Promoting
 * it would trade a link that works everywhere for a week for one that works
 * nowhere but here, forever. A base that is durable AND public has to be
 * CONFIGURED — a named tunnel or a domain in MUXPAD_PUBLIC_BASE_URL — which is
 * why `env` has always been the top rung. Until then the honest move is to keep
 * serving the ephemeral link and SAY that it is ephemeral.
 */

/** globals-KV key holding the last base a publish DISCOVERED (hint/funnel). */
export const PUBLIC_BASE_URL_KEY = 'public_base_url';

/** globals-KV key holding a base the USER pinned. Outranks discovery. */
export const PUBLIC_BASE_PINNED_KEY = 'public_base_url_pinned';

/**
 * globals-KV key holding WHEN discovery was last attempted (ms epoch), whether
 * or not it worked.
 *
 * THE ATTEMPT, NOT THE RESULT — and that is the whole point. A successful
 * discovery persists its base under PUBLIC_BASE_URL_KEY, so the
 * `list.length === 0` gate below already stops it repeating. A FAILED one
 * persists nothing, so the gate never closed and the exec ran again on the very
 * next publish. On a Mac with no `tailscale` on PATH every one of those execs
 * reaches into /Applications/Tailscale.app (see tailscale-bin.ts) and macOS puts
 * up "node would like to access data from other apps" — the reported symptom,
 * about five times a day.
 *
 * Remembering the attempt closes that. It is deliberately NOT in-process
 * memory: the CLI asking `discovery_needed` is a different process every time,
 * and the whole point is that it stops asking.
 */
export const TAILSCALE_DISCOVERY_KEY = 'tailscale_discovery_attempted_at';

/**
 * How long a failed discovery is taken at its word before anything tries again.
 *
 * Long, because the thing being discovered does not change: a machine's tailnet
 * name is stable for its whole life, so a repeat attempt has nothing new to
 * learn — it only costs another modal. Not INFINITE, because "I just logged into
 * Tailscale" has to become true eventually without reading source code to find
 * out how. Six hours is one working day's worth of at most one prompt, and a
 * daemon restart clears the wait too (funnel.ts's own cache is per-process).
 *
 * The immediate escape hatch, which the local-fallback warning already names,
 * is `muxpad publish --set-base <url>` — configuration outranks discovery, so
 * pinning makes the question moot rather than answering it faster.
 */
export const DISCOVERY_RETRY_TTL_MS = 6 * 60 * 60 * 1000;

/** How long a candidate's reachability probe is reused. The Hosted view polls
 *  every 3s; probing a public tunnel that often would be rude and pointless. */
export const BASE_PROBE_TTL_MS = 30_000;

export type PublicBaseSource =
  | 'env'
  | 'pinned'
  | 'tunnel'
  | 'hint'
  | 'tailnet'
  | 'funnel'
  | 'persisted'
  | 'local';

/**
 * HOW LONG THE ADDRESS LIVES — a different question from `health`, and the one
 * this module had no answer for.
 *
 * `health` asks "does this answer right now". Durability asks "will a link built
 * from this still work tomorrow". A quick tunnel scores perfectly on the first
 * and catastrophically on the second, and because only the first was ever
 * measured, `muxpad publish` printed nine days of links with a shelf life and
 * said nothing.
 *
 * The measured incident: every artifact published 2026-09-19 → 2026-09-27 was
 * printed under `search-particle-rules-ten.trycloudflare.com`. At 19:45 on the
 * 27th ptyd restarted (a deploy — not a crash; that cloudflared had run eight
 * days and exited zero times), serve-supervisor.ts rebuilt the tunnel pane,
 * tunnel/run.ts spawned a fresh cloudflared, and Cloudflare minted a new random
 * name. The old one went NXDOMAIN, permanently and at once. The bytes never
 * moved — all 150 artifacts are still on disk and still served. Only the ADDRESS
 * rotted, and every link anyone had been given rotted with it.
 *
 *   permanent  a real domain. Outlives restarts, reboots, reinstalls.
 *   ephemeral  a Cloudflare QUICK tunnel. Dies at the next tunnel restart,
 *              taking every link ever built from it. This is the defect.
 *   tailnet    a `*.ts.net` name. Durable — but reachable only from a device on
 *              the tailnet, so it is not a shareable public link. Verified
 *              2026-09-28: Tailscale Funnel is NOT enabled on this node, so
 *              :8443 accepts TCP at Tailscale's shared ingress and then hangs
 *              the TLS handshake for anyone off-tailnet.
 *   local      loopback. Already warned about separately.
 *
 * DERIVED FROM THE HOST, NEVER FROM THE SOURCE. A quick-tunnel name a human
 * pinned by hand rots exactly as fast as one muxpad minted for itself — which is
 * the 2026-08-30 incident, where a hand-pinned
 * `part-anonymous-brilliant-resume.trycloudflare.com` outlived its process by
 * nineteen days while every surface reported it as the public base.
 */
export type BaseDurability = 'permanent' | 'ephemeral' | 'tailnet' | 'local';

export function baseDurability(url: string, source: PublicBaseSource): BaseDurability {
  if (source === 'local') return 'local';
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'permanent';
  }
  if (isLoopbackHost(host)) return 'local';
  // Suffix-with-a-dot, never a substring: `trycloudflare.com.evil.test` and
  // `notts.net` are neither.
  if (host.endsWith('.trycloudflare.com')) return 'ephemeral';
  if (host.endsWith('.ts.net')) return 'tailnet';
  return 'permanent';
}

/**
 * The one line a human needs when the base they were just handed will not keep,
 * or null when it will. Written here rather than in the CLI because three
 * surfaces print it (publish output, `--base`, the Hosted view) and they must
 * not drift.
 */
export function durabilityNote(d: BaseDurability): string | null {
  if (d === 'ephemeral')
    return 'this is a Cloudflare quick tunnel — its hostname is randomly reassigned every time the tunnel restarts, and every link built from it dies at that moment. `muxpad publish --url <slug>` reprints a live link for an artifact whose link has gone dead.';
  if (d === 'tailnet')
    // Deliberately hedged rather than flat. Whether a `*.ts.net:8443` address
    // answers the public internet depends on Tailscale FUNNEL being enabled for
    // this node, and the only way to know that server-side is to exec the
    // Tailscale CLI — which on this machine lives inside the app bundle and
    // costs a macOS "access data from other apps" prompt (see tailscale-bin.ts).
    // Measured here on 2026-09-28, Funnel is OFF: the shared ingress accepts the
    // TCP connection and then never completes the TLS handshake for anyone
    // off-tailnet, so the link looks fine from the machine that published it and
    // hangs for everybody else. That is precisely the failure that must not be
    // asserted either way without checking.
    return 'this is a Tailscale address on :8443 — it reaches the public internet only if Funnel is enabled for this node, and :8443 is blocked outbound on many networks even then. Open it from a device that is NOT on your tailnet before sharing it.';
  return null;
}

export interface PublicBase {
  /** Base to prefix slugs with, no trailing slash. */
  baseUrl: string;
  source: PublicBaseSource;
  /** Set when the answer is not known-public (local fallback, or nothing
   *  answered). Callers surface it verbatim. */
  warning?: string;
  /** Reachability of `baseUrl`, when probed. null = not probed. */
  health: UrlHealth | null;
  /** Whether a link built from `baseUrl` will still work tomorrow. */
  durability: BaseDurability;
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
  /** Carried per-candidate so `muxpad publish --base` can show, in one table,
   *  that the winner is ephemeral and the runner-up is tailnet-only. */
  durability: BaseDurability;
}

export interface PublicBaseDeps {
  db: Database.Database;
  funnel: Funnel;
  publicPort: number;
  /** MUXPAD_PUBLIC_BASE_URL, already normalized (or absent). */
  configuredBaseUrl?: string | undefined;
  /**
   * The base of the tunnel muxpad is currently supervising, or null.
   *
   * A FUNCTION, not a value, and deliberately not a globals read done here:
   * "is this url still live" is a question about an app row and its pane, and
   * this module must not learn what an app is. tunnel/TunnelApp.ts owns that
   * rule; this file only knows where the answer goes in the order.
   */
  tunnelBaseUrl?: () => string | null;
  /** A one-line explanation of a tunnel that keeps failing, or null. */
  tunnelWarning?: () => string | null;
  /**
   * This machine's tailnet FQDN worked out WITHOUT execing tailscale, or null.
   * Tried before `funnel.ensure()` because it is the same answer for no prompt.
   *
   * DEFAULTS TO OFF (`async () => null`), exactly like `funnel` defaults to
   * localFunnel in server.ts: nothing a test constructs may touch the network
   * unless it said so. The real lookup (tailnet-hostname.ts) is wired in ONE
   * place — index.ts — and only when the funnel is enabled, since the url this
   * tier produces is a funnel url and means nothing without one.
   *
   * Learned the hard way: defaulting this to the live lookup broke six route
   * tests on a machine that happens to be on a tailnet, and would have passed
   * on any machine that is not.
   */
  tailnetHostname?: () => Promise<string | null>;
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
  /**
   * Would a `resolve({ allowDiscovery: true })` actually shell out right now?
   *
   * A PURE READ — asking must never exec and must never claim the
   * once-per-TTL slot, because the Hosted view polls the route that exposes
   * this every 3s and would otherwise eat the CLI's only attempt.
   *
   * This exists for the CLI. Server-side discovery cannot work under launchd,
   * so the real attempt happens in a pane shell — and the CLI has no way to
   * know whether its hint is wanted without asking. Before this it just always
   * execed, paying a macOS prompt to re-discover a base the server already had
   * (and, on this machine, one the resolver then ranks BELOW the live tunnel
   * and discards).
   */
  discoveryNeeded(): boolean;
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
      out.push({ url, source, durability: baseDurability(url, source) });
    };
    add(deps.configuredBaseUrl, 'env');
    add(globals.get(PUBLIC_BASE_PINNED_KEY), 'pinned');
    add(deps.tunnelBaseUrl?.() ?? null, 'tunnel');
    add(typeof opts?.hint === 'string' ? opts.hint : null, 'hint');
    add(globals.get(PUBLIC_BASE_URL_KEY), 'persisted');
    return out;
  };

  /** True while a failed attempt is still inside DISCOVERY_RETRY_TTL_MS. */
  const attemptIsFresh = (): boolean => {
    const at = Number(globals.get(TAILSCALE_DISCOVERY_KEY));
    if (!Number.isFinite(at) || at <= 0) return false;
    // A clock that has gone BACKWARDS (restore, NTP step) would otherwise make
    // a stamp from "the future" fresh forever, permanently disabling discovery.
    const age = now() - at;
    return age >= 0 && age < DISCOVERY_RETRY_TTL_MS;
  };

  const discoveryNeeded = (): boolean => candidates().length === 0 && !attemptIsFresh();

  /**
   * The no-exec tailnet base, or null. Never throws — a failure here must fall
   * through to the funnel tier, not fail the publish.
   */
  const tailnetBase = async (): Promise<string | null> => {
    const resolve = deps.tailnetHostname ?? (async () => null);
    try {
      const host = await resolve();
      return host ? `https://${host}:${FUNNEL_PORT}` : null;
    } catch {
      return null;
    }
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
      // FREE TIER FIRST, and free in the sense that matters: this machine's
      // tailnet name comes from its own 100.64/10 address reverse-resolved
      // through MagicDNS (tailnet-hostname.ts). Same answer as `tailscale status
      // --json`, no exec, no macOS prompt — and it works under launchd, where
      // the app-bundle CLI refuses to run at all.
      //
      // UNRATIONED, deliberately. The retry TTL below exists to stop a costly
      // attempt repeating; this one costs nothing, so gating it would only mean
      // a machine that has just joined a tailnet fails to notice for six hours.
      const viaTailnet = normalizeBaseUrl(await tailnetBase());
      if (viaTailnet) {
        globals.set(PUBLIC_BASE_URL_KEY, viaTailnet);
        list.push({
          url: viaTailnet,
          source: 'tailnet',
          durability: baseDurability(viaTailnet, 'tailnet'),
        });
      } else if (!attemptIsFresh()) {
        // Only now is an exec worth its cost — and it is the ONLY tier that can
        // CREATE a Funnel mapping rather than merely name one.
        //
        // `!attemptIsFresh()` is the second half of the gate that was missing.
        // `list.length === 0` alone only suppressed a repeat after discovery
        // SUCCEEDED (success is what puts a candidate in the list); a failing
        // tailscale left the list empty and got re-execed by every subsequent
        // publish, forever, each one a macOS prompt.
        //
        // Stamped BEFORE the exec, not after: an attempt that hangs, throws
        // outside ensure()'s own catch, or takes the process down with it still
        // counts as having been made. Recording it only on the way out would
        // reopen exactly the loop this is here to close.
        globals.set(TAILSCALE_DISCOVERY_KEY, String(now()));
        const discovered = await deps.funnel.ensure();
        if (discovered.warning) {
          discoveryWarning = discovered.warning;
          discoveredLocal = discovered.baseUrl;
        } else {
          const url = normalizeBaseUrl(discovered.baseUrl);
          if (url) {
            globals.set(PUBLIC_BASE_URL_KEY, url);
            list.push({ url, source: 'funnel', durability: baseDurability(url, 'funnel') });
          }
        }
      }
    }

    if (list.length === 0) {
      return {
        baseUrl: discoveredLocal ?? `http://127.0.0.1:${deps.publicPort}`,
        source: 'local',
        durability: 'local',
        // Most specific explanation first. A tunnel that keeps dying is the
        // reason there is no base, and saying so (with the command that shows
        // its logs) beats both the funnel's complaint and our generic one.
        warning:
          deps.tunnelWarning?.() ??
          discoveryWarning ??
          'no public base url configured — this link only works on this machine. Set one with `muxpad publish --set-base <https://…>`.',
        health: null,
      };
    }

    if (!opts?.probe) {
      const first = list[0] as PublicBaseCandidate;
      return {
        baseUrl: first.url,
        source: first.source,
        health: null,
        durability: first.durability,
      };
    }

    // Probe in order and take the first that answers. Dead candidates are
    // SKIPPED, never reordered by latency — order is configuration.
    let firstHealth: UrlHealth | null = null;
    for (const c of list) {
      // A TUNNEL candidate is not probed, because we own the process that IS
      // it. The record only exists while our supervised cloudflared is alive
      // and is retracted the moment it exits, so liveness is already known by
      // construction — a probe can add nothing and can only be WRONG.
      //
      // And it was. Observed on this machine: the tunnel served 200 through
      // Cloudflare's edge while the local resolver returned NXDOMAIN for its
      // own hostname (Tailscale MagicDNS negative-caching *.trycloudflare.com),
      // so muxpad demoted a perfectly good public URL and published the
      // Tailscale funnel instead — the one thing already established as
      // blocked on many networks. A false negative here does not degrade the
      // link, it replaces a working one with a broken one.
      //
      // This does not weaken the rule stated above: the probe still only
      // demotes candidates whose liveness is UNKNOWN. The tunnel's is not.
      // ...UNLESS the supervisor is itself reporting trouble. Its distress
      // signal is the one thing that can revoke this trust, because it is the
      // same source the trust came from — not a probe second-guessing it.
      //
      // MEASURED ANYWAY, AND THAT IS NOT A CONTRADICTION. "Do not RANK on the
      // probe" was previously implemented as "do not RUN the probe", and those
      // are different promises. The cost of conflating them was that
      // `muxpad publish --base` reported `reachable: not checked` for the one
      // candidate the user most wanted checked — every published link is built
      // from it. So the probe runs and its result is REPORTED; the return is
      // unconditional either way, which is the whole of the guarantee above.
      if (c.source === 'tunnel' && !deps.tunnelWarning?.()) {
        const health = await reach(c.url);
        return { baseUrl: c.url, source: c.source, health, durability: c.durability };
      }
      const health = await reach(c.url);
      firstHealth ??= health;
      if (health.alive)
        return { baseUrl: c.url, source: c.source, health, durability: c.durability };
    }
    // Nothing answered. Return the top candidate anyway — it is still the
    // user's stated intent, and a loopback url would be actively misleading —
    // but say so, because a link nobody can open is the failure this whole
    // module exists to stop shipping silently.
    const first = list[0] as PublicBaseCandidate;
    const tunnelTrouble = deps.tunnelWarning?.();
    return {
      baseUrl: first.url,
      source: first.source,
      // When muxpad's own tunnel is the reason nothing answers, SAY SO rather
      // than leaving the user to guess at "the tunnel may be down" — there is
      // now an owner, a log, and a command that shows it.
      warning: tunnelTrouble
        ? `${first.url} is not answering — ${tunnelTrouble}`
        : `${first.url} is not answering — the tunnel may be down. The link may not work for anyone else.`,
      health: firstHealth,
      durability: first.durability,
    };
  };

  return {
    resolve,
    candidates,
    discoveryNeeded,
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
