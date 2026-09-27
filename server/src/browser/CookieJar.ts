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
