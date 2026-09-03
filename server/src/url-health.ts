import type { UrlHealth, UrlHealthReason } from '@muxpad/shared';

/**
 * Server-side health probe for a pane's web-face URL.
 *
 * WHY THE BROWSER CANNOT DO THIS
 * ------------------------------
 * web/src/lib/face-switch.ts probes with `fetch(url, { mode: 'no-cors' })` and
 * treats any resolved promise as alive. An opaque response carries NO status —
 * `res.status` is 0 — so the only thing that probe can distinguish is "something
 * accepted the connection" from "nothing did".
 *
 * That is enough for a bare `http://127.0.0.1:4321` dev server (dead ⇒ connection
 * refused ⇒ the fetch rejects). It is exactly wrong for anything behind a proxy:
 * `tailscale serve` keeps :443 listening whether or not the local backend is up,
 * and answers 502 when it isn't. The fetch resolves, the probe says "alive", and
 * the user gets a silent blank/error iframe with no notice and no recovery.
 *
 * The main server has no such handicap: it runs on the same machine as the app,
 * it is not a browser, and so it can issue a real HTTP request and READ THE
 * STATUS. 502/503/504 from a proxy is the exact signal the browser can't see.
 * Server-side probing also sidesteps CORS and mixed-content blocking entirely.
 *
 * WHAT COUNTS AS ALIVE (see {@link classifyStatus})
 * -------------------------------------------------
 * "Alive" means: mounting the iframe would show the user something better than
 * our notice. That's a broader set than 2xx — an auth wall (401/403), a wrong
 * path (404) and even the app's own crash page (500) are all more informative
 * than "nothing is responding". Only the gateway statuses, which mean "I am a
 * proxy and my backend is gone", and outright transport failure are dead.
 */

// The wire shape lives in @muxpad/shared: the web face decides what to render
// from these exact fields, so one definition serves both ends.
export type { UrlHealth } from '@muxpad/shared';

export function classifyStatus(status: number): { alive: boolean; reason: UrlHealthReason } {
  // A proxy answering for a backend it can't reach. This is THE case the
  // browser's opaque probe gets wrong, and the whole reason this file exists:
  // tailscale serve holds the public port open and 502s when `./start` is down.
  if (status === 502 || status === 503 || status === 504) {
    return { alive: false, reason: 'gateway' };
  }
  // The app answered — badly, but it answered. Its own error page beats our
  // "the server may have stopped", which would be a lie.
  if (status >= 500) return { alive: true, reason: 'server_error' };
  // Auth walls and wrong paths: the app is emphatically up. An auth-walled app
  // that 401s every probe must never be reported as stopped.
  if (status >= 400) return { alive: true, reason: 'client_error' };
  return { alive: true, reason: 'ok' };
}

/**
 * Where a URL points, as far as an SSRF guard is concerned.
 *
 * Literal hosts only — we deliberately do NOT resolve names here. Resolving
 * would still be TOCTOU (fetch resolves again) and would make the guard depend
 * on the network; the route's real containment is that the target must already
 * have been DECLARED on the pane, not that we can see where a name points.
 * A public name that resolves to a private address therefore classifies as
 * 'public' — see the trust model note on GET /panes/:id/url-health.
 */
export type UrlHostClass = 'loopback' | 'link_local' | 'private' | 'public';

/** Trailing-dot-tolerant, case-insensitive suffix test for hostnames. */
function hostEndsWith(host: string, suffix: string): boolean {
  return host === suffix.slice(1) || host.endsWith(suffix);
}

/**
 * Dotted-quad for an IPv6 literal that carries an IPv4 address: MAPPED
 * (`::ffff:a.b.c.d`), TRANSLATED (`::ffff:0:a.b.c.d`) or the deprecated
 * COMPATIBLE form (`::a.b.c.d`). Null for anything else.
 *
 * This is not a curiosity: `new URL('http://[::ffff:169.254.169.254]/')`
 * NORMALIZES the host to `[::ffff:a9fe:a9fe]`, so a literal string compare
 * against the dotted form never matches — and the address still routes to
 * 169.254.169.254. Without this decode, every v4 rule below (loopback, RFC1918,
 * the metadata address) could be bypassed simply by writing the target in
 * IPv6 form. `::` itself is excluded: it is the unspecified address, not
 * 0.0.0.0-via-compat, and is handled with the other v6 rules.
 */
