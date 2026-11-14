/**
 * THE COCKPIT, INSIDE SOMEBODY ELSE'S APP.
 *
 * The apps on this machine — Home, Rapaport, Notes — are each built by a
 * muxpad chat, and the useful place to talk to that chat is the app itself:
 * "this will allow me to make changes to the apps from within the apps". So
 * each app gets a tab holding an iframe of its own chat.
 *
 * ── WHY A SEARCH PARAM AND NOT A ROUTE ───────────────────────────────────
 *
 * The embed is the SAME chat at the SAME url with the chrome off. Making it
 * a route would mean a second surface that mounts the chat, and the two would
 * drift the way every duplicated surface in this codebase has: the embed
 * would miss whatever the real one gained. `?embed=1` on the url you are
 * already looking at is the whole feature, and the thing you paste into an
 * app is a url you can also open yourself to check.
 *
 * ── WHY IT IS READ ONCE, AT BOOT ─────────────────────────────────────────
 *
 * The tab route validates its search params and drops the ones it does not
 * know, so `embed` would not survive the first internal navigation — and an
 * iframe that grew a sidebar when you clicked something inside it would be
 * worse than one that never had the mode at all. An embed also never stops
 * being an embed: the document was loaded that way. So it is a property of
 * the DOCUMENT, latched at boot, not a prop threaded through the router.
 */

/** Does this url ask for the chrome-less view? Pure, so it can be tested. */
export function embedRequested(search: string): boolean {
  return new URLSearchParams(search).get('embed') === '1';
}

let latched: boolean | undefined;

/** Was THIS document loaded as an embed? Latched on first read — see above. */
export function isEmbedded(): boolean {
  if (latched === undefined)
    latched = typeof window !== 'undefined' && embedRequested(window.location.search);
  return latched;
}

/**
 * Which chrome the shell shows, as a decision rather than two expressions
 * buried in a component that nothing can mount without a router, a settings
 * provider and a tab list.
 *
 *   · the SIDEBAR is desktop-only, and never in an embed — inside somebody
 *     else's app the surrounding product IS the navigation, and muxpad's
 *     whole cockpit in a 600px iframe would compete with the app that framed
 *     it;
 *   · the TOP BAR normally appears exactly when the sidebar is not absorbing
 *     it, which means turning the sidebar off would bring the bar BACK —
 *     brand, build number, settings menu — which is the opposite of what the
 *     mode is for. So the embed is checked on both.
 */
export function shellChrome(view: {
  isMobile: boolean;
  inWorkspace: boolean;
  embedded: boolean;
}): { sidebar: boolean; topBar: boolean } {
  const sidebar = !view.isMobile && !view.embedded;
  return { sidebar, topBar: !(sidebar && view.inWorkspace) && !view.embedded };
}
