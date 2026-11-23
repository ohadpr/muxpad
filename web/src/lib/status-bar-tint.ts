/**
 * THE iPHONE STATUS BAR'S COLOUR, kept in step with the theme.
 *
 * ─── WHY THIS EXISTS AT ALL: iOS 26 LIQUID GLASS ────────────────────────────
 * The installed home-screen app used to declare
 * `apple-mobile-web-app-status-bar-style: black-translucent`, which runs the
 * page UNDER the status bar — which is why `.app-layout` reserves
 * `env(safe-area-inset-top)`.
 *
 * On iOS 26 that style also earns a Liquid Glass blur about 40pt deep, drawn
 * by the SYSTEM over the top of the page, and no CSS turns it off. Reported
 * with a photograph: the chat header's grey went frosted, the rows behind it
 * bled through, and the system drew its own rounded container around the
 * settings gear. Nothing in our stylesheets could have caused it and nothing
 * in them could have stopped it.
 *
 * Dropping the meta gives the DEFAULT style: the page starts below an OPAQUE
 * status bar, and that bar is tinted by `theme-color`. Which is why this file
 * exists — a single fixed `theme-color` was fine when the app had one dark
 * palette, and is wrong the moment eleven themes can be in force. A cream
 * paper app under a `#1e1e2e` bar reads as a rendering fault.
 *
 * ─── WHAT COLOUR, AND WHY `--bg-chrome` ─────────────────────────────────────
 * The status bar sits directly above the app's own top bar — the chat header
 * on a phone, the muxpad header on the list — so the colour that makes the
 * seam disappear is the CHROME's, not the page's. `--bg` is the fallback for a
 * theme that does not set one; black is the last resort and should never be
 * reached.
 *
 * ─── IT ONLY TAKES EFFECT ON RE-ADD ─────────────────────────────────────────
 * iOS reads the status-bar style when the app is ADDED to the home screen. An
 * existing install keeps the style it was installed with, blur and all, until
 * it is removed and added again. That is Apple's behaviour, not something this
 * code can route around, and it is the one part of this fix a person has to do.
 */

/** Resolve a CSS custom property to something `theme-color` accepts. */
function tint(): string {
  const cs = getComputedStyle(document.documentElement);
  const chrome = cs.getPropertyValue('--bg-chrome').trim();
  if (chrome) return chrome;
  const bg = cs.getPropertyValue('--bg').trim();
  return bg || '#000000';
}

/**
 * Point `<meta name="theme-color">` at the theme in force.
 *
 * Called from the one place the theme lands on the document, so the two cannot
 * drift. Creates the tag when the document has none — the meta is in
 * index.html, but a test fixture mounting this module is not obliged to carry
 * the whole head.
 */
export function syncStatusBarTint(): void {
  if (typeof document === 'undefined') return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  const next = tint();
  // A no-op write still invalidates the tag in some engines; this is called on
  // every theme application, including the ones that change nothing.
  if (meta.content !== next) meta.content = next;
}
