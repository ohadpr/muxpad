/**
 * Which clicks in a chat open the in-app link sheet instead of leaving muxpad.
 *
 * A link in a message used to be a plain `target="_blank"`, which in an
 * installed iOS PWA hands the url to the OS: a full-screen browser that is not
 * ours, over the conversation, with an X. The sheet keeps the conversation on
 * screen behind the page — see LinkSheet.
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

export const LINKS_PROFILE = 'links';

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

/** The links viewer, framed: drive mode, claimant named, muxpad's own chrome hidden. */
export function linkSheetViewerPath(by: string): string {
  return `/browser/${LINKS_PROFILE}/?embed=sheet&by=${encodeURIComponent(by)}`;
}

/**
 * Where the reader has been since the sheet opened, for the sheet's Back.
 *
 * Kept HERE rather than asked of the browser, because the links browser is one
 * browser for every link: its own history runs back through every link you
 * ever opened, and Back in a sheet should stop at the page you tapped.
 *
 * The first page heard REPLACES rather than extends — the link you tapped may
 * land somewhere else (a shortener, a redirect), and that is not somewhere to
 * go back to. A page that is the one before the current one is a Back, so the
 * trail shrinks; anything else is a step forward.
 */
export function followTrail(trail: readonly string[], url: string): readonly string[] {
  if (trail.length === 0) return [url];
  if (trail[trail.length - 1] === url) return trail;
  if (trail.length > 1 && trail[trail.length - 2] === url) return trail.slice(0, -1);
  return [...trail, url];
}
