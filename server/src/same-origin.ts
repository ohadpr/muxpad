import type { MiddlewareHandler } from 'hono';

/**
 * CSRF guard for the MAIN (tailnet) API and for the WebSocket upgrade path —
 * see docs/plans/2026-08-28-muxpad-publish.md for the trust model this sits
 * inside.
 *
 * TWO CALLERS, ONE POLICY. {@link checkOrigin} is the whole decision; the Hono
 * middleware below and the `upgrade` arm in ws.ts both call it and differ only
 * in (a) which requests they submit to it and (b) how they say no. Everything
 * this comment claims is therefore true of both.
 *
 * THE HOLE
 * --------
 * muxpad has no auth: reachability IS authorization, and the boundary is the
 * tailnet. That is fine for a request the user makes. It is not fine for a
 * request ANY web page can make while the user's browser is on the tailnet:
 *
 *   fetch('http://muxpad-host:7777/api/apps',
 *         { method: 'POST', mode: 'no-cors',
 *           headers: { 'content-type': 'text/plain' }, body: '{…}' })
 *
 * `text/plain` keeps it a CORS *simple request*, so there is NO preflight to
 * refuse it, and Hono's `c.req.json()` parses the body regardless of
 * Content-Type. The response is unreadable to the attacker — and irrelevant,
 * because the damage is the WRITE. This is not new to any one feature (POST
 * /api/publish and POST /api/tabs/:id/panes were always exposed), but the
 * durable surfaces make it matter: POST /api/apps writes an arbitrary command
 * into a hidden-workspace pane that AUTOSTARTS on every boot, and POST
 * /api/crons schedules unattended agent work that survives reboots. A single
 * drive-by page load would be enough, once, forever.
 *
 * THE RULE
 * --------
 * Applied to every state-changing method (anything but GET/HEAD/OPTIONS —
 * DELETE and PUT already force a preflight, but the class is guarded as a
 * class rather than patching the one method that slips through today), in
 * this order:
 *
 *   an `origin` header   → its HOSTNAME must be loopback, listed in
 *                          MUXPAD_ALLOWED_ORIGINS, or equal to the request's
 *                          Host hostname. Otherwise REFUSE. This is the load-
 *                          bearing check; everything else is a backstop.
 *   `origin: null`       → REFUSE. An opaque origin (a sandboxed iframe — see
 *                          public-server.ts, which puts every published
 *                          artifact in one). Nothing legitimate sends it.
 *   NO `origin` at all   → ALLOW, unless `sec-fetch-site: cross-site` says a
 *                          browser sent it cross-site anyway. No Origin means
 *                          not a browser: the CLI (`curl` sends none), the
 *                          agent runner, crons, every server-side caller.
 *                          Browsers attach Origin to every cross-origin
 *                          request, including form POSTs and no-cors fetches,
 *                          so refusing this would break `muxpad` itself and
 *                          buy nothing.
 *
 * The explicit allowlist is checked BEFORE the Sec-Fetch-Site refusal on
 * purpose: an origin the user has named must not still be 403'd by a header
 * whose whole job is to catch origins they have NOT named.
 *
 * WEBSOCKETS
 * ----------
 * A WS handshake is a GET, so SAFE_METHODS skips it here — and it never
 * reaches Hono anyway, because ws.ts attaches to the Node http server's
 * `upgrade` event. That left the far worse half of the same hole open: any
 * page could `new WebSocket('ws://muxpad-host:7777/ws/pane/<id>')` and write
 * OP_INPUT frames into a live terminal. Browsers apply NO CORS to WebSockets,
 * so nothing refuses it for us — but they DO send `Origin` on every WS
 * handshake (RFC 6455 §4.1 makes it mandatory for browser clients), which is
 * what makes the same predicate work there. ws.ts submits EVERY upgrade to
 * {@link checkOrigin}, regardless of method, and refuses with a bare 403
 * before the upgrade completes. See the block comment at that call site for
 * why "no Origin" stays allowed on that path too.
 *
 * ON Sec-Fetch-Site, HONESTLY: it is a backstop, not the mechanism. Browsers
 * only attach fetch-metadata headers on potentially-trustworthy URLs, and
 * muxpad's real deployment is plain http on a tailnet address — measured,
 * `http://<lan-or-tailnet-ip>:7777` gets an `Origin` and NO `Sec-Fetch-Site`
 * at all (loopback and https do get it). So on the live origin this check
 * does nothing, and the Origin comparison above is what holds. It is kept
 * because it costs one string compare and it does work for a loopback or
 * TLS-terminated deployment.
 *
 * HOSTNAME, NOT FULL ORIGIN, on purpose. muxpad is reached as
 * `http://127.0.0.1:7777`, `http://<tailnet-ip>:7777`, `http://<host>.ts.net:7777`,
 * through the vite dev proxy on :5173, and potentially behind a TLS terminator
 * that keeps the host but changes the scheme and port. Comparing schemes and
 * ports would lock the user out of their own app in at least two of those; the
 * attack this stops (an unrelated internet page) fails the hostname test
 * anyway.
 *
 * ESCAPE HATCH: `MUXPAD_ALLOWED_ORIGINS` — a comma-separated list of origins
 * or bare hostnames. The one configuration a reverse proxy that REWRITES the
 * Host header needs, and the rejection log line names it, so a lockout is
 * self-diagnosing rather than a silent 403.
 */

