// Attachment FILES by bare name — the one guard on a name that came off a
// wire, and the one reader that hands a stored attachment to a runner on
// another machine.
//
// Two callers take an attachment name from somebody else: the HTTP serve route
// (`GET /attachments/:name`, any browser) and the runner socket (`attachment`
// frames, a runner that may be on a remote host). Both must refuse exactly the
// same names, so the rule lives here once.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { attachmentMime } from '@muxpad/shared';

/**
 * A name is safe when it is a bare filename (no directory part, so no
 * traversal), has no NUL, and carries a known attachment extension.
 *
 * Returns the reason it is not, or null when it is fine — the serve route turns
 * the reason into its 400, the runner socket into its refusal frame.
 */
export function attachmentNameProblem(name: unknown): 'bad name' | 'unsupported type' | null {
  if (typeof name !== 'string' || !name || name !== basename(name) || name.includes('\0'))
    return 'bad name';
  // `basename` leaves `..` and `.` alone; neither is a file in a flat dir.
  if (name === '.' || name === '..') return 'bad name';
  if (!attachmentMime(name)) return 'unsupported type';
  return null;
}

/**
 * The most a runner may pull over its socket in one attachment: 25 MB.
 *
 * Uploads go to 512 MB, but a ws frame is not where those belong. The bytes
 * travel base64 (+33%) inside one JSON frame, and for a remote pane that frame
 * rides the host link the pane's terminal output shares — 25 MB is every
 * screenshot, PDF and short screen recording there is, and a stall of a few
 * seconds at worst. Anything bigger is refused with a reason the agent can
 * read out, never dropped silently.
 */
export const ATTACHMENT_RELAY_MAX_BYTES = 25 * 1024 * 1024;

export type AttachmentRead =
  | { ok: true; b64: string; size: number }
  | { ok: false; reason: string };

/** Read `<dataDir>/attachments/<name>` for a runner that asked for it. */
export function readAttachmentForRelay(
  dataDir: string,
  name: unknown,
  maxBytes = ATTACHMENT_RELAY_MAX_BYTES,
): AttachmentRead {
  const problem = attachmentNameProblem(name);
  if (problem) return { ok: false, reason: problem };
  const path = join(dataDir, 'attachments', name as string);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, reason: 'not found' };
    size = st.size;
  } catch {
    return { ok: false, reason: 'not found' };
  }
  // Refuse BEFORE reading: the stat is the only figure available up front.
  if (size > maxBytes)
    return {
      ok: false,
      reason: `too large to transfer (${Math.ceil(size / 1e6)} MB; the limit is ${Math.floor(maxBytes / 1e6)} MB)`,
    };
  // Read at most the size we stat'd (plus one byte to notice growth), so a file
  // that grows between stat and read still cannot exceed the ceiling.
  const buf = Buffer.alloc(size + 1);
  let n = 0;
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
      if (n === buf.length) return { ok: false, reason: 'changed while being read' };
    }
  } finally {
    closeSync(fd);
  }
  return { ok: true, b64: buf.subarray(0, n).toString('base64'), size: n };
}
