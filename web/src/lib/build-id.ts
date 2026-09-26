import { buildIdFromEntrySrc } from '@muxpad/shared';

/**
 * WHICH BUILD IS THIS DOCUMENT? — read off the shell that booted it.
 *
 * The server answers the same question from the `index.html` on disk
 * (`GET /api/build`, see server/src/static-assets.ts) using the same parser from
 * @muxpad/shared, so the two sides differ only when the bundle on disk has
 * actually changed.
 *
 * Deliberately NOT `import.meta.url`, which would have needed no DOM read: with
 * code-splitting, the chunk a given module lands in is a rollup decision, so it
 * is not necessarily the ENTRY chunk the shell names — and the entry chunk is
 * what the server can see. Reading the script tag keeps both sides pointed at
 * one field of one file.
 */
export function documentBuildId(doc: Document = document): string | null {
  // `getAttribute`, not `.src`: the raw attribute is byte-for-byte what the
  // server finds in the HTML. (The parser accepts the resolved absolute form
  // too, so this is about keeping the comparison obvious, not about correctness.)
  for (const el of doc.querySelectorAll('script[src]')) {
    const id = buildIdFromEntrySrc(el.getAttribute('src'));
    if (id) return id;
  }
  return null;
}
