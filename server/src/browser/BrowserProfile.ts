/**
 * Naming and addressing for a browser profile muxpad OWNS.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * On 2026-09-10 about twenty agent sessions were each launching their own
 * browser against the SAME on-disk profile directory. Chrome takes an exclusive
 * lock on a profile, so they fought, and the fix at the time was `--isolated`:
 * every session gets a throwaway in-memory profile. That ended the contention
 * and simultaneously ended having any cookies at all, which is why every
 * browsing task re-logs-in and trips every bot wall as a brand-new visitor.
 *
 * The contention was never "too many browsers". It was too many OWNERS of one
 * directory. Three tabs that each want a browser is fine — they can be three
 * windows of one process, sharing one cookie jar, which is the thing that was
 * actually wanted. What is not fine is three processes opening one directory.
 *
 * So the rule this module encodes is:
 *
 *     one profile directory  ⟺  exactly one owner process
 *
 * and it is enforced structurally rather than by convention: the owner is an
 * APP (see TunnelApp.ts for the same move), an app is identified by its slug,
 * and the slug here is a pure function of the profile name. There is no way to
 * spell one profile two ways and get two owners.
 *
 * WHY PROFILES ARE NAMED RATHER THAN PER-TAB
 * ------------------------------------------
 * Cookies live in a PROFILE, not in a browser context. Playwright contexts are
 * cookie-isolated by design, so "a context per tab" would reproduce the
 * logged-out-every-time problem with extra steps. Sharing a session means
 * sharing a profile, and separating sessions (two accounts on one site) means a
 * second NAMED profile — a second owner, deliberately.
 *
 * WHY THE PORT IS DERIVED AND NOT ALLOCATED
 * -----------------------------------------
 * A pane's `face_url` and a card in a chat log outlive the browser process. If
 * the port moved on every restart, every link muxpad had ever written would
 * point at a dead port. So the port is a pure function of the profile name,
 * with a probe step for the collision case, and it is persisted on the app row
 * (see {@link parseBrowserPort}) so a restart can recover the one actually in
 * use rather than re-deriving and guessing.
 */

/** Every owner app row is `browser-<profile>`. */
export const BROWSER_APP_SLUG_PREFIX = 'browser-';

/** Where profile directories live, relative to the data dir. */
export const BROWSER_PROFILES_DIRNAME = 'browser-profiles';

/**
 * Ports reserved for browser owners. Deliberately above muxpad's own ports and
 * away from the 3000/5173/8080 range a dev server is likely to want.
 */
export const BROWSER_PORT_RANGE: readonly [number, number] = [9400, 9499];

/**
 * Distance from a profile's CDP port to its VIEWER port.
 *
 * Two ports, both derived from the one number, for the same reason the number
 * is derived at all: a card in a chat log outlives the browser process, and a
 * viewer URL that moved on restart would strand every link muxpad ever wrote.
 *
 * They are kept apart because different things dial them — CDP is dialled by
 * the agent's Playwright MCP, the viewer is opened by a person — and because
 * the offset must clear the whole CDP range, or one profile's viewer lands on
 * another profile's debugging port and the two fight silently.
 */
export const BROWSER_VIEWER_PORT_OFFSET = 100;

/** The viewer port paired with a profile's CDP port. */
export function browserViewerPort(cdpPort: number): number {
  return cdpPort + BROWSER_VIEWER_PORT_OFFSET;
}

/**
 * Profiles registered at boot.
 *
 * Deliberately ONE. Every extra profile is another cookie jar that starts cold,
 * and the value of this whole subsystem is a profile that has been used enough
 * to look like a person's. A second profile is something you add when you have
 * a reason — two accounts on one site — not something muxpad guesses for you.
 */
export const DEFAULT_BROWSER_PROFILES: readonly string[] = ['default'];

/** Longest profile name. It becomes a slug, a pane title and a path segment. */
const MAX_PROFILE_NAME = 64;

/**
 * Canonical form of a profile name.
 *
 * This is the security boundary of the module, because the result becomes a
 * PATH SEGMENT under the data dir. Two layers, in this order:
 *
 *   1. REJECT path separators and dot-segments outright, so a traversal
 *      attempt fails loudly instead of being quietly rewritten into a
 *      plausible-looking profile;
 *   2. then a whitelist — anything that is not a lower-case letter, digit or
 *      dash becomes a dash — so nothing else can survive either.
 *
 * Layer 2 alone would be safe but silent; layer 1 is what makes a bad caller
 * visible.
 *
 * @throws if the name contains a separator, is empty, over-long, or slugifies
 *   to nothing.
 */
