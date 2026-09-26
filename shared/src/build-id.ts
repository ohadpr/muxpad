/**
 * WHICH BUILD IS THIS? — one identifier, read off the same field of the same
 * file by both halves of the app.
 *
 * The problem it exists for: an installed iOS PWA resumed from the app switcher
 * never re-navigates. It restores the document it already had, so a deploy
 * reaches it only when the user force-quits — no cache header can help, because
 * no request is ever made. (muxpad's caching is not the gap: the shell is
 * `no-cache` + ETag and the hashed assets are `immutable`; see
 * server/src/static-assets.ts. The service worker caches nothing at all.) The
 * client therefore has to ASK, and to ask it needs something to compare.
 *
 * ── THE IDENTIFIER IS THE ENTRY CHUNK'S FILENAME ─────────────────────────────
 * Not a version scheme, not a build step. Vite already writes a content hash
 * into the entry chunk's name and the shell already names it:
 *
 *     <script type="module" crossorigin src="/assets/index-Cgp7p3nE.js">
 *
 * The SERVER reads that line out of the `index.html` on disk; the CLIENT reads
 * it out of the document it was loaded with. Same field, same file — so the two
 * sides cannot drift apart through a bug in how the id is derived, only through
 * the one difference that matters (a deploy).
 *
 * ── WHY `/assets/` IS THE WHOLE TEST ─────────────────────────────────────────
 * A src outside `/assets/` means "not a built bundle". That is exactly the dev
 * server, where the shell names `/src/main.tsx` — a stable name that would
 * otherwise compare unequal against the server's hashed `dist/` shell and show
 * a "new version" prompt on every single visibility flip while you develop.
 * Returning null there makes the feature inert rather than wrong.
 *
 * The hash itself is deliberately NOT validated. If someone ever configures
 * Vite to emit unhashed asset names, this keeps returning a constant id — so
 * the check never fires, the user is never prompted, and the failure is a
 * missing feature rather than a phantom update on every resume. Every way this
 * can go wrong should point that direction: a prompt the user cannot make go
 * away is worse than no prompt. (The immutability rule in static-assets.ts DOES
 * insist on a visible hash, for the opposite reason: there, a wrong answer pins
 * a mutable name for a year.)
 */

/** Where Vite writes its content-hashed output. Must match static-assets.ts. */
const HASHED_PREFIX = '/assets/';

/**
 * The build identifier named by a script tag's `src`, or null if that src is
 * not a built bundle entry.
 *
 * Accepts both spellings the two callers have: the root-relative attribute as
 * authored (`/assets/index-Cgp7p3nE.js`, what the server finds in the HTML and
 * what `getAttribute('src')` returns) and a fully-resolved absolute URL
 * (`https://host/assets/index-Cgp7p3nE.js`, what the DOM's `.src` property
 * returns). Query strings and fragments are dropped — they are not part of the
 * build's identity.
 */
export function buildIdFromEntrySrc(src: string | null | undefined): string | null {
  if (!src) return null;
  let path: string;
  try {
    // A base is required for the relative spelling and ignored for the absolute
    // one. The hostname is never read.
    path = new URL(src, 'http://muxpad.invalid').pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(HASHED_PREFIX)) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name || null;
}

/**
 * The build identifier named by an HTML shell, or null if it names none.
 *
 * Scans every script `src` rather than pattern-matching one tag shape:
 * `buildIdFromEntrySrc` is the arbiter of what counts, and the first src that
 * satisfies it is the entry chunk. Attribute order (`type`, `crossorigin`) is
 * then something Vite is free to change without breaking this.
 */
export function buildIdFromHtml(html: string): string | null {
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)) {
    const id = buildIdFromEntrySrc(m[1]);
    if (id) return id;
  }
  return null;
}
