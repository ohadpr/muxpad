/**
 * MAY THIS LINK BE SHOWN IN AN <iframe> INSIDE MUXPAD?
 *
 * A link tapped in a chat opens in a sheet over the conversation when the page
 * can be framed, and in the platform's own browser when it cannot. The browser
 * gives the page no way to ask — a refused frame is just a blank rectangle, and
 * its `load` event fires all the same — so the server reads the two headers that
 * decide it, X-Frame-Options and CSP `frame-ancestors`, and answers yes or no.
 *
 * EVERY DOUBT IS A NO. A no costs one hop to a real browser; a wrong yes is a
 * blank sheet, which is the bug this replaced. So a timeout, an error, a status
 * that is not 2xx, an http page (mixed content under muxpad's https), a header
 * this cannot parse — all of them are "use the OS browser".
 */

export interface FrameVerdict {
  frame: boolean;
  /** Why, in a few words — for logs and tests, not for the screen. */
  reason: string;
}

/**
 * Whether `parentOrigin` may frame a page that answered with these headers.
 * Pure: the network half is {@link LinkFrameChecker}.
 */
export function frameVerdict(
  headers: { get(name: string): string | null },
  parentOrigin: string,
): FrameVerdict {
  // frame-ancestors, when ANY policy sets it, replaces X-Frame-Options (CSP3).
  // Several policies can arrive comma-joined in one header; all of them apply.
  const csp = headers.get('content-security-policy');
  if (csp) {
    const lists = csp
      .split(',')
      .map((policy) =>
        policy
          .split(';')
          .map((d) => d.trim().split(/\s+/))
          .find(([name]) => name?.toLowerCase() === 'frame-ancestors'),
      )
      .filter((d): d is string[] => d !== undefined)
      .map((d) => d.slice(1));
    if (lists.length > 0) {
      for (const sources of lists) {
        if (!sources.some((s) => sourceAllows(s, parentOrigin)))
          return { frame: false, reason: `frame-ancestors ${sources.join(' ') || "'none'"}` };
      }
      return { frame: true, reason: 'frame-ancestors allows it' };
    }
  }
  const xfo = headers.get('x-frame-options');
  // DENY and SAMEORIGIN both refuse us (we are never the page's origin), and
  // ALLOW-FROM is obsolete and ignored inconsistently — a doubt, so a no.
  if (xfo?.trim()) return { frame: false, reason: `x-frame-options ${xfo.trim()}` };
  return { frame: true, reason: 'no framing headers' };
}

/** One frame-ancestors source expression against the framing origin. */
function sourceAllows(source: string, parentOrigin: string): boolean {
  const s = source.toLowerCase();
  if (s === '*') return true;
  if (s === "'none'" || s === "'self'") return false;
  let parent: URL;
  try {
    parent = new URL(parentOrigin);
  } catch {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return s === parent.protocol;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^:/]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(s);
  if (!m) return false;
  const [, scheme, wild, host, port] = m;
  if (scheme && `${scheme}:` !== parent.protocol) return false;
  if (!scheme && parent.protocol !== 'https:' && parent.protocol !== 'http:') return false;
  const ph = parent.hostname.toLowerCase();
  if (wild ? !ph.endsWith(`.${host}`) : ph !== host) return false;
  if (port === '*') return true;
  const defaultPort = parent.protocol === 'https:' ? '443' : '80';
  return (port ?? defaultPort) === (parent.port || defaultPort);
}

export interface LinkFrameCheckerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * The network half, cached per (origin, parent) — sites set these headers
 * site-wide, and a second tap on the same site should not wait on the network.
 */
export class LinkFrameChecker {
  private readonly cache = new Map<string, { at: number; verdict: FrameVerdict }>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: LinkFrameCheckerOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async check(rawUrl: string, parentOrigin: string): Promise<FrameVerdict> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { frame: false, reason: 'not a url' };
    }
    // Mixed content: an http page never loads in a frame on an https muxpad.
    if (url.protocol !== 'https:') return { frame: false, reason: 'not https' };
    const key = `${url.origin} ${parentOrigin}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.verdict;
    const verdict = await this.probe(url, parentOrigin);
    this.cache.set(key, { at: this.now(), verdict });
    return verdict;
  }

  private async probe(url: URL, parentOrigin: string): Promise<FrameVerdict> {
    try {
      // GET, not HEAD: plenty of servers answer HEAD differently or not at all.
      // Only the headers are read; the body is cancelled unread.
      const res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      void res.body?.cancel().catch(() => {});
      // A redirect down to http is mixed content again.
      if (res.url && new URL(res.url).protocol !== 'https:')
        return { frame: false, reason: 'redirects to http' };
      if (!res.ok) return { frame: false, reason: `status ${res.status}` };
      return frameVerdict(res.headers, parentOrigin);
    } catch (err) {
      return { frame: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
