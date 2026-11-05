import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

/**
 * SENDING A PATH UP THE LINK, for `muxpad publish` in a remote chat.
 *
 * Publishing is the one in-pane verb whose payload is bytes rather than a
 * sentence: the public server streams artifacts from the server's own disk
 * behind the single tunnel, and the file is on the host. So the server asks
 * for a path and the host reads it here.
 *
 * ── THE SERVER PULLS; THE HOST NEVER PUSHES ──────────────────────────────
 * This only ever runs in response to a `files/fetch` the SERVER sent, naming
 * a path a publish asked for. A host cannot start a transfer, which is what
 * keeps "a host may publish its own artifact" from becoming "a host may write
 * files on the mac".
 *
 * ── WHY THERE IS NO tar ──────────────────────────────────────────────────
 * Spawning one would mean a shell, an archive format and a flag set to be
 * right about, and the unpack side would then be parsing an archive a possibly
 * compromised host composed. A list of (relative path, bytes) is a format with
 * no features: nothing in it can describe a symlink, a device, a hard link, an
 * absolute destination or a permission bit, so none of those has to be
 * defended against on arrival.
 */

/** Artifacts are small by design — this is the "something is wrong" line. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 4000;
/** One frame's worth. Base64 inflates by 4/3, so a frame stays under ~350KB. */
export const CHUNK_BYTES = 256 * 1024;

export interface FileSink {
  chunk: (rel: string, b64: string, last: boolean) => void;
  done: (kind: 'file' | 'dir', name: string) => void;
  error: (reason: string) => void;
}

/**
 * Stream `path` into `sink`.
 *
 * Resolves when everything is sent or an error has been reported — it never
 * rejects, because the caller is a link message handler and the only useful
 * thing to do with a failure here is tell the far side, which it has already
 * done.
 */
export async function sendPath(path: string, sink: FileSink): Promise<void> {
  const root = resolve(path);
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(root);
  } catch {
    sink.error(`no such path: ${root}`);
    return;
  }
  // A symlink AT THE ROOT is the path the user named, so follow it — that is
  // an explicit act. Symlinks found INSIDE a tree are skipped (see walk):
  // there, following is how a publish of a project directory quietly ships
  // whatever `node_modules/.bin/*` points at.
  if (st.isSymbolicLink()) {
    try {
      st = await lstat(await realpath(root));
    } catch {
      sink.error(`cannot follow: ${root}`);
      return;
    }
  }
  try {
    if (st.isFile()) {
      // `rel: ''` is what tells the server this is a FILE publish, which
      // behaves differently at the far end (a lone .html becomes the slug's
      // index.html; anything else keeps its name and gets a listing).
      await sendOne(root, '', sink);
      sink.done('file', basename(root));
      return;
    }
    if (!st.isDirectory()) {
      sink.error('not a file or directory');
      return;
    }
    let bytes = 0;
    let files = 0;
    for await (const entry of walk(root)) {
      files += 1;
      if (files > MAX_FILES) {
        sink.error(`too many files (> ${MAX_FILES})`);
        return;
      }
      bytes += entry.size;
      if (bytes > MAX_TOTAL_BYTES) {
        sink.error(`too large (> ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB)`);
        return;
      }
      await sendOne(entry.abs, relative(root, entry.abs), sink);
    }
    sink.done('dir', basename(root));
  } catch (e) {
    sink.error((e as Error).message);
  }
}

/**
 * Read one file in chunks, then close it with an empty `last`.
 *
 * The terminator is sent unconditionally — including for an EMPTY file, which
 * streams no chunks at all and would otherwise never be created at the far
 * end. Making the close its own frame rather than a flag on the final data
 * chunk is what keeps that case from needing its own branch on both sides.
 */
async function sendOne(abs: string, rel: string, sink: FileSink): Promise<void> {
  const stream = createReadStream(abs, { highWaterMark: CHUNK_BYTES });
  for await (const buf of stream) {
    sink.chunk(rel, (buf as Buffer).toString('base64'), false);
  }
  sink.chunk(rel, '', true);
}

/**
 * Every FILE under `dir`, depth first.
 *
 * Symlinks are skipped, not followed: a publish of a project directory would
 * otherwise ship whatever its links point at, and a cycle would never finish.
 * Sockets, fifos and devices are skipped for the same reason they are not in
 * the wire format — an artifact is files.
 */
async function* walk(dir: string): AsyncGenerator<{ abs: string; size: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      yield* walk(abs);
      continue;
    }
    if (!e.isFile()) continue;
    const st = await lstat(abs);
    yield { abs, size: st.size };
  }
}