export function normalizeProfileName(raw: string): string {
  const trimmed = String(raw ?? '').trim();

  // Separators and dot-segments are REJECTED, not sanitized. The whitelist
  // below would happily turn `../../etc` into `etc` and hand back a plausible
  // profile — silently doing something adjacent to what a buggy caller asked
  // for is how a traversal attempt becomes a mystery directory nobody audits.
  if (/[/\\]/.test(trimmed) || /^\.+$/.test(trimmed)) {
    throw new Error(
      `bad profile name ${JSON.stringify(raw)}: path separators and dot-segments are not allowed`,
    );
  }

  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) {
    throw new Error(`bad profile name ${JSON.stringify(raw)}: must contain a letter or digit`);
  }
  if (slug.length > MAX_PROFILE_NAME) {
    throw new Error(`bad profile name ${JSON.stringify(raw)}: over ${MAX_PROFILE_NAME} characters`);
  }
  return slug;
}

/** Absolute path of a profile's directory. Normalizes, so traversal cannot pass. */
export function browserProfileDir(dataDir: string, profile: string): string {
  return `${dataDir.replace(/\/+$/, '')}/${BROWSER_PROFILES_DIRNAME}/${normalizeProfileName(profile)}`;
}

/** Slug of the app row that owns this profile. One profile, one slug, one owner. */
export function browserAppSlug(profile: string): string {
  return BROWSER_APP_SLUG_PREFIX + normalizeProfileName(profile);
}

/** Display name of that row. */
export function browserAppName(profile: string): string {
  return `browser · ${normalizeProfileName(profile)}`;
}

/** Whether an app slug is one of ours. */
export function isBrowserAppSlug(slug: string): boolean {
  return profileFromAppSlug(slug) !== null;
}

/**
 * The profile an app slug owns, or null if the row is not ours. Round-trips
 * with {@link browserAppSlug}; a slug we did not mint is never claimed.
 */
export function profileFromAppSlug(slug: string): string | null {
  if (!slug.startsWith(BROWSER_APP_SLUG_PREFIX)) return null;
  const rest = slug.slice(BROWSER_APP_SLUG_PREFIX.length);
  try {
    return normalizeProfileName(rest) === rest ? rest : null;
  } catch {
    return null;
  }
}

/**
 * The owner's base URL. LOOPBACK ONLY — this machine is on a tailnet, and a
 * browser owner bound wide would hand every device on it a driveable browser
 * holding every cookie the user has.
 */
export function browserAppUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The port off a stored app row's url, or null if the row is unreadable.
 *
 * Null rather than a fallback on purpose: a wrong port silently addresses
 * somebody else's server, and the caller's correct response is to re-derive,
 * not to dial whatever we guessed.
 */
export function parseBrowserPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:') return null;
  const port = Number(parsed.port);
  const [lo, hi] = BROWSER_PORT_RANGE;
  return Number.isInteger(port) && port >= lo && port <= hi ? port : null;
}

/**
 * The port for a profile: derived from its name so it is stable across
 * restarts, then stepped forward past anything in `taken`.
 *
 * @throws if every port in the range is taken, rather than returning one
 *   outside it — a browser owner on an unreserved port is how you end up
 *   fighting a dev server for :3000 at the worst possible moment.
 */
export function pickBrowserPort(profile: string, taken: ReadonlySet<number>): number {
  const name = normalizeProfileName(profile);
  const [lo, hi] = BROWSER_PORT_RANGE;
  const span = hi - lo + 1;

  // FNV-1a — a stable hash that does not depend on the runtime's string hashing.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  for (let step = 0; step < span; step++) {
    const port = lo + ((hash + step) % span);
    if (!taken.has(port)) return port;
  }
  throw new Error(`no free browser port in ${lo}-${hi} (${taken.size} taken)`);
}

/**
 * The ONE shared cookie jar for this machine.
 *
 * Deliberately not per-profile. The jar is the point of contact between the
 * browser a PERSON logs into and the throwaway browsers agents get: one file
 * that the human's browser exports to and every session browser seeds from. A
 * jar per profile would give each session its own empty one, which is a cold
 * browser with extra steps — the exact failure this was built to end.
 *
 * Beside the profiles rather than inside one: a profile directory belongs to
 * Chrome and is locked while it runs, and this file is read by other processes.
 */
export function browserJarPath(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, '')}/${BROWSER_PROFILES_DIRNAME}/shared.cookies.json`;
}
