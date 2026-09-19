import { constants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The pure half of muxpad's Cloudflare tunnel: how to find `cloudflared`, how
 * to read a hostname out of what it prints, and how fast to retry it.
 *
 * Nothing here spawns anything or touches a database — which is the point. The
 * one genuinely fragile thing in this feature is parsing a third-party tool's
 * human-facing banner, so it lives in a function with no dependencies and is
 * pinned against REAL captured output (cloudflared.test.ts).
 */

/**
 * A quick tunnel's assigned hostname, read out of cloudflared's log stream.
 *
 * THE FORMAT, captured verbatim from `cloudflared tunnel --url …` 2026.8.2 —
 * not invented, and the reason this is a parser rather than a one-line grep:
 *
 *   …INF +-----------------------------------------------------------+
 *   …INF |  Your quick Tunnel has been created! Visit it at (it may…  |
 *   …INF |  https://franklin-discuss-powers-usgs.trycloudflare.com    |
 *   …INF +-----------------------------------------------------------+
 *
 * The url sits alone on a line INSIDE an ASCII box, padded with spaces to the
 * box width, prefixed by a timestamp and a level. So: no anchoring on line
 * start, no assuming the url is the whole line.
 *
 * WHY THE HOST IS MATCHED SO NARROWLY. The very first thing cloudflared prints
 * is a legal notice containing `https://www.cloudflare.com/website-terms/` and
 * `https://developers.cloudflare.com/cloudflare-one/…`. A `https://\S+` grep —
 * the obvious implementation — pins the tunnel to Cloudflare's marketing site
 * on every single start, and the failure is invisible: the name resolves, the
 * probe says ALIVE, and every published link 404s on someone else's website.
 * Hence: exactly one DNS label, then `.trycloudflare.com`, then a character
 * that cannot continue a hostname (so `x.trycloudflare.com.evil.test` is not a
 * match either).
 *
 * Returns a normalized ORIGIN (no trailing slash) so it can be handed straight
 * to `normalizeBaseUrl`, or null when the chunk holds no hostname. Accepts a
 * whole multi-line chunk, because a pipe hands us whatever arrived, not lines.
 */
const QUICK_TUNNEL_RE = /https:\/\/([a-z0-9][a-z0-9-]{0,62})\.trycloudflare\.com(?![a-z0-9.-])/gi;

export function parseQuickTunnelUrl(chunk: string): string | null {
  // A fresh lastIndex per call — the regex is module-level and /g is stateful.
  QUICK_TUNNEL_RE.lastIndex = 0;
  const m = QUICK_TUNNEL_RE.exec(chunk);
  if (!m) return null;
  return `https://${m[1]?.toLowerCase()}.trycloudflare.com`;
}

/** Where `cloudflared` is looked for, in order, when no override is given. */
export const CLOUDFLARED_FALLBACKS = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
];

/**
 * Locate the cloudflared binary, or null.
 *
 * Null is a FIRST-CLASS answer, never an exception: a machine without
 * cloudflared installed must degrade to "no tunnel, here is why" — the server
 * declining to register the app at all — rather than to a pane crash-looping on
 * ENOENT behind a hidden workspace where nobody would ever see it.
 *
 * PATH is searched by hand rather than shelled out to `command -v`, because the
 * one caller that matters most runs under launchd, where PATH is minimal and a
 * subshell is one more thing that can fail differently there than in a terminal.
 */
export function findCloudflared(opts?: {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string | null {
  const env = opts?.env ?? process.env;
  const exists =
    opts?.exists ??
    ((p: string) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const override = env.MUXPAD_CLOUDFLARED_BIN;
  // An explicit override is obeyed or refused — never silently replaced by a
  // different binary than the one the user named.
  if (override) return exists(override) ? override : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'cloudflared');
    if (exists(candidate)) return candidate;
  }
  for (const candidate of CLOUDFLARED_FALLBACKS) if (exists(candidate)) return candidate;
  return null;
}

/** First wait after a failure. */
export const TUNNEL_BACKOFF_MIN_MS = 2_000;
/**
 * Ceiling on the wait. A quick tunnel that cannot be created (Cloudflare
 * rate-limiting an account-less tunnel, no network, a laptop asleep) fails in
 * under a second, so an uncapped-rate retry is a tight spin against someone
 * else's API — the exact behaviour that gets an IP blocked. A minute is slow
 * enough to be polite and fast enough that a transient outage self-heals
 * without anyone noticing.
 */
export const TUNNEL_BACKOFF_MAX_MS = 60_000;
/**
 * A run that lasted at least this long counts as a SUCCESS for backoff
 * purposes, so a tunnel that worked for an hour and then dropped retries
 * immediately instead of inheriting an hour-old failure's ceiling.
 */
export const TUNNEL_HEALTHY_RUN_MS = 60_000;

/**
 * Exponential backoff with a hard ceiling. `attempt` is 1-based (the wait
 * AFTER the first failure), and everything past the cap returns the cap —
 * deliberately, rather than growing unboundedly: there is no failure this
 * supervises that is better served by waiting two hours than by waiting one
 * minute, and a restart that never comes is indistinguishable from a crash.
 */
export function tunnelBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  const grown = TUNNEL_BACKOFF_MIN_MS * 2 ** (attempt - 1);
  // 2 ** big is Infinity long before it overflows anything; Math.min handles it.
  return Math.min(grown, TUNNEL_BACKOFF_MAX_MS);
}
