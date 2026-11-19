/**
 * HOW A BROWSER HOST'S APP ROW IS NAMED — and how to tell one apart.
 *
 * Every browser muxpad drives is registered as an ordinary app so that one
 * supervisor keeps it alive, which means the registry holds one row per
 * profile ever used: `browser-default`, `browser-shots`,
 * `browser-perf-chat-open`. Thirteen of the thirty-six apps on the machine
 * this was written on.
 *
 * ── WHY THE RULE IS SHARED ──────────────────────────────────────────────────
 * The server owns the minting (browser/BrowserProfile) and used to own the
 * only reader. Then ⌘K started searching apps, and these flooded it: the query
 * "browser" returned thirteen results and nothing else, and "chat", "test",
 * "default", "shots" and "perf" each returned one of muxpad's own hosts and
 * nothing of the user's. Pressing Enter on one navigates into an internal CDP
 * host.
 *
 * So the client needs the same rule — and a SECOND COPY of a naming
 * convention is how the two drift: a prefix changed on one side and not the
 * other hides every browser from its own supervisor, or shows every one of
 * them in search again.
 */
export const BROWSER_APP_SLUG_PREFIX = 'browser-';

/** Is this app row one of muxpad's own browser hosts? */
export function isBrowserAppSlug(slug: string): boolean {
  return slug.startsWith(BROWSER_APP_SLUG_PREFIX) && slug.length > BROWSER_APP_SLUG_PREFIX.length;
}