/**
 * Loopback is always allowed: same machine, and the dev tooling lives there
 * (vite on :5173 proxies to :7777 without rewriting Host).
 *
 * This blanket-trusts everything else the user runs on loopback — including
 * muxpad's OWN public artifact server on :7778, which serves agent-written
 * HTML. That path is closed only because public-server.ts sandboxes every
 * artifact into an opaque origin, and an opaque origin is refused below.
 * Weakening either one without the other reopens it.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function hostnameOf(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    // Bare `host:port` / `host` (a Host header) has no scheme; give it one.
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Parse MUXPAD_ALLOWED_ORIGINS into a hostname set. */
export function parseAllowedOrigins(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const host = hostnameOf(entry);
    if (host) out.add(host);
  }
  return out;
}

/** The three headers the decision reads. Plain values, so a Hono context and a
 *  raw `http.IncomingMessage` can both be fed in without either caller
 *  re-implementing the policy. */
export interface OriginHeaders {
  origin?: string | undefined;
  host?: string | undefined;
  secFetchSite?: string | undefined;
}

/** `why` is the human-readable reason, used verbatim in the log line and in
 *  the refusal body — a lockout has to diagnose itself. */
export type OriginVerdict = { ok: true } | { ok: false; why: string };

/**
 * THE predicate — the entire same-origin policy, in one pure function. Both
 * enforcement points (the middleware below, the `upgrade` arm in ws.ts) call
 * it, so the two can never drift into disagreeing about what is same-origin.
 *
 * Deciding NOTHING about which requests are worth checking: that is the
 * caller's business (HTTP checks state-changing methods only; WS checks every
 * handshake, because a WS handshake is a GET that grants a write channel).
 */
export function checkOrigin(headers: OriginHeaders, allowed: Set<string>): OriginVerdict {
  const origin = headers.origin;
  if (origin) {
    // `null` is an opaque origin — a sandboxed iframe, which is exactly what
    // every published artifact runs as (public-server.ts). Never legitimate.
    if (origin === 'null') return { ok: false, why: 'opaque origin' };
    const from = hostnameOf(origin);
    if (!from) return { ok: false, why: 'unparsable Origin' };
    // Explicit trust FIRST, so MUXPAD_ALLOWED_ORIGINS can actually rescue a
    // lockout — including one Sec-Fetch-Site would otherwise cause.
    if (LOOPBACK.has(from) || allowed.has(from)) return { ok: true };
    const self = hostnameOf(headers.host ?? '');
    if (self && from === self) return { ok: true };
    return { ok: false, why: `Origin ${from} does not match Host ${self ?? '(none)'}` };
  }

  // No Origin → not a browser. The CLI curls, the runner, crons, tests.
  // Unless the browser says otherwise: `sec-fetch-site` is browser-attested
  // and not settable by page script (`same-origin`/`same-site` are fine, and
  // `none` is a user-initiated top-level load, which cannot carry a
  // cross-site POST body). See the header comment for why this is only a
  // backstop on muxpad's actual plain-http origin.
  if (headers.secFetchSite === 'cross-site')
    return { ok: false, why: 'sec-fetch-site: cross-site, with no Origin' };

  return { ok: true };
}

export interface SameOriginOptions {
  /** Extra hostnames to trust. Defaults to MUXPAD_ALLOWED_ORIGINS. */
  allowedOrigins?: Set<string>;
  /** Rejection sink. Defaults to console.warn; tests pass a collector. */
  log?: (line: string) => void;
}

/** Methods that can change state. OPTIONS is a preflight, never a mutation. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sameOriginGuard(opts: SameOriginOptions = {}): MiddlewareHandler {
  const allowed = opts.allowedOrigins ?? parseAllowedOrigins(process.env.MUXPAD_ALLOWED_ORIGINS);
  const log = opts.log ?? ((line: string) => console.warn(line));

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const refuse = (why: string): Response => {
      log(
        `muxpad: refused ${c.req.method} ${new URL(c.req.url).pathname} — ${why}. If this is your own front end, add its origin to MUXPAD_ALLOWED_ORIGINS.`,
      );
      return c.json(
        {
          error: {
            code: 'cross_origin_refused',
            message: `cross-origin ${c.req.method} refused (${why}); set MUXPAD_ALLOWED_ORIGINS to allow this origin`,
          },
        },
        403,
      );
    };

    const verdict = checkOrigin(
      {
        origin: c.req.header('origin'),
        host: c.req.header('host'),
        secFetchSite: c.req.header('sec-fetch-site'),
      },
      allowed,
    );
    return verdict.ok ? next() : refuse(verdict.why);
  };
}
