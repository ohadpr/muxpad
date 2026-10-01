/**
 * The shared cookie jar.
 *
 * THE DESIGN THIS SETTLES, after two wrong turns that both reached the user's
 * machine. Agents cannot share one browser. playwright-mcp gives an HTTP client
 * either its own CONTEXT — which a persistent profile refuses outright, because
 * Chrome locks the profile directory — or a shared context that also shares the
 * PAGE, so two agents navigate on top of each other. There is no "one jar, a tab
 * each" mode, and pretending otherwise is what put a browser in front of the
 * user that silently clobbered concurrent work.
 *
 * So the JAR moves instead of the browser.
 *
 * muxpad's browser is the one a PERSON drives and logs into — through the
 * handoff, on their phone if that is where they are — and it is the source of
 * truth. Its cookies are exported as a Playwright storage-state file that every
 * agent starts warm from, each in its own isolated context. Agents inherit the
 * logins; nothing contends for a page; the human's session is the thing that
 * accumulates reputation, which is exactly what the research said made agentic
 * browsing work in the first place.
 *
 * The asymmetry is deliberate and worth stating: agents READ the jar. A cookie
 * an agent picks up dies with its context unless a person logged in for it.
 * That is the right way round — the account is theirs, and a login worth keeping
 * is one they performed.
 *
 * Measured on the real browser: 324 cookies exported, and two concurrent agents
 * both started warm while navigating entirely independently.
 */

/** A cookie as CDP's `Storage.getCookies` reports it. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch SECONDS, or <= 0 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** A Playwright `--storage-state` file. */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: unknown[];
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

export function cdpCookiesToStorageState(cookies: readonly CdpCookie[]): StorageState {
  return {
    cookies: cookies
      // A nameless cookie is not usable by anything and Playwright rejects the
      // file rather than skipping it.
      .filter((c) => Boolean(c.name))
      .map((c) => ({
        name: c.name,
        value: c.value ?? '',
        domain: c.domain,
        path: c.path || '/',
        // CDP says 0 or negative for "dies with the browser". Passing that
        // through as an epoch makes every session cookie look long expired, and
        // every agent starts logged out — which is the failure this whole file
        // exists to fix, arriving by a different door.
        expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : -1,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        // CDP omits sameSite for plenty of real cookies. Dropping those would
        // silently lose logins; Lax is what a browser assumes anyway.
        sameSite: (SAME_SITE.has(c.sameSite ?? '') ? c.sameSite : 'Lax') as
          | 'Strict'
          | 'Lax'
          | 'None',
      })),
    // Required by Playwright even when empty; the file is rejected without it.
    origins: [],
  };
}

/** A cookie shaped for CDP's `Storage.setCookies`. */
export interface CdpSetCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/**
 * Pours the jar into a browser muxpad has just launched.
 *
 * The opposite direction to {@link cdpCookiesToStorageState}, and the round trip
 * has to survive: a login that exports cleanly and imports as garbage is worse
 * than no jar at all, because the browser then looks warm and behaves cold.
 *
 * Two asymmetries with the export, both load-bearing:
 *
 *   · a SESSION cookie is `-1` in a storage state and is expressed to CDP by
 *     OMITTING expires — sending -1 sets a date in 1969 and the cookie is dead
 *     on arrival;
 *   · an already-expired cookie is dropped rather than sent, so the seeded
 *     count is not a lie about how warm the browser really is.
 */
export function storageStateToCdpCookies(state: StorageState): CdpSetCookie[] {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const out: CdpSetCookie[] = [];
  for (const c of cookies) {
    if (!c?.name || !c.domain) continue;
    const session = typeof c.expires !== 'number' || c.expires <= 0;
    if (!session && (c.expires as number) <= nowSeconds) continue;
    out.push({
      name: c.name,
      value: c.value ?? '',
      domain: c.domain,
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite ?? 'Lax',
      ...(session ? {} : { expires: c.expires as number }),
    });
  }
  return out;
}

/**
 * Export only what this browser changed since its last successful export (or
 * startup). An unchanged cookie is not evidence that a newer login in the jar
 * should be rolled back. Delete only when the jar still has the seed value:
 * another browser may have refreshed that login while this one logged out.
 */
export function mergeCookieChanges(
  jar: StorageState,
  seed: StorageState,
  current: StorageState,
): StorageState {
  const key = (c: StorageState['cookies'][number]) => JSON.stringify([c.domain, c.path, c.name]);
  const before = new Map(seed.cookies.map((c) => [key(c), c]));
  const after = new Map(current.cookies.map((c) => [key(c), c]));
  const merged = new Map(jar.cookies.map((c) => [key(c), c]));
  for (const [id, cookie] of before) {
    if (!after.has(id) && JSON.stringify(merged.get(id)) === JSON.stringify(cookie))
      merged.delete(id);
  }
  for (const [id, cookie] of after) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(cookie)) merged.set(id, cookie);
  }
  return { cookies: [...merged.values()], origins: jar.origins };
}