function mappedV4(v6: string): string | null {
  const m = /^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!m) return null;
  const hi = Number.parseInt(m[1] as string, 16);
  const lo = Number.parseInt(m[2] as string, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Classify a URL's literal host. Returns null when the URL doesn't parse or
 * isn't http(s) — callers must treat that as "refuse".
 */
export function classifyUrlHost(url: string): UrlHostClass | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // `new URL` keeps IPv6 literals bracketed; strip for range tests.
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  let v6 = host.startsWith('[') ? host.slice(1, -1) : host;
  // An IPv4-mapped v6 literal IS its v4 address as far as routing (and this
  // guard) is concerned — flatten it before any rule looks at it.
  const flattened = mappedV4(v6);
  if (flattened) {
    v6 = flattened;
    host = flattened;
  }

  // Cloud metadata endpoints, by address AND by the names clouds publish for
  // them. Never legitimate for a muxpad pane; refused unconditionally.
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host === 'instance-data' ||
    v6 === 'fd00:ec2::254'
  ) {
    return 'link_local';
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v6);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return 'loopback';
    // 0.0.0.0 is "this host": connecting to it reaches localhost on macOS and
    // Linux, so it is loopback for the purpose of this guard — NOT merely
    // "private". A dev server really does print `http://0.0.0.0:3000`, which is
    // why it isn't refused outright.
    if (v6 === '0.0.0.0') return 'loopback';
    if (a === 169 && b === 254) return 'link_local'; // includes 169.254.169.254
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT — tailnet IPs
    if (a === 0 || a >= 224) return 'private'; // 0.0.0.0/8 rest, multicast, reserved
    return 'public';
  }
  if (v6.includes(':')) {
    if (v6 === '::1') return 'loopback';
    if (/^fe[89ab]/.test(v6)) return 'link_local'; // fe80::/10
    if (/^f[cd]/.test(v6)) return 'private'; // fc00::/7 ULA
    if (v6 === '::') return 'loopback'; // unspecified — reaches localhost, like 0.0.0.0
    return 'public';
  }
  if (host === 'localhost' || hostEndsWith(host, '.localhost')) return 'loopback';
  // mDNS / intranet suffixes, and bare single-label names (an intranet host).
  if (
    hostEndsWith(host, '.local') ||
    hostEndsWith(host, '.internal') ||
    hostEndsWith(host, '.home.arpa') ||
    !host.includes('.')
  ) {
    return 'private';
  }
  return 'public';
}

export interface ProbeUrlHealthOpts {
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Probe `url` from the server and classify the result.
 *
 * GET, not HEAD: plenty of dev servers (and SPA catch-all handlers) answer HEAD
 * with a 404 or 405 while GET is perfectly healthy, and a HEAD that a framework
 * doesn't route can even hang. The body is discarded without being read, so the
 * cost is a header round-trip either way.
 *
 * `redirect: 'manual'` keeps a 30x as a 30x — following it could walk us to a
 * login host that has nothing to do with whether this app is up, and a redirect
 * is itself proof the server answered.
 *
 * Never throws: every failure becomes `alive: false`, because a caller deciding
 * whether to mount an iframe has no use for an exception.
 */
export async function probeUrlHealth(
  url: string,
  opts: ProbeUrlHealthOpts = {},
): Promise<UrlHealth> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctl.signal,
      headers: {
        // Identify ourselves so an app's logs don't show mystery traffic.
        'user-agent': 'muxpad-health-probe',
        // A cached 200 from an intermediary would defeat the whole probe —
        // the question is whether the ORIGIN is answering right now.
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    // The body is never read; cancel it so a streaming/SSE endpoint doesn't
    // hold the socket (and our event loop) open for the life of the response.
    try {
      await res.body?.cancel();
    } catch {
      // already consumed/closed — nothing to do
    }
    const { alive, reason } = classifyStatus(res.status);
    return { alive, status: res.status, reason, elapsedMs: now() - started };
  } catch {
    return {
      alive: false,
      status: null,
      reason: timedOut ? 'timeout' : 'unreachable',
      elapsedMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
