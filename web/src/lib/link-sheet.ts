/**
 * Which clicks in a chat open the in-app link sheet instead of leaving muxpad.
 *
 * A link in a message is a plain `target="_blank"`, which in an installed iOS
 * PWA hands the url to the OS's in-app browser. When the page can be framed it
 * opens in a sheet over the conversation instead, so the chat stays on screen
 * behind it — see LinkSheet. When it cannot, the click is left ALONE and the
 * OS browser opens it, from inside the tap, where no popup blocker objects.
 *
 * Deliberately NARROW. Only a link in rendered message text (`.chat-md`), only
 * an absolute http(s) url on another origin, only a plain primary click:
 *
 *  - a cmd/ctrl/shift/alt click or a middle click is somebody ASKING for a new
 *    tab or window, and gets exactly that;
 *  - a same-origin link is muxpad's own (an attachment, a viewer), and loading
 *    muxpad inside a browser inside muxpad is never what was meant;
 *  - `[data-native-link]` opts an anchor out — the sheet's own "open in
 *    browser" sits inside the chat pane's tree and must not reopen the sheet.
 */

export interface LinkClick {
  target: EventTarget | null;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export function sheetLinkFor(ev: LinkClick, origin: string): string | null {
  if (ev.defaultPrevented || ev.button !== 0) return null;
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
  const el = ev.target as Element | null;
  const anchor = el && typeof el.closest === 'function' ? el.closest('a[href]') : null;
  if (!anchor || anchor.hasAttribute('download')) return null;
  if (!anchor.closest('.chat-md') || anchor.closest('[data-native-link]')) return null;
  let url: URL;
  try {
    url = new URL(anchor.getAttribute('href') ?? '', origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === origin) return null;
  return url.href;
}

/** What the sheet's bar says: the site, not the whole address. */
export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Where a link goes: the sheet (an iframe over the chat) or the OS browser.
 *
 * Decided SYNCHRONOUSLY, inside the click, because only a click may open a new
 * browser window — so this uses only what is already known:
 *
 *  - an http page on an https muxpad is mixed content and never loads in a
 *    frame, so it goes straight to the OS;
 *  - a site already checked and found unframeable goes straight to the OS;
 *  - everything else opens the sheet, which asks the server (frameVerdict) and
 *    hands over to the OS itself if the answer is no.
 */
export function linkRoute(url: string, pageOrigin: string): 'sheet' | 'native' {
  let target: URL;
  let page: URL;
  try {
    target = new URL(url);
    page = new URL(pageOrigin);
  } catch {
    return 'native';
  }
  if (page.protocol === 'https:' && target.protocol !== 'https:') return 'native';
  if (verdicts.get(target.origin) === false) return 'native';
  return 'sheet';
}

/** Framability per site origin, as the server last answered it. */
const verdicts = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean>>();

/**
 * Whether `url` may be shown in an iframe on this page — the server reads the
 * site's X-Frame-Options and CSP frame-ancestors. Any failure is a no.
 */
export function checkFrame(
  url: string,
  pageOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return Promise.resolve(false);
  }
  const known = verdicts.get(origin);
  if (known !== undefined) return Promise.resolve(known);
  const pending = inflight.get(origin);
  if (pending) return pending;
  const q = `url=${encodeURIComponent(url)}&parent=${encodeURIComponent(pageOrigin)}`;
  const ask = (async () => {
    try {
      const res = await fetchImpl(`/api/open/frame?${q}`);
      const body = (await res.json()) as { frame?: unknown };
      const frame = res.ok && body.frame === true;
      verdicts.set(origin, frame);
      return frame;
    } catch {
      return false;
    } finally {
      inflight.delete(origin);
    }
  })();
  inflight.set(origin, ask);
  return ask;
}

/** Record that a site turned out not to frame (its iframe never loaded). */
export function markUnframeable(url: string): void {
  try {
    verdicts.set(new URL(url).origin, false);
  } catch {
    /* not a url */
  }
}

/** Tests only. */
export function resetFrameVerdicts(): void {
  verdicts.clear();
  inflight.clear();
}
