/**
 * WHAT A LINK ON A COMPLETION CARD SAYS.
 *
 * A worker's artifacts used to render as the raw string — `pub.example.org/
 * trayo-plan-card-demo/` in a monospace line under the summary — and the
 * summary ALSO spelled the url out, because the report prompt asks for it. So
 * one card carried the same url twice, once in prose where it ate most of a
 * two-line budget and clipped the sentence:
 *
 *   "Refined Variant A of the Trayo plan card, now live at
 *    https://pub.example.org/trayo-plan-card-demo/, with three …"
 *
 * The ask: "if there's a link include it… with just words that are <a> linked
 * and not spelling out the actual link." So the prose stops naming urls (see
 * the report prompt in server/src/chat/spawn-report.ts) and this turns the url
 * into the words it is already made of. The full string stays in `title`, where
 * it costs nothing.
 *
 * It also kills a bidi bug the raw form had. The link box used `direction: rtl`
 * so the ELLIPSIS would eat the origin rather than the identifying tail — and a
 * url ending in neutral characters then had them reordered to the front of the
 * line: a published page scraped with its markdown bold still attached (two
 * asterisks after the trailing slash) rendered with that punctuation moved to
 * the START of the label, in front of the host. Words
 * truncate from the right like every other label here, so the hack goes.
 */

/** When everything else has nothing to say. Reached only for an empty string,
 *  which the scraper never produces — a total function, not a real case. */
const LAST_RESORT = 'link';

/** A segment too thin to identify anything on its own: `43`, `v2`, `#`. */
function thin(seg: string): boolean {
  return seg.length < 3 || /^\d+$/.test(seg);
}

/** `trayo-plan-card-demo` → `trayo plan card demo`, but `todos.md` is a
 *  FILENAME and stays one. A dot means the segment names a file, and a file's
 *  name is the thing you would search for. */
function words(seg: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  })();
  if (decoded.includes('.')) return decoded;
  return decoded.replace(/[-_]+/g, ' ').trim() || decoded;
}

/**
 * The words a card shows for one artifact. Never empty — a label nobody can
 * read is worse than the url it replaced, so every fallback ends somewhere.
 */
export function artifactLabel(artifact: string): string {
  const raw = artifact.trim();
  if (!raw) return LAST_RESORT;
  if (!/^https?:\/\//i.test(raw)) {
    // A local path: the BASENAME. The directories are where it is, which is not
    // what you are looking at a card to learn, and a path is not pressable here
    // anyway (nothing in a browser can open it).
    const base = raw.split('/').filter(Boolean).pop();
    return base && base.length > 0 ? base : raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return url.hostname.replace(/^www\./, '');
  // A LAST SEGMENT CAN BE MEANINGLESS ON ITS OWN. `…/muxpad/pull/43` is "43",
  // which identifies nothing; the segment before it is what makes it a pull
  // request. Walk left until the label carries a word.
  // ONE step left, never two: a label three segments long is a path again, and
  // the point of this function is that it is not one.
  const parts = [segs[segs.length - 1] as string];
  if (segs.length > 1 && thin(parts[0] as string)) parts.unshift(segs[segs.length - 2] as string);
  const label = parts.map(words).join(' / ');
  return label.length > 0 ? label : url.hostname.replace(/^www\./, '');
}
