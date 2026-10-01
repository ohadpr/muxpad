import { normalizeProfileName } from './BrowserProfile.js';

/**
 * Serving the viewer underneath muxpad's own origin.
 *
 * THE PROBLEM. The browser host binds 127.0.0.1, and must: it is a driveable
 * browser holding every cookie the user has, on a machine sitting on a tailnet.
 * But the entire point of the handoff is that you take the wheel from wherever
 * you are — usually a phone — and a loopback URL on a phone is nothing.
 *
 * WHY A PROXY AND NOT A SECOND LISTENER. muxpad's cockpit is already reachable
 * over the tailnet and already has exactly the reachability this wants:
 * tailnet-only, never a public funnel. Serving the viewer underneath it means
 * the link inherits that for free —
 *
 *   · no new port exposed, and no second reachability policy to keep in sync;
 *   · no `tailscale serve` mapping, which would need the Tailscale CLI, which
 *     lives inside an app bundle and would raise a macOS permission dialog
 *     (see findChrome.ts — we are not doing that again);
 *   · the modal's iframe becomes SAME-ORIGIN with the cockpit, which it was
 *     not before;
 *   · and the WebSocket upgrade guard that already protects every other muxpad
 *     socket covers this one too, rather than the viewer inventing its own.
 */

/** Everything under here is a viewer. */
export const BROWSER_PROXY_PREFIX = '/browser';

export interface BrowserProxyPath {
  profile: string;
  /** Path to pass through to the host, always leading-slashed. */
  rest: string;
}

/**
 * Splits a request path into the profile and what to forward.
 *
 * Null for anything that is not a viewer request, INCLUDING a profile name that
 * is not a bare slug. The profile is looked up rather than used as a path, so a
 * traversal could not escape anything — but refusing it here means it never
 * reaches the lookup, which is one less thing to reason about later.
 */
export function parseBrowserProxyPath(pathname: string): BrowserProxyPath | null {
  if (!pathname.startsWith(`${BROWSER_PROXY_PREFIX}/`)) return null;
  const after = pathname.slice(BROWSER_PROXY_PREFIX.length + 1);
  if (!after) return null;

  const slash = after.indexOf('/');
  const raw = slash === -1 ? after : after.slice(0, slash);
  if (!raw) return null;

  let profile: string;
  try {
    profile = normalizeProfileName(decodeURIComponent(raw));
  } catch {
    return null;
  }
  // A name that had to be CHANGED to be legal is not the name that was asked
  // for, and quietly serving a different browser is worse than a 404.
  if (profile !== raw) return null;

  const rest = slash === -1 ? '/' : after.slice(slash) || '/';
  return { profile, rest };
}

/**
 * The link a person is given for a browser.
 *
 * Prefers the tailnet origin, because the link is for the phone in their pocket
 * as much as the machine in front of them. Falls back to the cockpit's own
 * origin rather than assembling a hostname from parts — a wrong hostname fails
 * later and far less visibly than an honest local one.
 *
 * Always ends in a slash: without it the viewer's own `./upload` resolves one
 * directory up and posts to the wrong place.
 */
export function browserViewerLink(
  profile: string,
  tailnetHost: string | null,
  fallbackOrigin = 'http://127.0.0.1:7777',
): string {
  const name = normalizeProfileName(profile);
  const origin = tailnetHost ? `https://${tailnetHost}` : fallbackOrigin.replace(/\/+$/, '');
  return `${origin}${BROWSER_PROXY_PREFIX}/${name}/`;
}
