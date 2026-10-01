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

/** Videos the agent can share — rendered inline as <video> (in a gallery when
 *  several). Kept browser-playable; .mov is Safari-only but common from macOS. */
export const VIDEO_MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
} as const;

/** Non-visual files the agent can share — rendered as a click-to-open chip. */
export const FILE_MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.html': 'text/html',
  '.zip': 'application/zip',
} as const;

/** Every attachment type the tool accepts, the serve route serves, and the
 *  chat renders — the ONE union, so no leg drifts (same lesson as images). */
export const ATTACHMENT_MIME_BY_EXT = {
  ...IMAGE_MIME_BY_EXT,
  ...VIDEO_MIME_BY_EXT,
  ...FILE_MIME_BY_EXT,
} as const;
export type AttachmentExt = keyof typeof ATTACHMENT_MIME_BY_EXT;
export const ATTACHMENT_EXTENSIONS = Object.keys(ATTACHMENT_MIME_BY_EXT) as AttachmentExt[];
export const ATTACHMENT_EXT_ALTERNATION = ATTACHMENT_EXTENSIONS.map((e) => e.slice(1)).join('|');

/**
 * '.ext' for an accepted attachment mime, or null when nothing here renders it.
 *
 * The attachment-wide sibling of `imageExtForMime`. The composer needs it
 * because a picker hands over a MIME and the upload route keys off the
 * EXTENSION: a provider that reports `application/pdf` for a file named
 * `notes.pdf` and a provider that reports `''` for the same file must both be
 * accepted, and only this pair of lookups covers both.
 */
export function attachmentExtForMime(mime: string): AttachmentExt | null {
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime.toLowerCase();
  for (const [ext, m] of Object.entries(ATTACHMENT_MIME_BY_EXT)) {
    if (m === normalized) return ext as AttachmentExt;
  }
  return null;
}

/**
 * The `accept` attribute for a file input, as an explicit extension list.
 *
 * Extensions rather than `*​/*` on purpose. It is the same list the upload route
 * enforces, so the OS greys out what the server would reject instead of letting
 * someone pick a `.pages` and meet an error afterwards — and on iOS an `accept`
 * that is not image-only is what makes the sheet offer Files and iCloud
 * alongside Photo Library and Take Photo. `image/*` was suppressing that.
 */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.join(',');

export type AttachmentKind = 'image' | 'video' | 'file';
/** Classify a filename/ext into how the chat should render it. */
export function attachmentKind(name: string): AttachmentKind {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext in IMAGE_MIME_BY_EXT) return 'image';
  if (ext in VIDEO_MIME_BY_EXT) return 'video';
  return 'file';
}
/** Serve-route content type for a stored attachment, or null if unsupported. */
export function attachmentMime(name: string): string | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return (ATTACHMENT_MIME_BY_EXT as Record<string, string>)[ext] ?? null;
}
