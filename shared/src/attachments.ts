/**
 * The ONE list of image formats the attachment pipeline accepts, renders,
 * and serves. Four code sites previously each spelled their own subset
 * (clipboard accept, upload extension mapping, thumbnail path regex, serve
 * allowlist) and had already drifted — a pasted AVIF uploaded fine but
 * could never render and 400'd on fetch. Every leg derives from this map.
 */
export const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
} as const;

export type ImageExt = keyof typeof IMAGE_MIME_BY_EXT;

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXT) as ImageExt[];

/** '.ext' for an accepted image mime, or null when the pipeline can't render it. */
export function imageExtForMime(mime: string): ImageExt | null {
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime.toLowerCase();
  for (const [ext, m] of Object.entries(IMAGE_MIME_BY_EXT)) {
    if (m === normalized) return ext as ImageExt;
  }
  return null;
}

/** Alternation body ('png|jpg|jpeg|…') for building path-matching regexes. */
export const IMAGE_EXT_ALTERNATION = IMAGE_EXTENSIONS.map((e) => e.slice(1)).join('|');
