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
 * ─── WHAT COLOUR: WHATEVER THE TOP BAR ACTUALLY PAINTED ─────────────────────
 * The status bar sits directly above the app's own top bar — the chat header
 * on a phone, the muxpad header on the list — so the colour that makes the
 * seam disappear is that bar's.
 *
 * It read `--bg-chrome`, which was the same thing until it wasn't: the chat
 * header moved onto the list's ground so the two views would stop looking like
 * separate products, and on the light themes that left a pale strip above a
 * now-dark header. Reported by the agent that made the move, which is the
 * right way round — it changed the bar and could see what the tint assumed.
 *
 * So this MEASURES rather than guesses. Whatever either header computes to is
 * the answer, which survives the next palette change without anybody
 * remembering this file exists. The tokens remain as fallbacks for the moment
 * before a header is mounted (the first paint, a test fixture): `--bg-chrome`,
 * then `--bg`, then black, which should never be reached.
 *
 * ─── IT ONLY TAKES EFFECT ON RE-ADD ─────────────────────────────────────────
 * iOS reads the status-bar style when the app is ADDED to the home screen. An
 * existing install keeps the style it was installed with, blur and all, until
 * it is removed and added again. That is Apple's behaviour, not something this
 * code can route around, and it is the one part of this fix a person has to do.
 */

/** The two bars that can sit under the status bar on a phone: the list's
 *  header and a chat's. Only one is ever mounted. */
const TOP_BARS = '.mcl-head, .mobile-chat-head';

/** Is this a real colour, or the transparent default? A transparent header
 *  tells us nothing — keep walking up for the surface actually painted. */
const PAINTED = (c: string): boolean => !!c && c !== 'transparent' && !/,\s*0\s*\)$/.test(c);

/**
 * `rgb(224, 224, 224)` → `#e0e0e0`.
 *
 * ALWAYS HEX, because iOS is the consumer. `getComputedStyle` hands back an
 * `rgb()` string and the meta used to carry a hex token; the switch to
 * measuring quietly changed the FORMAT as well as the value, and the glass
 * came back on the next launch — an unparsed `theme-color` is no
 * `theme-color`, and a standalone app with none gets the system's own
 * treatment. Anything this cannot convert is passed through rather than
 * dropped: a colour we do not recognise is still better than none.
 */
function toHex(colour: string): string {
  const m = colour.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return colour;
  const parts = (m[1] as string)
    .split(/[,\s/]+/)
    .filter(Boolean)
    .slice(0, 3);
  if (parts.length < 3) return colour;
  const hex = parts.map((p) => {
    const n = Math.max(0, Math.min(255, Math.round(Number(p))));
    return Number.isFinite(n) ? n.toString(16).padStart(2, '0') : '00';
  });
  return `#${hex.join('')}`;
}

function tint(): { colour: string; measured: boolean } {
  const bar = document.querySelector(TOP_BARS);
  for (let el: Element | null = bar; el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (PAINTED(c)) return { colour: toHex(c), measured: true };
  }
  // No header mounted yet — first paint, or a fixture. Fall back to the
  // tokens, in the order of how close each sits to the bar.
  const cs = getComputedStyle(document.documentElement);
  const chrome = cs.getPropertyValue('--bg-chrome').trim();
  if (chrome) return { colour: chrome, measured: false };
  const bg = cs.getPropertyValue('--bg').trim();
  return { colour: bg || '#000000', measured: false };
}

/**
 * THE FALLBACK HAS TO BE TEMPORARY, and it was not.
 *
 * This module's first call happens when settings.ts applies the theme — which
 * is at IMPORT time, before React has mounted anything. So a cold start always
 * took the `--bg-chrome` branch above, and nothing ever measured again: a
 * boot theme that matches what is stored changes nothing, so no theme
 * application follows. On a light theme that left exactly the pale strip this
 * work existed to remove. Found by review.
 *
 * One shot, and it disarms itself: watch for the header appearing, measure it
 * once, stop. Cheaper than a rAF loop and it cannot outlive its purpose.
 */
let waitingForBar: MutationObserver | null = null;

function disarm(): void {
  waitingForBar?.disconnect();
  waitingForBar = null;
}

function remeasureWhenTheBarArrives(): void {
  if (waitingForBar || typeof MutationObserver === 'undefined') return;
  const target = document.body ?? document.documentElement;
  if (!target) return;
  waitingForBar = new MutationObserver(() => {
    if (!document.querySelector(TOP_BARS)) return;
    disarm();
    syncStatusBarTint();
  });
  waitingForBar.observe(target, { childList: true, subtree: true });
}

/**
 * Point `<meta name="theme-color">` at the theme in force.
 *
 * Called from the one place the theme lands on the document, so the two cannot
 * drift.
 *
 * WHICH MEANS IT RE-READS ON A THEME CHANGE AND NOT ON NAVIGATION, and that is
 * only correct while the two headers agree. They do, deliberately — the chat's
 * bar was moved onto the list's chrome so the two views stop reading as
 * separate products, and `themes.test.ts` pins their colours as identical. If
 * that ever stops being true, this needs to run on navigation too, and the
 * symptom will be a status bar wearing the colour of the view you were last
 * in. Creates the tag when the document has none — the meta is in
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
  const { colour, measured } = tint();
  // A no-op write still invalidates the tag in some engines; this is called on
  // every theme application, including the ones that change nothing.
  if (meta.content !== colour) meta.content = colour;
  if (measured) disarm();
  else remeasureWhenTheBarArrives();
}

/** Test seam — forget the one-shot observer. */
export function __resetStatusBarTint(): void {
  disarm();
}
